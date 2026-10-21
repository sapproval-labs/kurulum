#!/usr/bin/env node
'use strict';

// Sapproval setup from inside Claude Code (/kurulum:kur <code>), the fallback when the installer window
// cannot be run. Same steps as install.ps1 -Kod: register this PC with the setup code (erisim.js, a copy of
// the plugin's lib/erisim.js), add the Sapproval marketplace and plugin, turn on auto-update, connect the
// company's team settings. Safe to run again: finished steps are skipped.
// Prints progress lines, then one JSON line: { ok, need?, manual?, error? }.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MARKET_REPO = 'sapproval-labs/abap-dev';
const MARKET = 'sapproval';
const PLUGIN = 'abap-dev@sapproval';
const say = (s) => process.stdout.write(`${s}\n`);
const done = (o) => { process.stdout.write(`${JSON.stringify(o)}\n`); process.exit(o.ok ? 0 : 1); };

function nodeOk() {
  const [a, b] = process.versions.node.split('.').map(Number);
  return a > 22 || (a === 22 && b >= 19);
}
function has(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  return r.status === 0;
}
function claudeCli() {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(local)) return local;
  return has('claude') ? 'claude' : null;
}
function claude(cli, args) {
  const r = spawnSync(cli, args, { encoding: 'utf8', shell: process.platform === 'win32' && cli === 'claude', windowsHide: true, timeout: 300000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8')); } catch { return {}; }
}
function pluginRoot() {
  const cache = path.join(configDir(), 'plugins', 'cache', MARKET, 'abap-dev');
  try {
    return fs.readdirSync(cache).map((d) => path.join(cache, d)).filter((d) => fs.existsSync(path.join(d, 'lib', 'team.js')))
      .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs)[0] || null;
  } catch {
    return null;
  }
}

async function main() {
  const code = process.argv.slice(2).join(' ').trim();
  if (!nodeOk()) return done({ ok: false, need: 'node', error: `Node.js ${process.versions.node} eski; 22.19 veya üstü gerekli.` });
  if (!has('git')) return done({ ok: false, need: 'git', error: 'Git kurulu değil.' });
  say('✓ Node.js ve Git hazır');

  // 1. Register this PC (skipped when it already is and the service still knows it).
  const erisim = require('./erisim');
  let st = null;
  if (erisim.isActivated()) {
    try { st = await erisim.status(); } catch (e) { if (e.code !== 'offline') st = null; else return done({ ok: false, error: e.message }); }
  }
  if (!st || st.state !== 'active') {
    if (!code) return done({ ok: false, error: 'Kurulum kodunu yazın: /kurulum:kur ABCD-EFGH-JKLM' });
    try {
      const r = await erisim.activate(code);
      st = { state: 'active', person: r.person, customer: r.customer };
    } catch (e) {
      return done({ ok: false, error: e.message });
    }
  }
  say(`✓ Bu bilgisayar kayıtlı: ${st.person.name} (${st.customer.name})`);

  // 2. Marketplace and plugin.
  const s = readSettings();
  const marketKnown = !!s.extraKnownMarketplaces?.[MARKET];
  const pluginOn = s.enabledPlugins?.[PLUGIN] === true || !!pluginRoot();
  if (!marketKnown || !pluginOn) {
    const cli = claudeCli();
    if (!cli) {
      return done({ ok: false, manual: [...(marketKnown ? [] : [`/plugin marketplace add ${MARKET_REPO}`]), `/plugin install ${PLUGIN}`],
        error: 'Sapproval eklentisini eklemek için iki komut yazmanız gerekiyor.' });
    }
    if (!marketKnown) {
      const r = claude(cli, ['plugin', 'marketplace', 'add', MARKET_REPO]);
      if (!r.ok) return done({ ok: false, error: `Sapproval marketplace eklenemedi: ${r.out.split('\n').slice(-2).join(' ')}` });
    }
    const r = claude(cli, ['plugin', 'install', PLUGIN]);
    if (!r.ok) return done({ ok: false, error: `Sapproval eklentisi kurulamadı: ${r.out.split('\n').slice(-2).join(' ')}` });
  }
  say('✓ Sapproval eklentisi Claude Code\'da');

  // 3. Auto-update for the Sapproval marketplace.
  try {
    const file = path.join(configDir(), 'settings.json');
    const cur = readSettings();
    if (cur.extraKnownMarketplaces?.[MARKET] && cur.extraKnownMarketplaces[MARKET].autoUpdate !== true) {
      cur.extraKnownMarketplaces[MARKET].autoUpdate = true;
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(cur, null, 2) + '\n');
      fs.renameSync(`${file}.tmp`, file);
    }
    say('✓ Otomatik güncelleme açık');
  } catch (e) {
    say(`! Otomatik güncelleme açılamadı (${e.message}); kurulum ekranından açabilirsiniz.`);
  }

  // 4. Company team settings, with the installed plugin's own code.
  const root = pluginRoot();
  if (root && st.customer.team) {
    try {
      const team = require(path.join(root, 'lib', 'team.js'));
      if (!team.isConnected()) team.connect(st.customer.team);
      say(`✓ Şirket ayarları bağlı (${st.customer.team})`);
    } catch (e) {
      say(`! Şirket ayarları bağlanamadı: ${e.message}. Kurulum ekranından da bağlanabilir.`);
    }
  }
  return done({ ok: true });
}

main().catch((e) => done({ ok: false, error: e.message }));
