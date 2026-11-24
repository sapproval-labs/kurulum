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
const PLUGIN = 'sapproval@sapproval';
const OLD_PLUGIN = 'abap-dev@sapproval'; // the plugin's name until 0.43
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
// The folder of the Sapproval Labs version Claude Code has installed (installed_plugins.json, as install.ps1 and the
// plugin's lib/update.js read it); when that cannot be read, the newest version folder. Old version folders stay in the
// cache, and the newest by date is not always the installed one.
function pluginRoot() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(configDir(), 'plugins', 'installed_plugins.json'), 'utf8'));
    const map = j.plugins || j;
    const entries = Object.entries(map).filter(([k]) => k.startsWith('sapproval@')).flatMap(([, v]) => (Array.isArray(v) ? v : [v]));
    const entry = entries.find((e) => e?.scope === 'user') || entries[0];
    if (entry?.installPath && fs.existsSync(path.join(entry.installPath, 'lib', 'team.js'))) return entry.installPath;
  } catch { /* the cache below */ }
  const cache = path.join(configDir(), 'plugins', 'cache', MARKET, 'sapproval');
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
    try {
      st = await erisim.status();
    } catch (e) {
      // Not reached, or the PC clock is wrong: say so, the code is not the problem. A registration the service does not
      // know (unknown_device, signature) is registered again with the code below.
      if (e.code === 'offline') return done({ ok: false, error: e.message });
      if (e.code === 'clock') return done({ ok: false, error: `${e.message} Windows'ta "Saati otomatik olarak ayarla"yı açıp tekrar deneyin.` });
      st = null;
    }
  }
  if (st && st.state === 'active' && code) {
    // Registered and active, and a code given: another person's code is refused before it is used up (setup must not go
    // on as someone else); the code this PC was set up with (already used) changes nothing.
    try {
      const r = await erisim.activate(code);
      st = { state: 'active', person: r.person, customer: r.customer };
    } catch (e) {
      if (e.code === 'other_pc') return done({ ok: false, error: e.message });
    }
  }
  if (!st || st.state !== 'active') {
    // Without a code, a closed or ended license is told as it is, not as a missing code.
    if (!code) return done({ ok: false, error: st?.message || 'Kurulum kodunu yazın: /kurulum:kur ABCD-EFGH-JKLM' });
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
  // Turned off on purpose (false) is not "installed": it is installed and turned on again.
  const pluginOn = s.enabledPlugins?.[PLUGIN] === true || (s.enabledPlugins?.[PLUGIN] === undefined && !!pluginRoot());
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
    // A marketplace added before the plugin was renamed ("abap-dev" until 0.43) does not know the new name yet.
    else claude(cli, ['plugin', 'marketplace', 'update', MARKET]);
    const r = claude(cli, ['plugin', 'install', PLUGIN]);
    if (!r.ok) return done({ ok: false, error: `Sapproval eklentisi kurulamadı: ${r.out.split('\n').slice(-2).join(' ')}` });
  }
  // The old name blocks SAP calls while it is installed next to the new one.
  if (s.enabledPlugins && Object.prototype.hasOwnProperty.call(s.enabledPlugins, OLD_PLUGIN)) {
    const cli = claudeCli();
    if (cli) claude(cli, ['plugin', 'uninstall', OLD_PLUGIN]);
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
  // Sapproval Scribe is a desktop program of its own: this path does not install it.
  if ((st.customer.products || []).includes('scribe')) {
    say('ℹ Şirketinizin lisansında Sapproval Scribe (Teams toplantı asistanı) da var. Davet e-postanızdaki Scribe bağlantısından '
      + 'bu bilgisayara kurun; bağlantınız yoksa ekip yöneticinizden ya da Sapproval Ekibi\'nden Scribe daveti isteyin.');
  }
  return done({ ok: true });
}

main().catch((e) => done({ ok: false, error: e.message }));
