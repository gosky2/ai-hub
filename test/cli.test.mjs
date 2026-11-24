// Unit tests for the pure parts of the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseEnv, makeEnv, mergeHooks, removeHooks, renderRole, displayName } from '../cli/aihub.mjs';

test('parseArgs: positionals, --k v, --k=v, flags', () => {
  const { pos, opt } = parseArgs(['pm', '--role', 'pm', '--rc', '--dir=/tmp/x y', '--', '--not-an-opt']);
  assert.deepEqual(pos, ['pm', '--not-an-opt']);
  assert.deepEqual(opt, { role: 'pm', rc: true, dir: '/tmp/x y' });
});

test('parseEnv ignores comments and strips quotes', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two"\n  C = x\nnot a line'), { A: '1', B: 'two', C: 'x' });
});

test('makeEnv fills only empty secrets and applies overrides', () => {
  const ex = '# x\nVIEW_PASSWORD=\nEVENT_TOKEN=\nCOOKIE_SECRET=\nPORT=4200\nPUBLIC_URL=http://localhost:4200';
  const env = parseEnv(makeEnv(ex, { PORT: '5000' }));
  assert.ok(env.VIEW_PASSWORD.length >= 12 && env.EVENT_TOKEN.length >= 24 && env.COOKIE_SECRET.length >= 32);
  assert.equal(env.PORT, '5000');
  assert.equal(env.PUBLIC_URL, 'http://localhost:4200');
  assert.notEqual(parseEnv(makeEnv(ex)).EVENT_TOKEN, parseEnv(makeEnv(ex)).EVENT_TOKEN); // random each time
  assert.equal(parseEnv(makeEnv('VIEW_PASSWORD=keep')).VIEW_PASSWORD, 'keep');
});

test('mergeHooks adds five events once and keeps other hooks', () => {
  const mine = { type: 'command', command: 'echo mine' };
  const s = { model: 'x', hooks: { Stop: [{ hooks: [mine] }] } };
  const a = mergeHooks(s);
  assert.equal(a.added, 5);
  assert.equal(a.settings.model, 'x');
  assert.deepEqual(a.settings.hooks.Stop[0].hooks[0], mine);
  assert.ok(JSON.stringify(a.settings.hooks.SessionStart).includes('hub-hook.sh wait'));
  assert.equal(mergeHooks(a.settings).added, 0); // idempotent
  const r = removeHooks(a.settings);
  assert.equal(r.removed, 7);
  assert.deepEqual(r.settings.hooks, { Stop: [{ hooks: [mine] }] });
});

test('renderRole puts the role first, base after, and fills placeholders', () => {
  const t = renderRole('base for {{name}} ({{role}}) {{unknown}}', '# {{name}}\n> r', { name: displayName('laptop', 'pm'), role: 'pm' });
  assert.equal(t, '# [laptop] pm\n> r\n\nbase for [laptop] pm (pm) {{unknown}}\n');
});
