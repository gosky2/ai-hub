#!/usr/bin/env node
// aihub — AI Hub command line. Sets up the hub, installs Claude Code hooks on this machine,
// and starts/lists/wakes/stops Claude Code background sessions with a role (CLAUDE.md template).
// No dependencies beyond Node 22. Every command is safe to run twice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const CLAUDE_DIR = process.env.AIHUB_CLAUDE_DIR || path.join(HOME, '.claude'); // tests point this at a temp dir
const CLAUDE = process.env.AIHUB_CLAUDE_BIN || 'claude';
const STATE_DIR = path.join(ROOT, '.aihub');
const HOOK_FILES = ['hub-hook.sh', 'hub-todo.sh', 'hub-file.sh', 'hub-task.sh'];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,39}$/u;
const BASE_MARK = '## 공통 규칙 (모든 역할)'; // first heading of roles/_base.md, marks a CLAUDE.md written by aihub

// ---------- small helpers ----------
const out = (...a) => console.log(...a);
const die = (msg, code = 1) => { console.error(`aihub: ${msg}`); process.exit(code); };
const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : path.resolve(p));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };

export function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

// .env: KEY=value per line, comments on their own line
export function parseEnv(text) {
  const env = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
const envFile = () => path.join(ROOT, '.env');
const loadEnv = () => (fs.existsSync(envFile()) ? parseEnv(fs.readFileSync(envFile(), 'utf8')) : null);
function config() {
  const c = { ...readJson(path.join(ROOT, 'aihub.config.example.json'), {}), ...readJson(path.join(ROOT, 'aihub.config.json'), {}) };
  const env = loadEnv() || {};
  c.hubUrl = (process.env.AIHUB_URL || c.hubUrl || env.PUBLIC_URL || 'http://localhost:4200').replace(/\/$/, '');
  c.machine = process.env.AIHUB_MACHINE || c.machine || os.hostname().split('.')[0];
  c.workspace = expand(c.workspace || '~/aihub-sessions');
  c.rolesDir = path.resolve(ROOT, c.rolesDir || 'roles');
  return c;
}
const sessionsFile = () => path.join(STATE_DIR, 'sessions.json');

// ---------- hub API (logs in with VIEW_PASSWORD from .env, or AIHUB_PASSWORD) ----------
let cookie = null;
async function hub(p, opts = {}) {
  const c = config();
  if (!cookie) {
    const pw = process.env.AIHUB_PASSWORD || loadEnv()?.VIEW_PASSWORD;
    if (!pw) die('hub password unknown: run `aihub init` here, or set AIHUB_PASSWORD');
    const r = await fetch(`${c.hubUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) }).catch(() => null);
    if (!r) die(`hub not reachable at ${c.hubUrl} — is it running? (aihub start)`);
    if (!r.ok) die(`hub login failed (${r.status})`);
    cookie = /hub=[^;]+/.exec(r.headers.get('set-cookie') || '')?.[0];
  }
  const r = await fetch(`${c.hubUrl}/api/${p}`, { ...opts, headers: { 'content-type': 'application/json', cookie, ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) die(body.error || `hub ${p}: HTTP ${r.status}`);
  return body;
}

// ---------- init ----------
// Fill empty secrets in .env.example with random values; `given` overrides any key.
export function makeEnv(example, given = {}) {
  const rnd = (n) => crypto.randomBytes(n).toString('base64url');
  const secrets = { VIEW_PASSWORD: rnd(12), EVENT_TOKEN: rnd(24), COOKIE_SECRET: rnd(32) };
  return String(example).split(/\r?\n/).map((l) => {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l);
    if (!m) return l;
    if (given[m[1]] !== undefined) return `${m[1]}=${given[m[1]]}`;
    if (m[2] === '' && secrets[m[1]]) return `${m[1]}=${secrets[m[1]]}`;
    return l;
  }).join('\n');
}
function cmdInit(opt) {
  const env = envFile();
  if (fs.existsSync(env) && !opt.force) out('.env already exists — kept (use --force to regenerate secrets)');
  else {
    const given = {};
    if (opt.url) given.PUBLIC_URL = String(opt.url).replace(/\/$/, '');
    if (opt.port) given.PORT = String(opt.port);
    if (opt.port && !opt.url) given.PUBLIC_URL = `http://localhost:${opt.port}`;
    const text = makeEnv(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), given);
    fs.writeFileSync(env, text + '\n', { mode: 0o600 });
    out(`wrote .env (mode 600). Web password: ${parseEnv(text).VIEW_PASSWORD}`);
    out('  keep it somewhere safe; it is also in .env');
  }
  const cf = path.join(ROOT, 'aihub.config.json');
  const cur = readJson(cf, null);
  if (!cur || opt.force || opt.machine || opt.url || opt.port || opt.workspace) {
    const c = { ...readJson(path.join(ROOT, 'aihub.config.example.json'), {}), ...(cur || {}) };
    if (opt.machine) c.machine = String(opt.machine);
    if (!c.machine) c.machine = os.hostname().split('.')[0];
    if (opt.url) c.hubUrl = String(opt.url).replace(/\/$/, '');
    else if (opt.port) c.hubUrl = `http://localhost:${opt.port}`;
    if (opt.workspace) c.workspace = String(opt.workspace);
    if (!NAME_RE.test(c.machine)) die('machine name: letters, digits, space, _ . - (max 40)');
    writeJson(cf, c);
    out(`wrote aihub.config.json (machine "${c.machine}", workspace ${c.workspace})`);
  }
  out('next: aihub start  →  aihub hook install  →  aihub session add pm --role pm');
}

// ---------- start / stop / status ----------
const pidFile = () => path.join(STATE_DIR, 'hub.pid');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function ping() { const r = await fetch(`${config().hubUrl}/api/me`).catch(() => null); return r ? r.status : 0; } // 401 = up, not logged in
async function cmdStart(opt) {
  if (!loadEnv()) die('no .env — run `aihub init` first');
  if (opt.docker) { const r = spawnSync('docker', ['compose', 'up', '-d', '--build'], { cwd: ROOT, stdio: 'inherit' }); process.exit(r.status ?? 1); }
  const pid = +readJson(pidFile(), 0);
  if (pid && alive(pid)) return out(`hub already running (pid ${pid}) at ${config().hubUrl}`);
  const args = ['--no-warnings', `--env-file=${envFile()}`, path.join(ROOT, 'server/index.mjs')];
  if (opt.fg) { const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' }); process.exit(r.status ?? 1); }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(path.join(STATE_DIR, 'hub.log'), 'a');
  const child = spawn(process.execPath, args, { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
  child.unref(); writeJson(pidFile(), child.pid);
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await ping()) return out(`hub started (pid ${child.pid}) → ${config().hubUrl}  (log: .aihub/hub.log)`);
    if (!alive(child.pid)) break;
  }
  die('hub did not answer — see .aihub/hub.log');
}
function cmdStop(opt) {
  if (opt.docker) { const r = spawnSync('docker', ['compose', 'down'], { cwd: ROOT, stdio: 'inherit' }); process.exit(r.status ?? 1); }
  const pid = +readJson(pidFile(), 0);
  if (!pid || !alive(pid)) return out('hub is not running (as started by aihub start)');
  process.kill(pid); fs.rmSync(pidFile(), { force: true }); out(`hub stopped (pid ${pid})`);
}
async function cmdStatus() {
  const c = config(), st = await ping();
  out(`hub      ${c.hubUrl}  ${st ? 'up' : 'DOWN'}`);
  out(`machine  ${c.machine}`);
  out(`hooks    ${hookInstalled() ? 'installed' : 'not installed (aihub hook install)'}`);
  if (st && (loadEnv() || process.env.AIHUB_PASSWORD)) { const s = await hub('state'); out(`sessions ${s.sessions.filter((x) => x.state !== 'offline').length} online / ${s.sessions.length} known`); }
}

// ---------- hooks on this machine ----------
const HOOK_CMD = 'sh ~/.claude/hub-hook.sh';
// Add the five hub hooks to a Claude Code settings object. Leaves other hooks and settings alone.
export function mergeHooks(settings) {
  const d = settings && typeof settings === 'object' ? settings : {};
  const h = (d.hooks ||= {});
  const c = (k = {}) => ({ type: 'command', command: HOOK_CMD, timeout: 5, ...k });
  const w = { type: 'command', command: `${HOOK_CMD} wait`, asyncRewake: true, timeout: 86400 };
  const want = { SessionStart: [{ hooks: [c(), w] }], UserPromptSubmit: [{ hooks: [c()] }], PostToolUse: [{ matcher: '', hooks: [c({ async: true })] }],
    Stop: [{ hooks: [c({ timeout: 10 }), w] }], SessionEnd: [{ hooks: [c()] }] };
  let added = 0;
  for (const [ev, L] of Object.entries(want)) {
    const cur = (h[ev] ||= []);
    if (!cur.some((e) => (e.hooks || []).some((x) => String(x.command || '').includes('hub-hook.sh')))) { cur.push(...L); added++; }
  }
  return { settings: d, added };
}
export function removeHooks(settings) {
  const d = settings || {}; let removed = 0;
  for (const [ev, L] of Object.entries(d.hooks || {})) {
    d.hooks[ev] = L.map((e) => {
      const keep = (e.hooks || []).filter((x) => !String(x.command || '').includes('hub-hook.sh'));
      removed += (e.hooks || []).length - keep.length;
      return { ...e, hooks: keep };
    }).filter((e) => e.hooks.length);
    if (!d.hooks[ev].length) delete d.hooks[ev];
  }
  return { settings: d, removed };
}
function hookInstalled() {
  const s = readJson(path.join(CLAUDE_DIR, 'settings.json'), {});
  return JSON.stringify(s.hooks || {}).includes('hub-hook.sh') && fs.existsSync(path.join(CLAUDE_DIR, 'ai-hub.env'));
}
function cmdHook(sub, opt) {
  const sf = path.join(CLAUDE_DIR, 'settings.json');
  if (sub === 'install') {
    const c = config();
    const token = opt.token || process.env.AIHUB_TOKEN || loadEnv()?.EVENT_TOKEN;
    if (!token) die('no token: run this on the hub machine after `aihub init`, or connect other machines with `aihub join-command`');
    const machine = String(opt.machine || c.machine);
    if (!NAME_RE.test(machine)) die('machine name: letters, digits, space, _ . - (max 40)');
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    for (const f of HOOK_FILES) fs.copyFileSync(path.join(ROOT, 'web', f), path.join(CLAUDE_DIR, f));
    fs.writeFileSync(path.join(CLAUDE_DIR, 'ai-hub.env'), `AI_HUB_TOKEN=${token}\nAI_HUB_MACHINE=${machine}\nAI_HUB_URL=${c.hubUrl}\n`, { mode: 0o600 });
    if (fs.existsSync(sf)) fs.copyFileSync(sf, sf + '.bak-ai-hub');
    const { settings, added } = mergeHooks(readJson(sf, {}));
    writeJson(sf, settings);
    out(`hooks ${added ? `added (${added} events)` : 'already present'} in ${sf}; scripts and ai-hub.env in ${CLAUDE_DIR}`);
    out('new Claude Code sessions on this machine now show up in the hub (restart sessions that are already open)');
  } else if (sub === 'uninstall') {
    if (fs.existsSync(sf)) {
      fs.copyFileSync(sf, sf + '.bak-ai-hub');
      const { settings, removed } = removeHooks(readJson(sf, {}));
      writeJson(sf, settings); out(`removed ${removed} hub hook entries from ${sf}`);
    }
    for (const f of [...HOOK_FILES, 'ai-hub.env']) fs.rmSync(path.join(CLAUDE_DIR, f), { force: true });
    out('removed hub scripts and ai-hub.env');
  } else die('usage: aihub hook install [--machine NAME] | aihub hook uninstall');
}
function cmdJoinCommand() {
  const c = config();
  out('Run this in a terminal on the other machine (Git Bash on Windows), then approve the code in the hub "할 일" tab:');
  out(`  curl -fsSL ${c.hubUrl}/join.sh | sh -s -- "<machine-name>"`);
  if (/localhost|127\.0\.0\.1/.test(c.hubUrl)) out('note: the hub URL is localhost — set PUBLIC_URL in .env (and HOST=0.0.0.0 or a reverse proxy) so other machines can reach it');
}

// ---------- roles ----------
function roles() {
  const dir = config().rolesDir;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    return { name: f.slice(0, -3), title: (/^>\s*(.*)$/m.exec(text)?.[1] || '').trim(), file: path.join(dir, f) };
  });
}
// roles/roles.json: { "<role>": { "model": "sonnet", "effort": "low" } } — defaults for session add/wake
export function roleDefaults(cfg, role, opt = {}) {
  const d = (cfg && cfg[role]) || {};
  const model = opt.model !== undefined ? String(opt.model) : d.model, effort = opt.effort !== undefined ? String(opt.effort) : d.effort;
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}
const roleCfg = () => readJson(path.join(config().rolesDir, 'roles.json'), {});
export function renderRole(base, role, vars) {
  return `${role.trim()}\n\n${base.trim()}\n`.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] ?? m);
}
function cmdRole(sub, pos, opt) {
  const c = config();
  if (!sub || sub === 'list') { const rc = roleCfg(); for (const r of roles()) { const d = rc[r.name] || {}; out(`${r.name.padEnd(10)} ${(d.model || '-').padEnd(7)} ${(d.effort || '-').padEnd(7)} ${r.title}`); } return; }
  if (sub === 'show') {
    const r = roles().find((x) => x.name === pos[0]); if (!r) die(`no role "${pos[0]}" (aihub role list)`);
    return out(renderRole(fs.readFileSync(path.join(c.rolesDir, '_base.md'), 'utf8'), fs.readFileSync(r.file, 'utf8'), { name: displayName(c.machine, '<name>'), machine: c.machine, role: r.name, hubUrl: c.hubUrl }));
  }
  if (sub === 'add') {
    const name = pos[0]; if (!name || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) die('usage: aihub role add <name> [--from <role>]   (name: a-z 0-9 -)');
    const f = path.join(c.rolesDir, `${name}.md`); if (fs.existsSync(f)) die(`role "${name}" exists: ${f}`);
    const from = opt.from ? path.join(c.rolesDir, `${opt.from}.md`) : null;
    if (from && !fs.existsSync(from)) die(`no role "${opt.from}"`);
    fs.writeFileSync(f, from ? fs.readFileSync(from, 'utf8') : `# {{name}}\n\n> ${name}\n\n## 하는 일\n- \n\n## 하지 않는 일\n- \n`);
    if (opt.model || opt.effort || opt.from) { const rc = roleCfg(), d = { ...(opt.from ? rc[opt.from] : {}) }; if (opt.model) d.model = String(opt.model); if (opt.effort) d.effort = String(opt.effort); rc[name] = d; writeJson(path.join(c.rolesDir, 'roles.json'), rc); }
    return out(`created ${f} — edit it, then: aihub session add <name> --role ${name}`);
  }
  die('usage: aihub role list | show <role> | add <name> [--from <role>]');
}

