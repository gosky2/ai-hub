// End to end: copy the repo to a temp dir, `aihub init` → `start` → `hook install` (into a temp ~/.claude) →
// send a hook event → `session add` with a stub `claude` → `session list` → `tool add/list/rm` → `stop`.
// Needs Node 22.13+ and the ws dependency installed (npm ci).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aihub-e2e-'));
const repo = path.join(tmp, 'repo'), home = path.join(tmp, 'home'), claudeDir = path.join(home, '.claude'), ws = path.join(tmp, 'ws');
for (const p of ['server', 'web', 'cli', 'roles', 'package.json', '.env.example', 'aihub.config.example.json']) fs.cpSync(path.join(SRC, p), path.join(repo, p), { recursive: true });
fs.symlinkSync(path.join(SRC, 'node_modules'), path.join(repo, 'node_modules'));
// stub claude: records its args and cwd, prints a background id like the real one
const stub = path.join(tmp, 'claude');
fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$PWD :: $*" >> "${tmp}/claude.log"\ncase "$PWD" in *untrusted*) echo 'Workspace not trusted. Run claude there once.' >&2; exit 1;; esac\ncase "$1" in\n  agents) echo '[]';;\n  --version) echo '9.9.9 (stub)';;\n  *) echo 'started 1a2b3c4d';;\nesac\n`, { mode: 0o755 });
const port = 4300 + Math.floor(Math.random() * 500);
const env = { ...process.env, HOME: home, USERPROFILE: home, AIHUB_CLAUDE_DIR: claudeDir, AIHUB_CLAUDE_BIN: stub, AIHUB_MACHINE: 'testbox' };
const aihub = (...a) => {
  const r = spawnSync(process.execPath, [path.join(repo, 'cli/aihub.mjs'), ...a], { cwd: repo, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('init → start → hooks → sessions → tools → stop', async (t) => {
  t.after(() => { aihub('stop'); fs.rmSync(tmp, { recursive: true, force: true }); });

  let r = aihub('init', '--port', String(port), '--workspace', ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Web password: \S{12,}/);
  assert.equal(fs.statSync(path.join(repo, '.env')).mode & 0o777, 0o600);
  assert.match(aihub('init').out, /already exists/); // second run keeps secrets

  r = aihub('start'); assert.equal(r.code, 0, r.out); assert.match(r.out, /hub started/);
  assert.match(aihub('start').out, /already running/);

  r = aihub('hook', 'install'); assert.equal(r.code, 0, r.out);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(Object.keys(settings.hooks).length, 5);
  assert.match(fs.readFileSync(path.join(claudeDir, 'ai-hub.env'), 'utf8'), new RegExp(`AI_HUB_URL=http://localhost:${port}`));
  assert.match(aihub('hook', 'install').out, /already present/);

  // the installed hook script talks to the hub: a SessionStart from a folder named "pm" becomes "[testbox] PM"
  fs.mkdirSync(path.join(ws, 'pm'), { recursive: true });
  const hook = spawnSync('sh', [path.join(claudeDir, 'hub-hook.sh')], { env, input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'abc-123', cwd: path.join(ws, 'pm'), source: 'startup' }), encoding: 'utf8' });
  assert.equal(hook.status, 0, hook.stderr);

  r = aihub('session', 'add', 'pm', '--role', 'pm'); assert.equal(r.code, 0, r.out);
  assert.match(r.out, /started "\[testbox\] pm".*id 1a2b3c4d/s);
  const md = fs.readFileSync(path.join(ws, 'pm', 'CLAUDE.md'), 'utf8');
  assert.match(md, /^# \[testbox\] pm — PM/);
  assert.match(md, /우회하지 않습니다/);
  assert.doesNotMatch(md, /\{\{\w+\}\}/);
  const log = fs.readFileSync(path.join(tmp, 'claude.log'), 'utf8');
  assert.match(log, new RegExp(`${path.join(ws, 'pm')} :: --bg -n \\[testbox\\] pm`));
  assert.equal(aihub('session', 'add', 'pm').code, 1); // no duplicates
  assert.equal(aihub('session', 'add', 'x', '--role', 'nope').code, 1);
  // re-adding rewrites a CLAUDE.md aihub wrote, but never the user's own
  assert.equal(aihub('session', 'add', 'pm', '--role', 'pm', '--force').code, 0);
  fs.mkdirSync(path.join(ws, 'mine'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'mine', 'CLAUDE.md'), '# my own rules\n');
  r = aihub('session', 'add', 'mine', '--role', 'dev'); assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(ws, 'mine', 'CLAUDE.md'), 'utf8'), '# my own rules\n');
  assert.match(fs.readFileSync(path.join(ws, 'mine', 'CLAUDE.aihub.md'), 'utf8'), /개발/);
  // a folder Claude Code does not trust yet: explain how, do not touch Claude's trust settings
  r = aihub('session', 'add', 'untrusted', '--role', 'dev');
  assert.equal(r.code, 1); assert.match(r.out, /accept the trust question/);

  r = aihub('session', 'list'); assert.equal(r.code, 0, r.out); assert.match(r.out, /pm\tpm\tstopped/); assert.doesNotMatch(r.out, /untrusted/);
  r = aihub('status'); assert.match(r.out, /up/); assert.match(r.out, /sessions 1 online/);

  r = aihub('tool', 'add', 'deploy-dev', '--desc', 'ship to dev', '--how', 'run make dev'); assert.equal(r.code, 0, r.out);
  assert.match(aihub('tool', 'list').out, /@deploy-dev\s+ship to dev/);
  assert.match(aihub('tool', 'add', 'deploy-dev', '--desc', 'ship it').out, /updated/);
  assert.match(aihub('tool', 'rm', 'deploy-dev').out, /removed/);

  r = aihub('role', 'add', 'qa', '--from', 'dev'); assert.equal(r.code, 0, r.out);
  assert.match(aihub('role', 'list').out, /^qa\s/m);

  r = aihub('hook', 'uninstall'); assert.equal(r.code, 0, r.out);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).hooks, {});
  assert.match(aihub('stop').out, /hub stopped/);
});
