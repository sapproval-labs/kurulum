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
//   node erisim.js scribe <dir> [ver]   download Sapproval Scribe's installer (company with Scribe; install.ps1)

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
const PIN_FILE = path.join(HOME_DIR, 'kayit.json');
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
  // A temp name per process: two sessions starting together must not rename each other's file away.
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  replaceFile(tmp, STATE_FILE);
  // The person and the company once more, in a file of their own: a damaged cihaz.json must not let the next
  // activation take another person's sets (activate()).
  if (s?.person?.id || s?.customer?.slug) {
    try {
      const pin = { personId: s.person?.id || null, slug: s.customer?.slug || null };
      const ptmp = `${PIN_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(ptmp, JSON.stringify(pin) + '\n');
      replaceFile(ptmp, PIN_FILE);
    } catch { /* cihaz.json keeps them too */ }
  }
}

// The last step of an atomic write. On Windows the rename fails now and then (EPERM, EBUSY, EACCES) while another
// process has the target open: tried again for a moment; a failure that stays removes the temporary file and throws.
// (lib/dosya.js does the same; this file stays self-contained for install.ps1.)
function replaceFile(tmp, target) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(tmp, target);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 20) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
      }
      Atomics.wait(pause, 0, 0, 25 * i);
    }
  }
}

function readPin() {
  try { return JSON.parse(fs.readFileSync(PIN_FILE, 'utf8')) || {}; } catch { return {}; }
}

// bearer: Sapproval Labs' admin key (tools/lib/admin.js); sign: this PC's device state; raw: a successful answer as
// bytes (a download), not JSON.
function request(method, p, body, { sign = null, bearer = null, timeout = 15000, raw: asBytes = false } = {}) {
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
      const chunks = [];
      res.on('data', (d) => { chunks.push(d); });
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (asBytes && res.statusCode >= 200 && res.statusCode < 300) return resolve(bytes);
        const text = bytes.toString('utf8');
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

// The team repository this PC already follows, from an earlier registration or its connection (~/.sapproval/team.json).
function previousTeam() {
  const s = readState();
  if (s?.customer?.team) return s.customer.team;
  try {
    const repo = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'team.json'), 'utf8')).repo;
    if (repo) return repo;
  } catch { /* missing or damaged: the clone itself */ }
  try {
    // The configured address, not the one a url.insteadOf rule rewrites it to (git remote get-url would).
    const url = execFileSync('git', ['-C', path.join(HOME_DIR, 'team'), 'config', '--get', 'remote.origin.url'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 }).trim();
    return url || null;
  } catch { return null; }
}

async function activate(code) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Activated again (after a "revoked" answer, say): the company's repository stays the one this PC follows, as in
  // status(). An answer without one, or naming another, must not drop or switch it (lib/team.js signature checks).
  const before = previousTeam();
  // The same for the person and the company (lib/atamalar.js picks the permission and rule sets by person.id).
  const state = readState();
  const pin = readPin();
  const wasId = state?.person?.id || pin.personId || null;
  const wasSlug = state?.customer?.slug || pin.slug || null;
  // What this PC is bound to goes along: the service refuses another person's or company's code before using it up.
  const expect = { ...(wasId ? { personId: wasId } : {}), ...(wasSlug ? { slug: wasSlug } : {}), ...(before ? { team: before } : {}) };
  const r = await request('POST', '/v1/activate', {
    code, publicKey: publicKey.export({ type: 'spki', format: 'pem' }), host: os.hostname(), user: os.userInfo().username,
    ...(Object.keys(expect).length ? { expect } : {}),
  });
  const key = (x) => String(x || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
  if (before && r.customer?.team && key(r.customer.team) !== key(before)) {
    throw new Error('Bu bilgisayar başka bir şirketin ekip deposuna bağlı. Sapproval Ekibi ile iletişime geçin (bilgisayar başka bir şirkete geçiyorsa önce eski şirketin ayarları kaldırılmalı).');
  }
  if ((wasId && r.person?.id && r.person.id !== wasId) || (wasSlug && r.customer?.slug && r.customer.slug !== wasSlug)) {
    throw new Error('Bu bilgisayar başka bir kişiye kayıtlı. Sapproval Ekibi ile iletişime geçin (bilgisayar başka birine geçiyorsa önce eski kayıt kaldırılmalı).');
  }
  const person = wasId ? { ...(r.person || {}), id: wasId } : r.person;
  const customer = r.customer
    ? { ...r.customer, team: before || r.customer.team || null, ...(wasSlug ? { slug: wasSlug } : {}) }
    : (before || wasSlug ? { team: before || null, ...(wasSlug ? { slug: wasSlug } : {}) } : r.customer);
  writeState({
    deviceId: r.deviceId, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    person, customer, productRepo: r.productRepo, license: r.license || null, activated: new Date().toISOString(),
  });
  configureGit();
  return r;
}

function deactivate() {
  unconfigureGit();
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(PIN_FILE, { force: true });
}

// { state: 'active' | 'revoked', person, customer } or throws (code 'offline' when unreachable).
// client: what this PC tells the service at a session start (lib/access.js clientInfo): version, OS, SAP system counts.
async function status(client = null) {
  const s = readState();
  if (!s) return { state: 'none' };
  const r = await request('POST', '/v1/status', client ? { client } : {}, { sign: s });
  // PCs activated before license stamps (or the person id, which lib/atamalar.js assigns sets by) existed get
  // them here (lib/runtime.js writes the stamp into the runtime copy).
  // The company's team repository stays the one this PC was activated with: an answer of the service never changes or
  // drops it (whoever took the service over could otherwise point the PC at another repository, or at none and so turn
  // the signature checks of lib/team.js off). A moved repository means a new setup code.
  // The same for the person and the company: lib/atamalar.js picks the person's permission and rule sets by person.id,
  // so an answer naming another person would choose which signed set this PC enforces. Once known, they stay.
  const team = s.customer?.team || r.customer?.team || null;
  const customer = r.customer ? { ...r.customer, team, slug: s.customer?.slug || r.customer.slug } : s.customer;
  const person = r.person ? { ...r.person, id: s.person?.id || r.person.id } : s.person;
  if (r.state === 'active' && (customer?.team !== s.customer?.team || person?.role !== s.person?.role || person?.id !== s.person?.id
    || customer?.name !== s.customer?.name || (r.license && r.license !== s.license))) {
    writeState({ ...s, person, customer, license: r.license || s.license || null });
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

// ---- Sapproval Scribe (install.ps1, for a company whose license has it) ----
// The public half of Sapproval Labs' Scribe publisher key (SapprovalScribe/cekirdek/guncelleme.py YAYINCI_ANAHTARI):
// the version info the service hands out must be signed with it, so a service taken over cannot install a forged
// program. Tests against a local service may name their own key.
const SCRIBE_PUBLISHER = '42ce2f36c7872d85c4aab92a46cc44848f27aecc13fe7e53638d453c9aa0776f';
function scribePublisher() {
  const env = process.env.SAPPROVAL_SCRIBE_PUBLISHER;
  return env && serverUrl() !== SERVER && /^[0-9a-f]{64}$/.test(env) ? env : SCRIBE_PUBLISHER;
}

// What Scribe signs (SapprovalScribe/cekirdek/imza.py manifest_bytes): the version info without "imza", keys sorted,
// no spaces (Python json.dumps(sort_keys=True, separators=(',', ':'), ensure_ascii=False)).
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function scribeSigned(m) {
  try {
    const { imza, ...rest } = m;
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(scribePublisher(), 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonical(rest), 'utf8'), key, Buffer.from(String(imza || ''), 'base64'));
  } catch { return false; }
}
const verNum = (v) => String(v || '').split('.').map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
function newerVersion(a, b) {
  const x = verNum(a);
  const y = verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Downloads Scribe's installer into dir as this PC: the service's signed version info is checked against the publisher
// key, the file against its sha256. installed: the version already on this PC ('' when none); nothing is downloaded when
// it is not older. Returns { ok, file, version } | { ok: true, upToDate, version } | { ok: false, skip, message }.
async function scribeInstaller(dir, installed = '') {
  const s = readState();
  if (!s) throw new Error('Bu bilgisayar Sapproval erişim servisine kayıtlı değil.');
  const st = await request('POST', '/v1/scribe/status', { product: 'scribe' }, { sign: s });
  if (st.state !== 'active') return { ok: false, skip: true, state: st.state, message: st.message || 'Sapproval Scribe lisansı etkin değil.' };
  const m = st.update;
  if (!m || typeof m !== 'object' || !m.surum || !/^[0-9a-f]{64}$/i.test(String(m.sha256 || ''))) {
    return { ok: false, skip: true, message: 'Sunucuda Sapproval Scribe kurulum dosyası yok.' };
  }
  if (!scribeSigned(m)) throw new Error('Sapproval Scribe sürüm bilgisinin imzası doğrulanamadı; güvenlik için kurulmadı.');
  if (installed && !newerVersion(m.surum, installed)) return { ok: true, upToDate: true, version: installed };
  const data = await request('POST', '/v1/scribe/download', { version: m.surum }, { sign: s, raw: true, timeout: 120000 });
  if (crypto.createHash('sha256').update(data).digest('hex') !== String(m.sha256).toLowerCase()) {
    throw new Error('İndirilen Sapproval Scribe kurulum dosyası imzalı sürüm bilgisiyle uyuşmuyor; kurulmadı.');
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `SapprovalScribe-Kurulum-${String(m.surum).replace(/[^0-9A-Za-z.-]/g, '')}.exe`);
  fs.writeFileSync(file, data);
  return { ok: true, file, version: m.surum };
}

module.exports = { SERVER, STATE_FILE, RUNTIME_COPY, ORG_URL, readState, isActivated, activate, deactivate, status, token, configureGit, request, scribeInstaller };

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
    scribe: async () => process.stdout.write(JSON.stringify(await scribeInstaller(arg, process.argv[4] || '')) + '\n'),
  }[cmd];
  if (!run) { process.stderr.write('Kullanım: node erisim.js activate <kod> | credential get | status | deactivate | scribe <klasör> [kurulu sürüm]\n'); process.exit(2); }
  Promise.resolve(run()).catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e.code || null }) + '\n');
    process.exit(cmd === 'credential' ? 0 : 1);
  });
}