// ---------- sessions (Claude Code background sessions) ----------
function claudeAgents() {
  const r = spawnSync(CLAUDE, ['agents', '--json'], { encoding: 'utf8' });
  if (r.error) die(`cannot run "${CLAUDE}" — install Claude Code and log in (claude auth login)`);
  try { return JSON.parse(r.stdout || '[]'); } catch { return []; }
}
export const displayName = (machine, name) => `[${machine}] ${name}`;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase(); // the hub names a 'pm' folder "[machine] PM"
const bgIdOf = (stdout) => /\b([0-9a-f]{8})\b/.exec(stdout || '')?.[1] || null;
async function hubSessions() { return (await ping()) && (loadEnv() || process.env.AIHUB_PASSWORD) ? (await hub('state')).sessions : null; }
async function cmdSession(sub, pos, opt) {
  const c = config(), reg = readJson(sessionsFile(), {});
  const find = (n) => { if (!n) die('which session? (aihub session list)'); return reg[n] || die(`no session "${n}" started by aihub here (aihub session list)`); };
  if (sub === 'add') {
    const name = pos[0];
    if (!name || !NAME_RE.test(name)) die('usage: aihub session add <name> --role <role> [--dir <folder>] [--rc] [--model <m>] [--prompt "..."]');
    if (reg[name] && !opt.force) die(`session "${name}" already registered (pick another name, or --force)`);
    const roleName = String(opt.role || (name.toLowerCase() === 'pm' ? 'pm' : 'dev'));
    const role = roles().find((r) => r.name === roleName); if (!role) die(`no role "${roleName}" (aihub role list)`);
    const dir = opt.dir ? expand(String(opt.dir)) : path.join(c.workspace, name);
    fs.mkdirSync(dir, { recursive: true });
    const md = path.join(dir, 'CLAUDE.md'), full = displayName(c.machine, name);
    const text = renderRole(fs.readFileSync(path.join(c.rolesDir, '_base.md'), 'utf8'), fs.readFileSync(role.file, 'utf8'), { name: full, machine: c.machine, role: roleName, hubUrl: c.hubUrl });
    // only replace a CLAUDE.md that aihub wrote (it carries the shared-rules heading); never the user's own
    if (fs.existsSync(md) && !fs.readFileSync(md, 'utf8').includes(BASE_MARK)) {
      fs.writeFileSync(path.join(dir, 'CLAUDE.aihub.md'), text);
      out(`kept your CLAUDE.md; the role went to ${path.join(dir, 'CLAUDE.aihub.md')} (add a line "@CLAUDE.aihub.md" to CLAUDE.md to use it)`);
    } else fs.writeFileSync(md, text);
    if (!hookInstalled()) out('warning: hub hooks are not installed on this machine, so the session will not show up in the hub (aihub hook install)');
    const prompt = String(opt.prompt || `AI 허브 세션 "${full}"(역할: ${roleName})로 시작합니다. CLAUDE.md를 읽고 한 줄로 '준비됨'만 답하세요.`);
    const args = ['--bg', '-n', full, ...(opt.rc ? ['--remote-control', full] : []), ...roleDefaults(roleCfg(), roleName, opt), ...(c.claudeArgs || []), prompt];
    let r = spawnSync(CLAUDE, args, { cwd: dir, encoding: 'utf8' });
    // Claude Code asks once per folder whether you trust it. aihub does not answer that for you: it opens Claude there so you can.
    if (r.status !== 0 && /not trusted/i.test(r.stderr || '')) {
      if (!opt.trust || !process.stdin.isTTY) {
        die(`Claude Code has not been allowed to work in ${dir} yet.\n  Run once:  cd ${JSON.stringify(dir)} && claude   → accept the trust question → /exit\n  then:      aihub session add ${name} --role ${roleName}${opt.dir ? ` --dir ${JSON.stringify(dir)}` : ''} --force\n  (or add --trust to have aihub open Claude there for you)`);
      }
      out(`opening Claude Code in ${dir} — accept the trust question, then type /exit to continue`);
      spawnSync(CLAUDE, [], { cwd: dir, stdio: 'inherit' });
      r = spawnSync(CLAUDE, args, { cwd: dir, encoding: 'utf8' });
    }
    if (r.error || r.status !== 0) die(`claude did not start: ${(r.stderr || r.error?.message || '').trim().slice(0, 400)}`);
    const id = bgIdOf(r.stdout);
    reg[name] = { role: roleName, dir, machine: c.machine, display: full, bgId: id, created: new Date().toISOString() };
    writeJson(sessionsFile(), reg);
    out(`started "${full}" (role ${roleName}) in ${dir}${id ? `  id ${id}` : ''}`);
    out(`  watch: claude attach ${id || JSON.stringify(full)}   ·   instruct: aihub session send ${name} "..."`);
    return;
  }
  if (!sub || sub === 'list') {
    const names = Object.keys(reg);
    if (!names.length) return out('no sessions yet — aihub session add pm --role pm');
    const agents = claudeAgents(), hs = await hubSessions();
    out(['NAME', 'ROLE', 'CLAUDE', 'HUB', 'DIR'].join('\t'));
    for (const n of names) {
      const s = reg[n], a = agents.find((x) => x.id === s.bgId || same(x.name, s.display));
      const h = hs?.filter((x) => same(x.name, s.display) || (a && x.session === a.sessionId)).sort((x, y) => y.last - x.last)[0];
      out([n, s.role, a ? a.status : 'stopped', h ? h.state : hs ? '-' : '?', s.dir].join('\t'));
    }
    return;
  }
  if (sub === 'stop') {
    const s = find(pos[0]);
    const r = spawnSync(CLAUDE, ['stop', s.bgId || s.display], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  if (sub === 'wake') { // resume the same conversation in the background, keeping its history
    const s = find(pos[0]);
    const a = claudeAgents().find((x) => x.id === s.bgId || same(x.name, s.display));
    if (a && !['stopped', 'done', 'exited'].includes(a.status) && !opt.force) return out(`"${s.display}" is already running (${a.status})`);
    const hs = a?.sessionId ? null : await hubSessions();
    const sid = a?.sessionId || s.sessionId || hs?.filter((x) => same(x.name, s.display)).sort((x, y) => y.last - x.last)[0]?.session;
    if (!sid) die('cannot find the Claude session id to resume — start it again with: aihub session add <name> --force');
    const r = spawnSync(CLAUDE, ['--bg', '--resume', sid, ...roleDefaults(roleCfg(), s.role, opt), String(opt.prompt || '허브에서 다시 깨움. 한 줄로 \'준비됨\'만 답하세요.')], { cwd: s.dir, encoding: 'utf8' });
    if (r.error || r.status !== 0) die(`claude did not resume: ${(r.stderr || r.error?.message || '').trim().slice(0, 400)}`);
    s.bgId = bgIdOf(r.stdout) || s.bgId; s.sessionId = sid; writeJson(sessionsFile(), reg);
    return out(`woke "${s.display}"`);
  }
  if (sub === 'send') {
    const s = find(pos[0]), text = pos.slice(1).join(' ').trim(); if (!text) die('usage: aihub session send <name> "instruction"');
    const h = (await hub('state')).sessions.filter((x) => same(x.name, s.display) && x.state !== 'offline').sort((a, b) => b.last - a.last)[0];
    if (!h) die(`"${s.display}" is not connected to the hub (aihub session wake ${pos[0]})`);
    const r = await hub('ask', { method: 'POST', body: JSON.stringify({ to: h.key, text }) });
    return out(r.waiting ? 'queued — the session picks it up when it is free' : 'delivered');
  }
  if (sub === 'refresh') { // same as the hub's '정리하고 새로 시작': the session updates its card and hands off with hub-task.sh handoff
    const s = find(pos[0]);
    const h = (await hub('state')).sessions.filter((x) => same(x.name, s.display) && x.state !== 'offline').sort((a, b) => b.last - a.last)[0];
    if (!h) die(`"${s.display}" is not connected to the hub (aihub session wake ${pos[0]})`);
    const r = await hub('refresh', { method: 'POST', body: JSON.stringify({ key: h.key }) });
    return out(r.waiting ? 'refresh queued — the session does it when it is free' : 'refresh sent — the session updates its card and hands off to a new session');
  }
  if (sub === 'rm') { const s = find(pos[0]); delete reg[pos[0]]; writeJson(sessionsFile(), reg); return out(`forgot "${s.display}" (folder ${s.dir} and its Claude conversation are kept)`); }
  die('usage: aihub session add|list|send|wake|refresh|stop|rm');
}

// ---------- tools (shared how-tos, attached to instructions with @name) ----------
async function cmdTool(sub, pos, opt) {
  if (!sub || sub === 'list') {
    const { tools } = await hub('tools');
    if (!tools.length) return out('no tools yet — aihub tool add <name> --desc "..." --how "..."');
    for (const t of tools) out(`@${t.name.padEnd(20)} ${t.desc || ''}`);
    return;
  }
  if (sub === 'add') {
    const name = pos[0]; if (!name) die('usage: aihub tool add <name> --desc "..." --how "..." [--example "..."] [--links "..."] [--target <session>]');
    let target = '';
    if (opt.target) {
      const disp = readJson(sessionsFile(), {})[opt.target]?.display || opt.target;
      target = (await hub('state')).sessions.find((x) => x.key === opt.target || same(x.name, disp))?.key || die(`no hub session "${opt.target}"`);
    }
    const { tools } = await hub('tools'), cur = tools.find((t) => t.name === name.trim().replace(/\s+/g, '-'));
    const pick = (k) => (opt[k] !== undefined ? String(opt[k]) : cur?.[k] ?? '');
    const r = await hub('tools', { method: 'POST', body: JSON.stringify({ id: cur?.id, name, desc: pick('desc'), how: pick('how'), example: pick('example'), links: pick('links'), target: target || cur?.target || '' }) });
    return out(`${cur ? 'updated' : 'added'} tool @${r.name} — mention @${r.name} in the hub chat to attach it`);
  }
  if (sub === 'rm') {
    const { tools } = await hub('tools'), t = tools.find((x) => x.name === pos[0]); if (!t) die(`no tool "${pos[0]}"`);
    await hub(`tools/${t.id}`, { method: 'DELETE' }); return out(`removed @${t.name}`);
  }
  die('usage: aihub tool list | add <name> ... | rm <name>');
}

// ---------- session work board (T numbers) and session cards ----------
async function cmdTask(sub, pos, opt) {
  const body = (o) => ({ method: 'POST', body: JSON.stringify(o) });
  if (!sub || sub === 'ls' || sub === 'list') { const { tasks } = await hub('tasks'); if (!tasks.length) return out('no tasks — aihub task new "title" --to <session>'); for (const t of tasks) out(taskLine(t)); return; }
  if (sub === 'digest') { // only what changed since the last digest (kept in .aihub/digest.json)
    const f = path.join(STATE_DIR, 'digest.json'), since = readJson(f, {}).since || 0;
    const { tasks, now } = await hub(`tasks?since=${since}`); writeJson(f, { since: now });
    return out(tasks.length ? tasks.map(taskLine).join('\n') : '(no changes)');
  }
  const owner = async (n) => { if (!n) return undefined; const disp = readJson(sessionsFile(), {})[n]?.display || n; return (await hub('state')).sessions.find((x) => x.key === n || same(x.name, disp))?.key || die(`no hub session "${n}"`); };
  if (sub === 'new') {
    if (!pos[0]) die('usage: aihub task new "title" [--to <session>] [--when "done when"] [--paths "…"] [--start]');
    const r = await hub('tasks', body({ op: 'new', title: pos[0], owner: await owner(opt.to), done_when: opt.when, paths: opt.paths, start: !!opt.start }));
    return out(r.task);
  }
  if (['start', 'done', 'block', 'ask', 'todo'].includes(sub)) {
    if (!pos[0]) die(`usage: aihub task ${sub} T12 ["one line"] [--paths "…"]`);
    const r = await hub('tasks', body({ op: sub, id: pos[0], note: pos[1], paths: opt.paths }));
    return out(r.task);
  }
  die('usage: aihub task ls | digest | new "title" [--to s] [--when ..] | start|done|block|ask T12 ["note"]');
}
export const taskLine = (t) => `T${t.id} [${t.state}] ${t.title}${t.owner_name ? ` — ${t.owner_name}` : ''}${t.result ? ` | ${t.result}` : ''}${t.paths ? ` | ${t.paths}` : ''}`;
async function cmdCard(pos) {
  const n = pos[0]; if (!n) die('usage: aihub card <session>');
  const disp = readJson(sessionsFile(), {})[n]?.display || n;
  const h = (await hub('state')).sessions.filter((x) => x.key === n || same(x.name, disp)).sort((a, b) => b.last - a.last)[0]; if (!h) die(`no hub session "${n}"`);
  const { cards } = await hub('cards'), c = cards[h.key];
  if (!c) return out(`no card yet for ${h.name || h.key} (the session writes it with: sh ~/.claude/hub-task.sh card --now .. --todo ..)`);
  for (const [k, v] of [['now', c.now], ['decided', c.decided], ['todo', c.todo], ['files', c.files]]) if (v) out(`${k.padEnd(8)} ${v}`);
}

// ---------- doctor ----------
async function cmdDoctor() {
  let bad = 0;
  const ok = (cond, label, fix) => { out(`${cond ? 'ok  ' : 'FAIL'}  ${label}${cond || !fix ? '' : `\n      → ${fix}`}`); if (!cond) bad++; };
  const [maj, min] = process.versions.node.split('.').map(Number);
  ok(maj > 22 || (maj === 22 && min >= 13), `node ${process.versions.node} (needs 22.13+)`, 'install Node.js 22.13 or newer');
  const cv = spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' });
  ok(!cv.error && cv.status === 0, `claude ${(cv.stdout || '').trim() || 'not found'}`, 'install Claude Code (https://docs.anthropic.com/en/docs/claude-code)');
  if (!cv.error) { const as = spawnSync(CLAUDE, ['auth', 'status'], { encoding: 'utf8' }); ok(/"loggedIn"\s*:\s*true/.test(as.stdout || ''), 'claude logged in', 'run: claude auth login'); }
  ok(!spawnSync('curl', ['--version'], { stdio: 'ignore' }).error, 'curl available (used by the hooks)', 'install curl');
  ok(!!loadEnv(), '.env present', 'aihub init');
  ok(!!(await ping()), `hub reachable at ${config().hubUrl}`, 'aihub start');
  ok(hookInstalled(), 'hub hooks installed on this machine', 'aihub hook install');
  out(bad ? `\n${bad} problem(s)` : '\nall good'); process.exitCode = bad ? 1 : 0;
}

const HELP = `aihub — AI Hub for Claude Code sessions

setup
  aihub init [--machine NAME] [--url URL] [--port N] [--force]   create .env (random secrets) and aihub.config.json
  aihub start [--docker|--fg]      start the hub (background node process, or docker compose)
  aihub stop [--docker]            stop it
  aihub status                     hub, machine, hooks, session count
  aihub doctor                     check node, claude login, hub and hooks
  aihub hook install [--machine NAME]   add hub hooks to ~/.claude on this machine (backs up settings.json)
  aihub hook uninstall             remove them
  aihub join-command               print the one-liner that connects another machine

sessions (Claude Code background sessions with a role)
  aihub session add <name> --role <role> [--dir DIR] [--rc] [--model M] [--effort E] [--prompt TEXT] [--trust] [--force]
                                   model and effort default to the role's entry in roles/roles.json
                                   --trust: if Claude has not been allowed in DIR yet, open it there so you can accept
  aihub session list               sessions started here, with Claude and hub state
  aihub session send <name> TEXT   send an instruction through the hub
  aihub session wake <name>        resume a stopped or asleep session in the background
  aihub session refresh <name>     tidy up and restart: the session updates its card, hands off to a new session, stops
  aihub session stop <name>        stop it (the conversation is kept)
  aihub session rm <name>          forget it here (folder and conversation are kept)

work board and cards (sessions update them with ~/.claude/hub-task.sh, or @task/@done lines in messages)
  aihub task ls | digest           open tasks / only what changed since the last digest
  aihub task new "title" [--to <session>] [--when "done when"] [--paths ..] [--start]
  aihub task start|done|block|ask T12 ["one line"] [--paths ..]
  aihub card <session>             the session's card (now / decided / todo / files)

roles and tools
  aihub role list | show <role> | add <name> [--from <role>] [--model M] [--effort E]
  aihub tool list | add <name> --desc .. --how .. [--example ..] [--links ..] [--target <session>] | rm <name>
`;

export async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  const { pos, opt } = parseArgs(rest);
  const all = parseArgs(argv.slice(1)); // for commands without a sub-command
  switch (cmd) {
    case 'init': return cmdInit(all.opt);
    case 'start': return cmdStart(all.opt);
    case 'stop': return cmdStop(all.opt);
    case 'status': return cmdStatus();
    case 'doctor': return cmdDoctor();
    case 'hook': return cmdHook(sub, opt);
    case 'join-command': return cmdJoinCommand();
    case 'role': case 'roles': return cmdRole(sub, pos, opt);
    case 'session': case 'sessions': return cmdSession(sub, pos, opt);
    case 'tool': case 'tools': return cmdTool(sub, pos, opt);
    case 'task': case 'tasks': return cmdTask(sub, pos, opt);
    case 'card': return cmdCard([sub, ...pos].filter(Boolean));
    case undefined: case 'help': case '-h': case '--help': return out(HELP);
    case '--version': case '-v': return out(readJson(path.join(ROOT, 'package.json'), {}).version);
    default: die(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === self) await main(process.argv.slice(2));
