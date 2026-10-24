#!/usr/bin/env node
'use strict';

// Sapproval access service client (server/erisim on Sapproval Labs' server). Customer users without a
// GitHub account activate a PC once with a setup code; after that this PC:
//   - gives git a one-hour token for Sapproval repositories (git credential helper, scoped to
//     https://github.com/sapproval-labs only; other GitHub repositories are not touched),
//   - asks the service whether this PC and person are still allowed (lib/access.js).
// Self-contained on purpose (no other plugin modules): install.ps1 embeds this file to activate a PC
// before the plugin is installed, and ~/.sapproval/runtime/erisim.js is what git runs.
//   node erisim.js activate <code>      register this PC
//   node erisim.js credential get       git credential helper (reads git's request on stdin)
//   node erisim.js status               print this PC's access state
//   node erisim.js deactivate           forget the device key and remove the git setting

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// The service's address; its certificate is a normal public one (Let's Encrypt), checked against Node's
// trusted CAs and the host name.
const SERVER = 'https://erisim.sapproval.com';
const ORG_URL = 'https://github.com/sapproval-labs';

const HOME_DIR = path.join(os.homedir(), '.sapproval');
const STATE_FILE = path.join(HOME_DIR, 'cihaz.json');
const RUNTIME_COPY = path.join(HOME_DIR, 'runtime', 'erisim.js');

// Tests point the client at a local plain-HTTP service; anything else must be the HTTPS service above.
function serverUrl() {
  const env = process.env.SAPPROVAL_ERISIM_URL;
  if (env && /^http:\/\/127\.0\.0\.1:\d+$/.test(env)) return env;
  return SERVER;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}
const isActivated = () => !!readState()?.deviceId;

function writeState(s) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

// bearer: Sapproval Labs' admin key (tools/lib/admin.js); sign: this PC's device state.
function request(method, p, body, { sign = null, bearer = null, timeout = 15000 } = {}) {
  const base = new URL(serverUrl());
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'User-Agent': 'sapproval' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (sign) {
    const time = String(Date.now());
    const msg = `${method}\n${p}\n${time}\n${crypto.createHash('sha256').update(raw).digest('hex')}`;
    headers['X-Sapproval-Device'] = sign.deviceId;
    headers['X-Sapproval-Time'] = time;
    headers['X-Sapproval-Signature'] = crypto.sign(null, Buffer.from(msg), crypto.createPrivateKey(sign.privateKey)).toString('base64');
  }
  const mod = base.protocol === 'https:' ? require('https') : require('http');
  const opts = { method, host: base.hostname, port: base.port || (base.protocol === 'https:' ? 443 : 80), path: p, headers, timeout };
  if (base.protocol === 'https:') opts.rejectUnauthorized = true;
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 200) }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(Object.assign(new Error(json.error || `HTTP ${res.statusCode}`), { status: res.statusCode, code: json.code }));
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Sapproval sunucusu yanıt vermedi.'), { code: 'offline' })));
    req.on('error', (e) => reject(e.status ? e : Object.assign(new Error(`Sapproval sunucusuna ulaşılamadı (${e.code || e.message}).`), { code: 'offline', cause: e })));
    req.end(raw);
  });
}

// git uses this file (copied to ~/.sapproval/runtime) for https://github.com/sapproval-labs only. The
// empty helper first clears inherited helpers for that address, so no sign-in window ever appears.
function configureGit() {
  fs.mkdirSync(path.dirname(RUNTIME_COPY), { recursive: true });
  if (path.resolve(__filename) !== path.resolve(RUNTIME_COPY)) fs.copyFileSync(__filename, RUNTIME_COPY);
  const fwd = (p) => p.replace(/\\/g, '/');
  const helper = `!"${fwd(process.execPath)}" "${fwd(RUNTIME_COPY)}" credential`;
  const key = `credential.${ORG_URL}.helper`;
  const git = (args) => execFileSync('git', ['config', '--global', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try { git(['--unset-all', key]); } catch { /* not set */ }
  git(['--add', key, '']);
  git(['--add', key, helper]);
  git([`credential.${ORG_URL}.useHttpPath`, 'true']);
  return helper;
}

function unconfigureGit() {
  for (const k of [`credential.${ORG_URL}.helper`, `credential.${ORG_URL}.useHttpPath`]) {
    try { execFileSync('git', ['config', '--global', '--unset-all', k], { stdio: 'ignore', windowsHide: true }); } catch { /* not set */ }
  }
}

async function activate(code) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const r = await request('POST', '/v1/activate', {
    code, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), host: os.hostname(), user: os.userInfo().username,
  });
  writeState({
    deviceId: r.deviceId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    person: r.person, customer: r.customer, productRepo: r.productRepo, activated: new Date().toISOString(),
  });
  configureGit();
  return r;
}

function deactivate() {
  unconfigureGit();
  fs.rmSync(STATE_FILE, { force: true });
}

// { state: 'active' | 'revoked', person, customer } or throws (code 'offline' when unreachable).
async function status() {
  const s = readState();
  if (!s) return { state: 'none' };
  const r = await request('POST', '/v1/status', {}, { sign: s });
  if (r.state === 'active' && (r.customer?.team !== s.customer?.team || r.person?.role !== s.person?.role)) {
    writeState({ ...s, person: r.person, customer: r.customer });
  }
  return r;
}

async function token(repo) {
  const s = readState();
  if (!s) throw new Error('Bu bilgisayar Sapproval erişim servisine kayıtlı değil.');
  return request('POST', '/v1/token', { repo }, { sign: s });
}

// git credential protocol: "get" with protocol/host/path on stdin; answer username/password or nothing.
async function credential(op) {
  if (op !== 'get') return;
  const input = fs.readFileSync(0, 'utf8');
  const fields = Object.fromEntries(input.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  if (fields.host !== 'github.com' || !fields.path) return;
  const repo = fields.path.replace(/\.git$/, '').replace(/\/+$/, '');
  try {
    const t = await token(repo);
    process.stdout.write(`username=x-access-token\npassword=${t.token}\n`);
  } catch (e) {
    process.stderr.write(`[Sapproval] ${e.message}\n`);
  }
}

module.exports = { SERVER, STATE_FILE, RUNTIME_COPY, ORG_URL, readState, isActivated, activate, deactivate, status, token, configureGit, request };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const run = {
    activate: async () => {
      const r = await activate(arg);
      process.stdout.write(JSON.stringify({ ok: true, person: r.person, customer: r.customer }) + '\n');
    },
    credential: () => credential(arg),
    status: async () => process.stdout.write(JSON.stringify(await status()) + '\n'),
    deactivate: async () => { deactivate(); process.stdout.write('{"ok":true}\n'); },
  }[cmd];
  if (!run) { process.stderr.write('Kullanım: node erisim.js activate <kod> | credential get | status | deactivate\n'); process.exit(2); }
  Promise.resolve(run()).catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e.code || null }) + '\n');
    process.exit(cmd === 'credential' ? 0 : 1);
  });
}
