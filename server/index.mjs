// AI Hub server: Claude Code 세션들이 hook으로 보낸 이벤트를 받아 sqlite에 쌓고, 로그인한 화면에 웹소켓으로 바로 뿌림.
// 경로는 / 기준. 리버스 프록시 아래(/ai-hub/ 등)에 둘 땐 프록시가 앞부분을 떼고 넘기고, COOKIE_PATH만 그 경로로.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const { VIEW_PASSWORD, EVENT_TOKEN, COOKIE_SECRET } = process.env;
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const PORT = +(process.env.PORT || 4200);
const TEXT_LIMIT = +(process.env.TEXT_LIMIT ?? 4000); // 0이면 내용 저장 안 함
const COOKIE_PATH = process.env.COOKIE_PATH || '/';
// 공개 주소(공유 링크에 씀). https면 쿠키에 Secure. localhost는 브라우저가 http여도 Secure 쿠키를 받아 줌
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === '1' : PUBLIC_URL.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(PUBLIC_URL);
const COOKIE_ATTR = `Path=${COOKIE_PATH}; HttpOnly;${SECURE ? ' Secure;' : ''} SameSite=Lax`;
const WEB = path.resolve(process.env.WEB_DIR || 'web');
const KEEP_DAYS = 30, COOKIE_DAYS = 180, OFFLINE_MS = 6 * 3600e3;
const TYPES = new Set(['heartbeat', 'prompt', 'send', 'receive', 'busy', 'idle', 'stop', 'reply', 'ask', 'file', 'todo']);

const clip = (t) => (TEXT_LIMIT && t ? String(t).slice(0, TEXT_LIMIT) : null);
const str = (v, n = 120) => (v == null || v === '' ? null : String(v).slice(0, n));

// 자동 정리: check는 명령이 아니라 정해진 세 가지만(서버가 다른 컴퓨터에 실행할 글을 나눠 주지 않게).
//   hub:seen:<컴퓨터>        서버가 1분마다: 그 컴퓨터에서 훅 신호(prompt)가 들어오면 = 훅 설치됨 → 뺌
//   exists:<경로>             맡긴 컴퓨터의 hub-hook.sh wait가 5분마다: 파일·폴더가 있으면 뺌
//   contains:<경로>|<글자>    같은 방식: 파일에 그 글자가 들어 있으면 뺌
export const validCheck = (c) => (c == null || c === '' ? null : /^(hub:seen:[^\s]{1,60}|exists:[^\t\n]{1,500}|contains:[^\t\n|]{1,500}\|[^\t\n]{1,500})$/.test(String(c)) ? String(c) : false);
// 세션 이름 자동: 켜진 폴더로 "[컴퓨터] 폴더"(앞 번호 '04-' 떼고, worktree 안이면 저장소 이름). 손으로 정한 이름·배운 RC 제목이 먼저
export function autoName(machine, cwd) {
  if (!cwd) return null;
  const parts = String(cwd).replace(/\\/g, '/').replace(/\/\.claude\/worktrees\/.*$/, '').split('/').filter((p) => p && !/^[a-z]:$/i.test(p));
  const last = (parts.pop() || '').replace(/^\d+[-_.]/, '');
  // 홈 폴더(/root, /home/<나>, /Users/<나>, C:\Users\<나>)에서 연 세션은 "[컴퓨터] 홈"(같은 이름이 둘이면 화면이 id 앞 4자리를 붙임)
  if (!last || parts.length === 0 || (parts.length === 1 && /^(home|users)$/i.test(parts[0]))) return `[${machine}] 홈`;
  return `[${machine}] ${/^(ai-hub-)?pm$/i.test(last) ? 'PM' : last}`.slice(0, 80); // 'pm' 폴더(aihub session add --role pm 기본) → "[컴퓨터] PM"(허브가 PM으로 알아봄)
}
// 파일 서버 경로: 'a/b.mp4'처럼 상대 경로만. 빈 칸·.·..·절대경로·NUL은 거절
export function safeRel(rel) {
  if (!rel || rel.length > 300 || rel.includes('\0') || rel.includes('\\')) return null;
  return rel.split('/').every((s) => s && s !== '.' && s !== '..') ? rel : null;
}
// Range 헤더 → [시작, 끝] / 없으면 null / 범위 밖이면 false. 한 구간만(브라우저 영상 미리보기는 이걸로 충분)
export function byteRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(h || '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const start = m[1] === '' ? Math.max(0, size - +m[2]) : +m[1];
  const end = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], size - 1) : size - 1;
  return start > end || start >= size ? false : [start, end];
}
const human = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${Math.round(n / 1024)}KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1073741824).toFixed(2)}GB`);

// Claude Code가 프롬프트에 붙이는 시스템 태그(알림·리마인더·슬래시 명령 흔적)를 지움. 화면(app.js)도 같은 걸 함
const SYS = '(?:task-notification|system-reminder|local-command-[\\w-]+|command-[\\w-]+)';
export const stripSys = (t) => String(t || '')
  .replace(new RegExp(`<(${SYS})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g'), '')
  .replace(new RegExp(`</?${SYS}\\b[^>]*>`, 'g'), '').trim();

// Claude Code hook 입력(JSON 그대로)을 이벤트로 바꿈. 다른 세션에서 온 메시지는 receive(to = 보낸 세션 이름)
export function fromHook(h, machine, name) {
  const base = { machine, name, session: h.session_id || 'unknown', cwd: h.cwd, model: typeof h.model === 'string' ? h.model : h.model?.id, usage: h.hub_usage };
  switch (h.hook_event_name) {
    case 'SessionStart': return { ...base, type: 'heartbeat', text: h.source ? `시작(${h.source})` : null };
    case 'UserPromptSubmit': {
      const p = String(h.prompt || '');
      const m = p.match(/<cross-session-message[^>]*?from-name="([^"]*)"[^>]*>\s*([\s\S]*?)(?:<\/cross-session-message>|$)/);
      if (m) return { ...base, type: 'receive', to: m[1], text: m[2].trim() };
      // 허브에서 보낸 지시가 hook wait로 들어온 것: 대화창엔 이미 ask로 떴으니 '일하는 중'만
      const hub = p.match(/\[AI 허브에서 사용자가 보낸 지시\]\s*([^\n<]*)/);
      if (hub) return { ...base, type: 'busy', text: '허브 지시 받음: ' + hub[1].trim() };
      const clean = stripSys(p);
      return clean ? { ...base, type: 'prompt', text: clean } : { ...base, type: 'busy' };
    }
    case 'PostToolUse':
      if (h.tool_name === 'SendMessage') return { ...base, type: 'send', to: h.tool_input?.to, text: h.tool_input?.message || h.tool_input?.summary };
      return { ...base, type: 'busy' }; // 도구를 쓰는 중 = 일하는 중(일하다 중간에 받은 메시지는 UserPromptSubmit이 안 옴)
    case 'Stop': return h.last_assistant_message ? { ...base, type: 'reply', text: h.last_assistant_message } : { ...base, type: 'idle' }; // hub-hook.sh가 transcript에서 마지막 답을 붙여 보냄
    case 'SessionEnd': return { ...base, type: 'stop', text: h.reason || null };
    default: return null;
  }
}

if (process.argv[2] === 'selftest') {
  const assert = (await import('node:assert')).strict;
  assert.equal(fromHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '안녕' }, 'pc').type, 'prompt');
  const r = fromHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<cross-session-message from="bridge:x" from-name="맥 세션" from-mode="p">\n일 넘김\n</cross-session-message>\n뒤' }, 'pc');
  assert.deepEqual([r.type, r.to, r.text], ['receive', '맥 세션', '일 넘김']);
  const s = fromHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'SendMessage', tool_input: { to: '서버', message: 'm' } }, 'pc');
  assert.deepEqual([s.type, s.to, s.text], ['send', '서버', 'm']);
  assert.equal(fromHook({ hook_event_name: 'Notification' }, 'pc'), null);
  assert.equal(fromHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash' }, 'pc').type, 'busy');
  const rp = fromHook({ hook_event_name: 'Stop', session_id: 's', last_assistant_message: '끝' }, 'pc');
  assert.deepEqual([rp.type, rp.text], ['reply', '끝']);
  assert.equal(fromHook({ hook_event_name: 'Stop', session_id: 's' }, 'pc').type, 'idle');
  const hw = fromHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<task-notification><summary>Stop hook feedback</summary></task-notification><system-reminder>Stop hook blocking error from command "Stop": [AI 허브에서 사용자가 보낸 지시] 테스트 메세지 </system-reminder>' }, 'pc');
  assert.deepEqual([hw.type, hw.text], ['busy', '허브 지시 받음: 테스트 메세지']);
  assert.equal(fromHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<system-reminder>x</system-reminder>' }, 'pc').type, 'busy');
  assert.equal(fromHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '<command-name>/compact</command-name>\n<local-command-stdout>ok</local-command-stdout>\n배포해' }, 'pc').text, '배포해');
  for (const bad of ['', '..', 'a/../b', '/abs', 'a//b', './a', 'a\0b']) assert.equal(safeRel(bad), null, bad);
  assert.equal(safeRel('영상/최종 v2.mp4'), '영상/최종 v2.mp4');
  assert.deepEqual(byteRange('bytes=0-99', 1000), [0, 99]);
  assert.deepEqual(byteRange('bytes=900-', 1000), [900, 999]);
  assert.deepEqual(byteRange('bytes=-100', 1000), [900, 999]);
  assert.deepEqual(byteRange('bytes=0-5000', 1000), [0, 999]);
  assert.equal(byteRange('bytes=2000-', 1000), false);
  assert.equal(byteRange(undefined, 1000), null);
  assert.equal(autoName('server', '/srv/work/04-video'), '[server] video');
  assert.equal(autoName('server', '/srv/work/my-app/.claude/worktrees/build'), '[server] my-app');
  assert.equal(autoName('pc', 'C:\\Users\\alice\\aihub\\pm'), '[pc] PM');
  assert.equal(autoName('mac', '/Users/alice/code/01-shop'), '[mac] shop');
  assert.equal(autoName('server', '/root'), '[server] 홈');
  assert.equal(autoName('pc', 'C:\\Users\\alice'), '[pc] 홈');
  assert.equal(autoName('server', '/home/alice'), '[server] 홈');
  assert.equal(validCheck('hub:seen:pc'), 'hub:seen:pc');
  assert.equal(validCheck('contains:~/.claude/settings.json|hub-hook.sh'), 'contains:~/.claude/settings.json|hub-hook.sh');
  assert.equal(validCheck('exists:/tmp/x'), 'exists:/tmp/x');
  for (const bad of ['rm -rf /', 'test -d /tmp', 'contains:nofile', 'exists:a\nb']) assert.equal(validCheck(bad), false, bad);
  assert.equal(validCheck(''), null);
  console.log('selftest ok'); process.exit(0);
}
if (!VIEW_PASSWORD || !EVENT_TOKEN || !COOKIE_SECRET) { console.error('VIEW_PASSWORD, EVENT_TOKEN, COOKIE_SECRET 필요 — `aihub init`이 .env를 만들어 줍니다'); process.exit(1); }

fs.mkdirSync(path.dirname(path.resolve(process.env.DB_PATH || 'data/hub.db')), { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || 'data/hub.db');
db.exec(`create table if not exists events(id integer primary key, ts integer not null, machine text not null, session text not null,
  name text, type text not null, to_name text, text text); create index if not exists ev_ts on events(ts)`);
// ref: 이 이벤트가 어느 요청에 대한 것인지(답 → 지시, 받은 메시지 → 보낸 메시지). 화면이 요청·답 짝을 그림
if (!db.prepare("select 1 from pragma_table_info('events') where name = 'ref'").get()) db.exec('alter table events add column ref integer');
const insert = db.prepare('insert into events(ts,machine,session,name,type,to_name,text,ref) values(?,?,?,?,?,?,?,?)');
const prune = () => db.prepare('delete from events where ts < ?').run(Date.now() - KEEP_DAYS * 864e5);
prune(); setInterval(prune, 3600e3).unref();
// 허브에서 세션에 보낸 지시: 세션의 hub-hook.sh wait 가 /api/inbox 를 롱폴로 받아 감(받으면 delivered)
db.exec('create table if not exists asks(id integer primary key, ts integer not null, session text not null, text text not null, delivered integer)');
if (!db.prepare("select 1 from pragma_table_info('asks') where name = 'event_id'").get()) db.exec('alter table asks add column event_id integer');
const waiters = new Map(); // session -> [res]
function takeAsk(session) {
  const a = db.prepare('select * from asks where session = ? and delivered is null order by id limit 1').get(session);
  if (!a) return null;
  db.prepare('update asks set delivered = ? where id = ?').run(Date.now(), a.id);
  return a;
}
// 파일 서버: 파일은 FILES_DIR(기본 DB 옆 files/), 누가 언제 올렸는지는 files 표
const FILES = path.resolve(process.env.FILES_DIR || path.join(path.dirname(process.env.DB_PATH || 'data/hub.db'), 'files'));
fs.mkdirSync(FILES, { recursive: true });
db.exec('create table if not exists files(path text primary key, size integer not null, ts integer not null, machine text, session text)');
const row = (r) => ({ id: r.id, ts: r.ts, machine: r.machine, session: r.session, name: r.name, type: r.type, to: r.to_name, text: r.text, ref: r.ref ?? null });

// 세션 상태(메모리): 키 = machine/session. 켤 때 최근 7일 이벤트로 다시 만듦
const sessions = new Map();
const recentSends = []; // 이름 배우기용: 최근 2분 send
function apply(e) {
  const k = `${e.machine}/${e.session}`;
  const s = sessions.get(k) || { key: k, machine: e.machine, session: e.session, name: null, aliases: [], state: 'idle', last: 0, doing: '', acted: false };
  if (e.name) s.name = e.name;
  // 별칭은 다른 세션이 이미 쓰는 이름이면 안 배움(같은 이름이 두 카드에 붙으면 먼저 찾은 쪽으로 엉뚱하게 감)
  const alias = (x, n) => {
    if (!x || !n || x.aliases.includes(n)) return;
    for (const o of sessions.values()) if (o !== x && (o.name === n || o.aliases.includes(n))) return;
    x.aliases.push(n);
  };
  // hook은 Remote Control 세션 제목을 모름 → A가 send하고 2분 안에 B가 receive(from-name=F)하면 A 이름=F, B 이름=A가 적은 받는 이름
  if (e.type === 'send') { recentSends.push({ ...e, key: k }); while (recentSends.length && recentSends[0].ts < e.ts - 120e3) recentSends.shift(); }
  if (e.type === 'receive') {
    // 같은 글이어야 짝으로 봄(여러 메시지가 2분 안에 오가면 시간만으로는 엉뚱한 세션끼리 이름을 주고받았음)
    const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    // 같은 글을 여러 세션에 한꺼번에 보냈으면(PM의 "[PM → 전체]") 받는 이름이 이 세션 것인 send를 고르고, 못 고르면 이름은 안 배움
    const cands = e.text ? [...recentSends].reverse().filter((x) => x.key !== k && x.ts >= e.ts - 120e3 && x.text && norm(x.text) === norm(e.text)) : [];
    const mine = cands.find((x) => x.to && (x.to === s.name || s.aliases.includes(x.to)));
    const snd = mine || (new Set(cands.map((x) => x.to)).size <= 1 ? cands[0] : null);
    if (!snd && cands.length && e.ref == null) e.ref = cands[0].id; // 짝(ref)은 같은 글이면 어느 쪽이든 같은 요청이라 첫 것으로
    if (snd) {
      const from = sessions.get(snd.key);
      if (from && !from.name && e.to) from.name = e.to;
      if (!s.name && snd.to && !/^bridge:/.test(snd.to)) s.name = snd.to;
      alias(from, e.to); alias(s, snd.to); // 같은 세션을 부르는 다른 이름(RC 제목·bridge id)도 기억 → 화면에서 유령 카드 대신 이 카드로
      recentSends.splice(recentSends.indexOf(snd), 1);
      if (e.ref == null && snd.id) e.ref = snd.id; // 받은 메시지 → 보낸 메시지(맡김 → 그 일의 보고로 이어짐)
    }
  }
  // 지금 하고 있는 요청: 사용자가 친 지시·허브 지시가 전달된 때·다른 세션에서 받은 메시지. Claude는 한 번에 하나씩 하니 그 뒤 답·보낸 메시지는 이 요청 것
  if (e.type === 'prompt' || e.type === 'receive') s.curReq = e.id;
  if (e.type === 'busy' && e.ref) s.curReq = e.ref;
  // 설명이 없을 때 쓸 첫 지시
  if (!s.first && e.text && (e.type === 'prompt' || e.type === 'ask' || e.type === 'receive')) s.first = stripSys(e.text).split('\n').find((l) => l.trim())?.trim().slice(0, 40) || null;
  if (e.type !== 'ask') s.last = Math.max(s.last, e.ts); // 허브가 보낸 지시는 그 세션의 활동이 아님(대기 끊김 판단이 흐려짐)
  if (e.type === 'prompt' || e.type === 'busy' || e.type === 'receive') s.state = 'busy';
  else if (e.type === 'idle' || e.type === 'reply') s.state = 'idle';
  else if (e.type === 'stop') s.state = 'offline';
  else if (s.state === 'offline') s.state = 'idle';
  if (e.text && (e.type === 'prompt' || e.type === 'receive' || e.type === 'busy')) s.doing = e.text.split('\n')[0];
  if (!['heartbeat', 'stop', 'idle'].includes(e.type)) s.acted = true; // 한 번이라도 일한 세션. 데몬이 미리 띄워 둔 예비 세션은 켜졌다 꺼질 뿐이라 false → 화면에서 숨김
  sessions.set(k, s);
  return s;
}
// 세션 상태: 훅 이벤트만으로는 쉬는 세션이 살아 있는지 모름 → wait 훅의 inbox 롱폴(60초마다)을 심장 박동으로 씀
//  idle/busy = 지시 받을 수 있음(최근 롱폴, 또는 방금 일함) · asleep = 대기 끊김(세션은 있는데 롱폴이 끊겨 지시를 못 받음, 깨워야 함)
//  offline = SessionEnd가 왔거나 하루 넘게 아무 신호 없음
const BOOT = Date.now(), POLL_MS = +process.env.POLL_MS || 180e3, GRACE_MS = +process.env.GRACE_MS || 600e3, BOOT_MS = +process.env.BOOT_MS || 120e3; // 테스트에서만 줄여 씀
function stateOf(s) {
  const now = Date.now(), seen = Math.max(s.last, s.polled || 0);
  if (s.state === 'offline') return 'offline';
  if (waiters.get(s.session)?.length || now - (s.polled || 0) < POLL_MS) return s.state; // 지금 기다리는 중
  if (now - s.last < (s.state === 'busy' ? OFFLINE_MS : GRACE_MS)) return s.state; // 일하는 중이거나 막 끝남(곧 wait가 붙음)
  if (now - BOOT < BOOT_MS && s.state === 'idle') return 'idle'; // 서버를 막 켰을 땐 롱폴이 다시 붙을 때까지 기다려 줌
  return now - seen < 864e5 ? 'asleep' : 'offline';
}
const view = (s) => ({ ...s, name: s.name || s.auto || null, desc: s.descManual || s.descSelf || s.first || null, descSrc: s.descManual ? 'manual' : s.descSelf ? 'self' : s.first ? 'first' : null, state: stateOf(s) });
const broadcastSessions = () => broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view) });
// 시간이 지나 바뀌는 상태(쉬는 중 → 대기 끊김 → 끊김)는 이벤트가 없어도 화면에 알려 줌
let lastStates = '';
setInterval(() => { const st = [...sessions.values()].map((x) => x.key + stateOf(x)).join('|'); if (st !== lastStates) { lastStates = st; broadcastSessions(); } }, 30e3).unref?.();
// 대기 끊김 세션 깨우기: 서버는 PM 받은편지함에 고정 형식 지시 하나만 넣음(PM이 대상마다 SendMessage로 고정 문구를 보냄).
// PM 자신이 끊겼으면 다른 훅 세션이 깨우거나, `aihub session wake`(claude --bg --resume)로 깨우면 받아 감. 같은 대상은 10분에 한 번
const hubLabel = (x) => x.name || x.auto || x.key;
const safeName = (n) => String(n || '').replace(/["\r\n\\]/g, ' ').slice(0, 40).trim(); // 이름은 배운 별칭일 수 있어 지시 글에 그대로 안 넣음
const isPMs = (x) => /\bPM\b/.test(hubLabel(x)) && !(hidden[x.key] > Date.now()); // 영구 숨김(옛 PM)은 깨우기 대상 PM으로 안 씀
function wakeMany(targets) {
  const now = Date.now(), todo = targets.filter((t) => stateOf(t) === 'asleep' && !(t.wakeTs && now - t.wakeTs < 600e3));
  const pm = [...sessions.values()].filter((x) => isPMs(x) && stateOf(x) !== 'offline').sort((a, b) => b.last - a.last)[0];
  if (!pm) return { waker: null, targets: [] };
  for (const t of todo) t.wakeTs = now;
  const pmAsleep = stateOf(pm) === 'asleep';
  let pmWaker = null;
  if (todo.includes(pm)) { // PM 자신: 지시를 받을 수 있는 다른 훅 세션(같은 컴퓨터 먼저)이 PM에게 고정 문구를 보내 깨움(claude CLI로는 bg 세션에 글을 못 보냄)
    pm.wakeReq = now;
    const h = [...sessions.values()].filter((x) => x !== pm && x.acted !== false && ['idle', 'busy'].includes(stateOf(x))).sort((a, b) => !!waiters.get(b.session)?.length - !!waiters.get(a.session)?.length || (b.machine === pm.machine) - (a.machine === pm.machine) || b.last - a.last)[0]; // 지금 기다리는 세션 → 같은 컴퓨터 → 최근
    if (h) {
      const text = `[허브 PM 깨우기] 대상: "${safeName(hubLabel(pm))}" 기기 ${safeName(pm.machine)} 세션 ${pm.session.slice(0, 8)}\nSendMessage로 그 PM에게 이 문구만 보내고 턴을 끝내세요: "허브 깨우기: 한 줄로 답하고 턴을 끝내세요." 다른 일은 하지 마세요.`;
      const aev = record({ machine: h.machine, session: h.session, type: 'ask', text });
      db.prepare('insert into asks(ts,session,text,event_id) values(?,?,?,?)').run(now, h.session, text, aev?.id ?? null);
      const r = waiters.get(h.session)?.shift(); if (r) deliver(r, h);
      pmWaker = hubLabel(h);
    }
  }
  const others = todo.filter((t) => t !== pm);
  if (others.length) {
    const list = others.map((t) => { const al = (t.aliases || []).map(safeName).filter((n) => n && n !== safeName(hubLabel(t))); return `"${safeName(hubLabel(t))}"${al.length ? `(다른 이름 ${al.map((n) => `"${n}"`).join(', ')})` : ''} 기기 ${safeName(t.machine)} 세션 ${t.session.slice(0, 8)}`; }).join(' / ');
    const text = `[허브 깨우기] 대상: ${list}\n각 대상에 SendMessage로 이 문구만 보내세요: "허브 깨우기: 한 줄로 답하고 턴을 끝내세요." 다른 일은 시키지 말고, 끝나면 깨운 대상만 한 줄로 알려 주세요.`;
    const aev = record({ machine: pm.machine, session: pm.session, type: 'ask', text });
    db.prepare('insert into asks(ts,session,text,event_id) values(?,?,?,?)').run(now, pm.session, text, aev?.id ?? null);
    const r = waiters.get(pm.session)?.shift(); if (r) deliver(r, pm);
  }
  broadcastSessions();
  return { waker: hubLabel(pm), pmAsleep, pmWaker, targets: todo.map(hubLabel) };
}
// 설치 확인용 세션('test', 'xxx-test')은 저장도 표시도 안 함
const isTest = (sid) => /(^|[-_])test$/i.test(String(sid || ''));
const TEST_SQL = "session != 'test' and session not like '%-test' and session not like '%\\_test' escape '\\'";
for (const r of db.prepare(`select * from events where ts > ? and type not in ('file', 'todo') and ${TEST_SQL} order by ts`).all(Date.now() - 7 * 864e5)) apply(row(r));
// 정리: 숨긴 카드(key → 숨긴 시각, 그 뒤 새 이벤트가 오면 다시 보임)와 손으로 붙인 별칭
db.exec('create table if not exists hidden(key text primary key, ts integer not null); create table if not exists aliases(key text not null, name text not null, primary key(key, name))');
const hidden = Object.fromEntries(db.prepare('select key, ts from hidden').all().map((r) => [r.key, r.ts]));
for (const a of db.prepare('select * from aliases').all()) { const s = sessions.get(a.key); if (s && !s.aliases.includes(a.name)) s.aliases.push(a.name); }
// 손으로 정한 화면 이름(이름 배우기보다 우선, 켤 때 다시 붙임)
db.exec('create table if not exists names(key text primary key, name text not null)');
const fixedNames = () => Object.fromEntries(db.prepare('select key, name from names').all().map((r) => [r.key, r.name]));
for (const [k, n] of Object.entries(fixedNames())) { const s = sessions.get(k); if (s) s.name = n; }
// 폴더로 붙인 자동 이름(이름이 없을 때만 화면에 씀)
db.exec('create table if not exists autonames(key text primary key, name text not null)');
for (const r of db.prepare('select key, name from autonames').all()) { const s = sessions.get(r.key); if (s) s.auto = r.name; }
// 세션 설명(이 세션이 무엇을 하려고 열렸나): manual = 허브 ✎, self = 세션이 스스로(hub-hook.sh desc, 폴더 CLAUDE.md 첫 제목)
db.exec('create table if not exists descs(key text primary key, manual text, self text)');
for (const r of db.prepare('select * from descs').all()) { const s = sessions.get(r.key); if (s) { s.descManual = r.manual || null; s.descSelf = r.self || null; } }
// 세션 모델: model = 세션이 지금 쓰는 것(훅이 알려 줌), want = 허브에서 고른 것(허브 앱이 띄운 세션은 앱이 그 모델로 다시 띄움, 맞춰지면 지움)
db.exec('create table if not exists models(key text primary key, model text, want text)');
for (const r of db.prepare('select * from models').all()) { const s = sessions.get(r.key); if (s) { s.model = r.model || null; s.wantModel = r.want || null; } }
const MODEL_RE = /^[a-z0-9][a-z0-9.\-[\]]{1,60}$/i; // claude-opus-5-5, opus, sonnet[1m] 같은 것만
const modelMatches = (cur, want) => !!cur && (cur === want || cur.includes(`-${want}-`) || cur.startsWith(`claude-${want}`));
function setModel(s, model) {
  if (!MODEL_RE.test(model || '') || model === '<synthetic>' || s.model === model) return false;
  s.model = model; if (!s.wantModel || modelMatches(model, s.wantModel)) s.wantModel = null;
  db.prepare('insert into models(key, model, want) values(?,?,?) on conflict(key) do update set model=excluded.model, want=excluded.want').run(s.key, s.model, s.wantModel || null);
  return true;
}
function setDesc(s, kind, d) {
  const v = str(String(d || '').trim(), 60);
  if (kind === 'manual') s.descManual = v; else s.descSelf = v;
  db.prepare(`insert into descs(key, ${kind}) values(?,?) on conflict(key) do update set ${kind}=excluded.${kind}`).run(s.key, v);
}

// 모델 바꿔 다시 띄우기: 허브 앱이 `claude --model X --resume <옛 id>`로 띄우면 같은 대화의 새 세션(새 id)이 옴.
// 옛 세션에 고른 모델(want)이 걸려 있고, 같은 컴퓨터·같은 폴더 이름(auto)의 새 세션이 켜지면 그 새 세션이 이어 받은 것으로 봄
function handoverFrom(s) {
  if (!s.auto) return null;
  return [...sessions.values()].find((o) => o !== s && o.machine === s.machine && o.auto === s.auto && o.wantModel) || null;
}
function handover(old, neu) {
  db.prepare('update asks set session = ? where session = ? and delivered is null').run(neu.session, old.session); // 아직 안 간 허브 지시
  db.prepare('update todos set session = ? where session = ? and done_ts is null').run(neu.session, old.session); // 열린 할 일(승인 결과가 새 세션으로)
  const nm = old.name && !neu.name ? old.name : null;
  if (nm) { neu.name = nm; db.prepare('insert into names(key,name) values(?,?) on conflict(key) do update set name=excluded.name').run(neu.key, nm); }
  for (const a of [...old.aliases, old.name].filter(Boolean)) if (!neu.aliases.includes(a)) { neu.aliases.push(a); db.prepare('insert or ignore into aliases(key,name) values(?,?)').run(neu.key, a); }
  if (old.descManual && !neu.descManual) setDesc(neu, 'manual', old.descManual);
  if (old.descSelf && !neu.descSelf) setDesc(neu, 'self', old.descSelf);
  neu.wantModel = neu.model && modelMatches(neu.model, old.wantModel) ? null : old.wantModel; // 새 모델이 아직 안 왔으면 첫 답 때 맞춰 지움
  db.prepare('insert into models(key, model, want) values(?,?,?) on conflict(key) do update set want=excluded.want').run(neu.key, neu.model || null, neu.wantModel || null);
  old.wantModel = null; old.state = 'offline';
  old.name = null; old.aliases = []; db.prepare('delete from names where key = ?').run(old.key); db.prepare('delete from aliases where key = ?').run(old.key); // 이름으로 오는 메시지는 새 세션으로
  db.prepare('update models set want = null where key = ?').run(old.key);
  broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view) });
}
// 토큰 사용량: hub-hook.sh가 Stop 때 그 턴의 합만 보냄(in·out·캐시 읽기 cr·캐시 쓰기 cw, ctx = 마지막 요청 입력 = 컨텍스트 크기)
db.exec('create table if not exists usage(ts integer not null, key text not null, model text, i integer, o integer, cr integer, cw integer, ctx integer)');
db.exec('create index if not exists usage_ts on usage(ts)');
// $/백만 토큰(API 기준, 구독은 실제 청구와 다름). 캐시 쓰기는 입력의 1.25배
const PRICE = { opus: [4, 20, 0.2, 5], sonnet: [2, 10, 0.1, 2.5], haiku: [0.1, 0.5, 0.01, 0.125], fable: [8, 40, 0.2, 10], mythos: [8, 40, 0.2, 10] };
const priceOf = (m) => PRICE[Object.keys(PRICE).find((k) => String(m || '').includes(k)) || 'opus'];
const costOf = (r) => { const [a, b, c, d] = priceOf(r.model); return (r.i * a + r.o * b + r.cr * c + r.cw * d) / 1e6; };
function saveUsage(s, u, model) {
  const n = (v) => { if (v == null) return 0; const x = Number(v); return Number.isFinite(x) && x >= 0 && x <= 1e9 ? Math.round(x) : NaN; }; // 이상한 값(글자·음수·10억 넘음)이면 그 줄 버림
  if (!u || typeof u !== 'object') return;
  const row = { i: n(u.in), o: n(u.out), cr: n(u.cr), cw: n(u.cw), ctx: n(u.ctx) };
  if (Object.values(row).some(Number.isNaN) || (!row.i && !row.o && !row.cr && !row.cw)) return;
  db.prepare('insert into usage(ts,key,model,i,o,cr,cw,ctx) values(?,?,?,?,?,?,?,?)').run(Date.now(), s.key, model || s.model || null, row.i, row.o, row.cr, row.cw, row.ctx);
  s.ctx = row.ctx;
}
function usageSummary() {
  const now = Date.now(), today = new Date(now).setHours(0, 0, 0, 0), week = now - 7 * 864e5; // '오늘' = 서버 시간대(TZ) 자정부터
  const rows = db.prepare('select * from usage where ts >= ?').all(Math.min(today, week));
  const by = new Map();
  for (const r of rows) {
    const x = by.get(r.key) || { key: r.key, today: { tok: 0, usd: 0 }, week: { tok: 0, usd: 0 }, ctx: 0, model: null, last: 0 };
    const tok = r.i + r.o + r.cr + r.cw, usd = costOf(r);
    x.week.tok += tok; x.week.usd += usd;
    if (r.ts >= today) { x.today.tok += tok; x.today.usd += usd; }
    if (r.ts >= x.last) { x.last = r.ts; x.ctx = r.ctx; x.model = r.model; }
    by.set(r.key, x);
  }
  const list = [...by.values()].sort((a, b) => b.today.usd - a.today.usd || b.week.usd - a.week.usd);
  const sum = (k) => list.reduce((t, x) => ({ tok: t.tok + x[k].tok, usd: t.usd + x[k].usd }), { tok: 0, usd: 0 });
  return { today: sum('today'), week: sum('week'), sessions: list, since: today };
}
function record(e) {
  if (!e || !str(e.machine) || !str(e.session) || !TYPES.has(e.type)) return null;
  if (isTest(e.session)) return { ok: true, ignored: 'test' };
  // 도구마다 오는 '일하는 중'은 이미 일하는 중이면 1분에 한 번만 저장
  const cur = sessions.get(`${e.machine}/${e.session}`);
  if (e.type === 'busy' && !e.text && cur?.state === 'busy' && Date.now() - cur.last < 60e3) { cur.last = Date.now(); return { ok: true }; }
  // 답·보낸 메시지는 그 세션이 지금 하고 있는 요청에 붙임(명시한 ref가 있으면 그것)
  const ref = Number.isInteger(e.ref) ? e.ref : (e.type === 'reply' || e.type === 'send') && cur?.curReq ? cur.curReq : null;
  const ev = { ts: Date.now(), machine: str(e.machine, 60), session: str(e.session, 80), name: str(e.name), type: e.type, to: str(e.to, 200), text: clip(e.text), ref };
  ev.id = Number(insert.run(ev.ts, ev.machine, ev.session, ev.name, ev.type, ev.to, ev.text, ev.ref).lastInsertRowid);
  const s = ev.type === 'file' || ev.type === 'todo' ? null : apply(ev); // 파일·할 일 알림은 세션 카드를 안 만듦
  if (ev.type === 'receive' && ev.ref && ev.ref !== ref) db.prepare('update events set ref = ? where id = ?').run(ev.ref, ev.id); // apply가 보낸 메시지와 짝지음
  if (s && e.model) setModel(s, String(e.model));
  if (s && e.usage && ev.type !== 'heartbeat') saveUsage(s, e.usage, e.model);
  if (s && e.desc && !s.descSelf) setDesc(s, 'self', e.desc); // 세션이 켜질 때 폴더 CLAUDE.md 첫 제목(hub-hook.sh가 보냄)
  if (s && e.cwd) { const an = autoName(ev.machine, e.cwd); if (an && s.auto !== an) { s.auto = an; db.prepare('insert into autonames(key,name) values(?,?) on conflict(key) do update set name=excluded.name').run(s.key, an); } }
  if (s && ev.type === 'heartbeat') { const old = handoverFrom(s); if (old) handover(old, s); }
  broadcast({ kind: 'event', event: ev, session: s ? view(s) : null });
  if (ev.type === 'receive') broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view) }); // 보낸 쪽 이름을 막 배웠을 수 있음
  return ev;
}

// 로그인 쿠키: 만료시각.HMAC
const sign = (exp) => `${exp}.${crypto.createHmac('sha256', COOKIE_SECRET).update(String(exp)).digest('base64url')}`;
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function authed(req) {
  const c = /(?:^|;\s*)hub=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!c) return false;
  const exp = c.split('.')[0];
  return +exp > Date.now() && eq(c, sign(exp));
}
// curl은 한글을 UTF-8 바이트 그대로 헤더에 실음(node는 latin1로 읽음) → 되돌림. %xx로 오면 그것도 풂
function header(req, h) {
  const v = req.headers[h]; if (!v) return null;
  try { return str(/%[0-9a-f]{2}/i.test(v) ? decodeURIComponent(v) : Buffer.from(String(v), 'latin1').toString('utf8'), 80); } catch { return str(v, 80); }
}
// 토큰: 처음 쓰던 공용 EVENT_TOKEN, 또는 기기마다 받은 토큰(join.sh로 붙이고 허브에서 승인 — 서버엔 해시만 둠)
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function bearer(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return false;
  if (eq(t, EVENT_TOKEN)) return true;
  const d = db.prepare('select id from devices where token_hash = ? and revoked is null').get(sha(t));
  if (d) db.prepare('update devices set last_seen = ? where id = ?').run(Date.now(), d.id);
  return !!d;
}

function send(res, code, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(code, { 'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(json ? JSON.stringify(body) : body);
}
function readBody(req, max = 256e3) {
  return new Promise((ok, no) => {
    let n = 0; const parts = [];
    req.on('data', (d) => { n += d.length; if (n > max) { no(new Error('too big')); req.destroy(); } else parts.push(d); });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', no);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, p) {
  const f = path.resolve(WEB, '.' + (p === '/' ? '/index.html' : p));
  if (!f.startsWith(WEB + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'not found');
  if (p.endsWith('.sh')) { // 훅·join 스크립트: 기본 주소를 이 허브 주소로 바꿔 줌(받은 기기가 AI_HUB_URL 없이도 여기로 붙게)
    res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(fs.readFileSync(f, 'utf8').replaceAll('http://localhost:4200', PUBLIC_URL));
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
}

let lastFail = 0;
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && p.startsWith('/s/')) return shortRedirect(res, p.slice(3)); // 짧은 공유 주소(로그인 없이)
    if (req.method === 'POST' && (p === '/api/event' || p === '/api/hook')) {
      if (!bearer(req)) return send(res, 401, { error: '토큰이 맞지 않음' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const e = p === '/api/hook' ? fromHook(body, header(req, 'x-hub-machine') || 'unknown', header(req, 'x-hub-name')) : body;
      if (e && p === '/api/hook' && body.hook_event_name === 'SessionStart' && req.headers['x-hub-desc']) e.desc = header(req, 'x-hub-desc');
      if (p === '/api/hook' && !e) return send(res, 204, '');
      return record(e) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'machine, session, type 필요' });
    }
    if (req.method === 'GET' && p === '/api/model-want') { // 허브 앱(토큰): ?session=<id> → {model, want}. want가 있으면 앱이 claude --model <want> --resume <id>로 다시 띄움
      if (!bearer(req)) return send(res, 401, { error: '토큰이 맞지 않음' });
      const sid = str(new URL(req.url, 'http://x').searchParams.get('session'), 80);
      const s = [...sessions.values()].find((x) => x.session === sid);
      return s ? send(res, 200, { key: s.key, model: s.model || null, want: s.wantModel || null }) : send(res, 404, { error: '없는 세션' });
    }
    if (req.method === 'GET' && p === '/api/pm-wake') { // PC 허브 앱(토큰)이 15초마다: ?session=<PM id> → {wake}. true면 앱이 PM을 한 턴 깨움(쌓인 지시를 받아 가게)
      if (!bearer(req)) return send(res, 401, { error: '토큰이 맞지 않음' });
      const sid = str(new URL(req.url, 'http://x').searchParams.get('session'), 80);
      const s = [...sessions.values()].find((x) => x.session === sid); if (!s) return send(res, 404, { error: '없는 세션' });
      const pending = db.prepare('select count(*) n from asks where session = ? and delivered is null').get(sid).n;
      const asleep = stateOf(s) === 'asleep';
      return send(res, 200, { state: stateOf(s), pending, wake: asleep && (pending > 0 || !!s.wakeReq) });
    }
    if (req.method === 'GET' && p === '/api/inbox') { // hook(토큰)이 롱폴: 지시가 있으면 내용(text/plain), 50초 동안 없으면 204
      if (!bearer(req)) return send(res, 401, { error: '토큰이 맞지 않음' });
      const sid = str(new URL(req.url, 'http://x').searchParams.get('session'), 80);
      if (!sid) return send(res, 400, { error: 'session 필요' });
      const s = [...sessions.values()].find((x) => x.session === sid) || { machine: header(req, 'x-hub-machine') || 'unknown', session: sid };
      if (sessions.has(s.key)) { const was = stateOf(s); s.polled = Date.now(); if (was === 'asleep') { s.wakeTs = 0; s.wakeReq = 0; s.wokeAt = Date.now(); broadcastSessions(); } } // 심장 박동(깨어나면 wokeAt)
      if (db.prepare('select 1 from asks where session = ? and delivered is null').get(sid)) return deliver(res, s);
      const list = waiters.get(sid) || []; list.push(res); waiters.set(sid, list);
      const t = setTimeout(() => { const l = waiters.get(sid) || []; const i = l.indexOf(res); if (i >= 0) { l.splice(i, 1); send(res, 204, ''); } }, 50e3);
      res.on('close', () => { clearTimeout(t); const l = waiters.get(sid) || []; const i = l.indexOf(res); if (i >= 0) l.splice(i, 1); });
      return;
    }
    if (p === '/api/files' || p.startsWith('/api/files/')) return await files(req, res, p);
    if (p === '/api/todos' || p.startsWith('/api/todos/')) return await todos(req, res, p);
    if (p === '/api/pair' || p.startsWith('/api/pair/')) return await pair(req, res, p);
    if (req.method === 'POST' && p === '/api/desc') { // 세션이 스스로 설명 등록(hub-hook.sh desc "…"): 그 컴퓨터에서 가장 최근에 일한 세션, 또는 {session}
      if (!bearer(req)) return send(res, 401, { error: '토큰이 맞지 않음' });
      const { desc, session } = JSON.parse((await readBody(req, 4e3)) || '{}');
      const machine = header(req, 'x-hub-machine') || 'unknown';
      const s = session ? sessions.get(`${machine}/${str(session, 80)}`) : [...sessions.values()].filter((x) => x.machine === machine && x.state !== 'offline').sort((a, b) => b.last - a.last)[0];
      if (!s) return send(res, 404, { error: '이 컴퓨터에 떠 있는 세션이 없음' });
      setDesc(s, 'self', desc);
      broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view) });
      return send(res, 200, { ok: true, key: s.key, desc: view(s).desc });
    }
    if (req.method === 'POST' && p === '/api/login') {
      if (Date.now() - lastFail < 1000) return send(res, 429, { error: '잠시 뒤 다시 입력하세요' });
      const { password } = JSON.parse((await readBody(req, 4e3)) || '{}');
      if (!eq(password || '', VIEW_PASSWORD)) { lastFail = Date.now(); return send(res, 401, { error: '비밀번호가 맞지 않습니다' }); }
      const exp = Date.now() + COOKIE_DAYS * 864e5;
      return send(res, 200, { ok: true }, { 'set-cookie': `hub=${sign(exp)}; Max-Age=${COOKIE_DAYS * 86400}; ${COOKIE_ATTR}` });
    }
    if (req.method === 'POST' && p === '/api/logout') return send(res, 200, { ok: true }, { 'set-cookie': `hub=; Max-Age=0; ${COOKIE_ATTR}` });
    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: '로그인 필요' });
      if (p === '/api/state') {
        const events = db.prepare(`select * from events where ts > ? and ${TEST_SQL} order by ts desc limit 3000`).all(Date.now() - 864e5).map(row).reverse();
        return send(res, 200, { now: Date.now(), sessions: [...sessions.values()].map(view), events, hidden });
      }
      if (p === '/api/usage') return send(res, 200, usageSummary()); // 세션별 오늘·7일 토큰과 추정 비용
      if (req.method === 'POST' && p === '/api/model') { // {key, want:'sonnet'|'' } 허브에서 모델 고르기(''이면 취소)
        const { key, want } = JSON.parse((await readBody(req, 4e3)) || '{}');
        const s = sessions.get(str(key, 300)); if (!s) return send(res, 404, { error: '없는 세션' });
        const w = want ? String(want) : null; if (w && !MODEL_RE.test(w)) return send(res, 400, { error: '모델 이름이 이상함' });
        s.wantModel = w && !modelMatches(s.model, w) ? w : null;
        db.prepare('insert into models(key, model, want) values(?,?,?) on conflict(key) do update set want=excluded.want').run(s.key, s.model || null, s.wantModel);
        broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view) });
        return send(res, 200, { ok: true, want: s.wantModel });
      }
      if (req.method === 'POST' && p === '/api/session') { // 정리: {key, hide:true|false} 숨기기/보이기, {key, alias:'이름'} 이 세션의 다른 이름
        const { key, hide, alias, name, desc } = JSON.parse((await readBody(req, 4e3)) || '{}');
        const k = str(key, 300); if (!k) return send(res, 400, { error: 'key 필요' });
        if (desc !== undefined) { const s = sessions.get(k); if (!s) return send(res, 404, { error: '없는 세션' }); setDesc(s, 'manual', desc); } // 설명(✎), ''이면 지움
        if (name) { // 화면 이름 정하기("[server] dev"). 옛 이름은 별칭으로 남겨 그 이름으로 온 메시지도 이 카드로
          const s = sessions.get(k), n = str(name, 120); if (!s) return send(res, 404, { error: '없는 세션' });
          if (s.name && s.name !== n && !s.aliases.includes(s.name)) { s.aliases.push(s.name); db.prepare('insert or ignore into aliases(key,name) values(?,?)').run(k, s.name); }
          s.name = n; db.prepare('insert into names(key,name) values(?,?) on conflict(key) do update set name=excluded.name').run(k, n);
        }
        if (hide === 'forever') { hidden[k] = 8.64e15; db.prepare('insert into hidden(key,ts) values(?,?) on conflict(key) do update set ts=excluded.ts').run(k, hidden[k]); } // 새 활동이 와도 안 보임(옮겨 간 옛 PM 등)
        if (hide === true) { hidden[k] = Date.now(); db.prepare('insert into hidden(key,ts) values(?,?) on conflict(key) do update set ts=excluded.ts').run(k, hidden[k]); }
        if (hide === false) { delete hidden[k]; db.prepare('delete from hidden where key = ?').run(k); }
        if (alias) {
          const s = sessions.get(k), n = str(alias, 200); if (!s) return send(res, 404, { error: '없는 세션' });
          if (!s.aliases.includes(n)) s.aliases.push(n);
          db.prepare('insert or ignore into aliases(key,name) values(?,?)').run(k, n);
        }
        broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view), hidden });
        return send(res, 200, { ok: true });
      }
      if (p === '/api/tools' && req.method === 'GET') return send(res, 200, { tools: db.prepare('select * from tools order by name').all() });
      if (p === '/api/tools' && req.method === 'POST') { // {id?, name, desc, how, example, links, target} — id가 있으면 고침
        const b = JSON.parse((await readBody(req, 64e3)) || '{}');
        const name = String(b.name || '').trim().replace(/\s+/g, '-').slice(0, 40); // @이름으로 부르려고 빈칸은 -
        if (!name || name.includes('@')) return send(res, 400, { error: '이름을 적어 주세요(@ 없이)' });
        const v = (k, n) => String(b[k] ?? '').trim().slice(0, n) || null;
        const row = [Date.now(), name, v('desc', 500), v('how', 8000), v('example', 4000), v('links', 2000), v('target', 300)];
        try {
          if (b.id) { if (!db.prepare('update tools set ts=?, name=?, desc=?, how=?, example=?, links=?, target=? where id = ?').run(...row, +b.id).changes) return send(res, 404, { error: '없는 도구' }); }
          else b.id = Number(db.prepare('insert into tools(ts, name, desc, how, example, links, target) values(?,?,?,?,?,?,?)').run(...row).lastInsertRowid);
        } catch (e) { if (/UNIQUE/.test(e.message)) return send(res, 409, { error: `같은 이름의 도구가 있어요: ${name}` }); throw e; }
        broadcast({ kind: 'tools' });
        return send(res, 200, { ok: true, id: +b.id, name });
      }
      const tm = /^\/api\/tools\/(\d+)$/.exec(p);
      if (tm && req.method === 'DELETE') {
        if (!db.prepare('delete from tools where id = ?').run(+tm[1]).changes) return send(res, 404, { error: '없는 도구' });
        broadcast({ kind: 'tools' }); return send(res, 200, { ok: true });
      }
      if (p === '/api/me') return send(res, 200, { ok: true, version: VERSION });
      if (req.method === 'POST' && p === '/api/ask') {
        const { to, text, ref } = JSON.parse((await readBody(req, 64e3)) || '{}');
        const s = sessions.get(String(to || '')), t = String(text || '').trim();
        if (!s || !t) return send(res, 400, { error: '보낼 세션과 내용을 고르세요' });
        const slept = stateOf(s) === 'asleep';
        const aev = record({ machine: s.machine, session: s.session, type: 'ask', text: t, ref: Number.isInteger(ref) && ref > 0 ? ref : undefined }); // ref = 추가 요청이면 원래 일
        db.prepare('insert into asks(ts,session,text,event_id) values(?,?,?,?)').run(Date.now(), s.session, t.slice(0, 8000), aev?.id ?? null);
        const w = waiters.get(s.session)?.shift(); if (w) deliver(w, s);
        if (!w && slept) return send(res, 200, { ok: true, waiting: true, asleep: true, ...wakeMany([s]) }); // 쌓아 두고 깨우기 부탁
        return send(res, 200, { ok: true, waiting: !w });
      }
      if (req.method === 'POST' && p === '/api/wake') { // 카드 '깨우기' {key} · '전체 깨우기' {all:true}
        const { key, all } = JSON.parse((await readBody(req, 4e3)) || '{}');
        const list = all ? [...sessions.values()].filter((x) => x.acted !== false && stateOf(x) === 'asleep') /* 일 안 한 예비 세션은 안 깨움 */ : [sessions.get(String(key || ''))].filter(Boolean);
        if (!all && !list.length) return send(res, 404, { error: '없는 세션' });
        if (!list.some((x) => stateOf(x) === 'asleep')) return send(res, 200, { ok: true, awake: true, targets: [] });
        return send(res, 200, { ok: true, ...wakeMany(list) });
      }
      return send(res, 404, { error: '없는 주소' });
    }
    if (req.method === 'GET') return serveStatic(res, p);
    send(res, 405, 'method not allowed');
  } catch (err) {
    send(res, 400, { error: String(err.message || err) });
  }
});

// 파일 서버: 토큰(hub-file.sh) 또는 로그인 쿠키(화면). 목록 GET /api/files?prefix=, 받기 GET(Range)·올리기 PUT·지우기 DELETE /api/files/<경로>
const FMIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.pdf': 'application/pdf',
  '.json': 'application/json' };
// 글·코드는 전부 text/plain으로(올린 html·js가 이 주소에서 페이지·스크립트로 돌지 않게, 화면 보기에서는 글자로 보임)
for (const x of 'txt md srt vtt log csv js mjs cjs ts tsx jsx py sh rs go java kt swift c h cpp css html xml yml yaml toml sql'.split(' ')) FMIME['.' + x] = 'text/plain; charset=utf-8';
const ATTACH_MAX = 50 * 1048576, ATTACH_EXT = /^\.(png|jpe?g|gif|webp|pdf|txt|md|json|csv|log|ya?ml|js|ts|py|sh|html|css|zip|mp4)$/i;
// 공유 링크: 로그인 없이 그 파일 하나만, 기한(최대 7일)까지 받기. sig = HMAC(쿠키 비밀, 경로·기한) — 경로나 기한을 바꾸면 안 맞음
const shareSig = (rel, exp) => crypto.createHmac('sha256', COOKIE_SECRET).update(`share:${rel}:${exp}`).digest('base64url');
function sharedOk(req, p, q) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const exp = +q.get('exp'), sig = q.get('sig'); if (!exp || !sig || exp < Date.now()) return false;
  let rel; try { rel = safeRel(decodeURIComponent(p.slice('/api/files/'.length))); } catch { return false; }
  return !!rel && eq(sig, shareSig(rel, exp));
}
// 옮긴 파일·폴더의 옛 경로 → 새 경로(대화 기록·보고에 적힌 옛 주소가 계속 열리고, 옛 경로로 올려도 새 자리로 감). 폴더는 '/'로 끝남
db.exec('create table if not exists file_moves(old text primary key, new text not null)');
function mapOld(rel) {
  for (const m of db.prepare('select * from file_moves order by length(old) desc').all())
    if (rel === m.old || (m.old.endsWith('/') && rel.startsWith(m.old))) return m.new + rel.slice(m.old.length);
  return rel;
}
// 옮기기: {move:{from, to}} — 둘 다 폴더('/'로 끝남)거나 둘 다 파일. 같은 이름이 이미 있으면 건너뜀(덮어쓰지 않음)
function moveFiles(from, to, who) {
  const a = safeRel(from.replace(/\/$/, '')), b = safeRel(to.replace(/\/$/, ''));
  if (!a || !b || from.endsWith('/') !== to.endsWith('/')) return { error: '경로가 올바르지 않음(폴더면 둘 다 /로 끝나게)' };
  const F = from.endsWith('/') ? a + '/' : a, T = to.endsWith('/') ? b + '/' : b;
  if (F === T || (F.endsWith('/') && T.startsWith(F))) return { error: '같은 자리나 자기 폴더 안으로는 못 옮김' };
  const list = F.endsWith('/') ? db.prepare('select path from files where substr(path, 1, length(?)) = ?').all(F, F) : db.prepare('select path from files where path = ?').all(F);
  const moved = [], skipped = [];
  for (const { path: src } of list) {
    const dst = T + src.slice(F.length), fd = path.join(FILES, dst);
    if (db.prepare('select 1 from files where path = ?').get(dst) || fs.existsSync(fd)) { skipped.push(src); continue; }
    if (!fs.existsSync(path.join(FILES, src))) { skipped.push(src); continue; } // 목록에만 있고 파일이 없음
    fs.mkdirSync(path.dirname(fd), { recursive: true });
    fs.renameSync(path.join(FILES, src), fd);
    db.prepare('update files set path = ? where path = ?').run(dst, src);
    moved.push(dst);
  }
  if (moved.length || !list.length) db.prepare('insert into file_moves(old, new) values(?,?) on conflict(old) do update set new=excluded.new').run(F, T);
  record({ ...who, type: 'file', to: T, text: `옮김: ${F} → ${T} (${moved.length}개${skipped.length ? `, 이미 있어 건너뜀 ${skipped.length}` : ''})` });
  return { ok: true, moved: moved.length, skipped };
}
// 짧은 공유 주소: <SHORT_URL>/s/<7자> → 공개 공유 링크(로그인 없이 받기)로 넘김. 기한은 공유 링크와 같음
const SHORT_BASE = (process.env.SHORT_URL || PUBLIC_URL).replace(/\/$/, ''); // 짧은 도메인을 따로 두면 그 도메인의 /s/ 를 이 서버로 프록시
db.exec('create table if not exists shortlinks(code text primary key, link text not null, exp integer not null, path text)');
const B62 = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 0·O·1·l·I 뺌
function makeShort(link, exp, rel) {
  db.prepare('delete from shortlinks where exp < ?').run(Date.now() - 7 * 864e5); // 지난 지 7일 넘은 건 정리
  for (;;) {
    const code = Array.from(crypto.randomBytes(7), (b) => B62[b % B62.length]).join('');
    try { db.prepare('insert into shortlinks(code, link, exp, path) values(?,?,?,?)').run(code, link, exp, rel); return code; } catch { /* 겹치면 다시 */ }
  }
}
const SHORT_PAGE = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1b1029;color:#f4ecff;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px"><div><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p style="margin:0;color:#b9a9cc">${msg}</p></div></body>`;
function shortRedirect(res, code) {
  const r = /^[A-Za-z0-9]{6,8}$/.test(code) ? db.prepare('select * from shortlinks where code = ?').get(code) : null;
  const html = (c, t, m) => { res.writeHead(c, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(SHORT_PAGE(t, m)); };
  if (!r) return html(404, '없는 링크예요', '주소를 다시 확인하거나, 보낸 사람에게 새 링크를 받아 주세요.');
  if (r.exp < Date.now()) return html(410, '기한이 지난 링크예요', `이 링크는 ${new Date(r.exp).toLocaleString('ko-KR')}까지였어요. 보낸 사람에게 새 링크를 받아 주세요.`);
  res.writeHead(302, { location: `${PUBLIC_URL}/api/files/${r.link}`, 'cache-control': 'no-store' }); res.end();
}
async function files(req, res, p) {
  const q = new URL(req.url, 'http://x').searchParams;
  const byToken = bearer(req), shared = !byToken && p.startsWith('/api/files/') && sharedOk(req, p, q);
  if (!byToken && !shared && !authed(req)) return send(res, 401, { error: q.get('sig') ? '공유 링크 기한이 지났거나 맞지 않음' : '로그인 또는 토큰 필요' });
  if (p === '/api/files' && req.method === 'POST' && !shared) { // 옮기기
    const { move } = JSON.parse((await readBody(req, 4e3)) || '{}');
    if (!move?.from || !move?.to) return send(res, 400, { error: '{move:{from, to}} 필요' });
    const who = byToken ? { machine: header(req, 'x-hub-machine') || 'unknown', session: 'files' } : { machine: '나', session: 'web' };
    const r = moveFiles(String(move.from), String(move.to), who);
    return send(res, r.error ? 400 : 200, r);
  }
  if (p === '/api/files') {
    if (req.method !== 'GET') return send(res, 405, { error: '목록은 GET' });
    const pre = mapOld(q.get('prefix') || '');
    const list = db.prepare('select * from files where substr(path, 1, length(?)) = ? order by ts desc limit 2000').all(pre, pre);
    if (q.get('txt')) return send(res, 200, list.map((f) => `${human(f.size).padStart(8)}  ${new Date(f.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${(f.machine || '').padEnd(6)}  ${f.path}`).join('\n') + (list.length ? '\n' : ''));
    return send(res, 200, { files: list });
  }
  let rel; try { rel = safeRel(decodeURIComponent(p.slice('/api/files/'.length))); } catch { rel = null; }
  if (!rel) return send(res, 400, { error: '파일 경로가 올바르지 않음(상대 경로, .. 금지)' });
  { const m = mapOld(rel); if (m !== rel && !((req.method === 'GET' || req.method === 'HEAD') && !fs.existsSync(path.join(FILES, m)) && fs.existsSync(path.join(FILES, rel)))) rel = m; } // 옮긴 옛 경로면 새 자리(새 자리에 없고 옛 자리에 남아 있으면 옛 것). 공유 링크 서명은 위에서 원래 경로로 확인
  const f = path.join(FILES, rel);
  const who = byToken ? { machine: header(req, 'x-hub-machine') || 'unknown', session: header(req, 'x-hub-session') || 'files' } : { machine: '나', session: 'web' };
  const note = (text) => record({ ...who, type: 'file', to: rel, text });

  if (req.method === 'GET' || req.method === 'HEAD') {
    let st; try { st = fs.statSync(f); } catch { return send(res, 404, { error: '없는 파일' }); }
    if (!st.isFile()) return send(res, 404, { error: '없는 파일' });
    const type = FMIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';
    const h = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff',
      // 올린 svg 등이 이 주소에서 스크립트로 돌지 않게. PDF는 sandbox면 브라우저 내장 보기가 막혀서 빼 줌
      ...(type === 'application/pdf' ? {} : { 'content-security-policy': 'sandbox' }),
      'content-disposition': `${q.get('dl') || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(rel))}` };
    const r = byteRange(req.headers.range, st.size);
    if (r === false) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    if (r) res.writeHead(206, { ...h, 'content-range': `bytes ${r[0]}-${r[1]}/${st.size}`, 'content-length': r[1] - r[0] + 1 });
    else res.writeHead(200, { ...h, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(f, r ? { start: r[0], end: r[1] } : {}), res).catch(() => {});
  }
  if (req.method === 'POST' && q.get('share') != null) { // 공유 링크 만들기(토큰·로그인만): ?share=시간(기본 24, 최대 168)
    if (shared) return send(res, 403, { error: '공유 링크로는 못 만듦' });
    let st; try { st = fs.statSync(f); } catch { return send(res, 404, { error: '없는 파일' }); }
    if (!st.isFile()) return send(res, 404, { error: '없는 파일' });
    const hours = Math.min(168, Math.max(1, +q.get('share') || 24)), exp = Date.now() + hours * 3600e3;
    const link = `${rel.split('/').map(encodeURIComponent).join('/')}?dl=1&exp=${exp}&sig=${shareSig(rel, exp)}`;
    note(`공유 링크 만듦(${hours}시간): ${rel}`);
    const short = makeShort(link, exp, rel); // 짧은 주소 <SHORT_URL>/s/<코드>
    return send(res, 200, { ok: true, link, short, shortUrl: `${SHORT_BASE}/s/${short}`, expires: new Date(exp).toISOString() }); // link는 /api/files/ 뒤에 붙는 부분(앞 주소는 부르는 쪽이 앎)
  }
  if (req.method === 'PUT') {
    // 대화 첨부(첨부/…)는 파일당 50MB·정한 형식만. 그 밖의 파일 서버는 제한 없음(큰 영상·빌드 결과용)
    if (rel.startsWith('첨부/')) {
      if (!ATTACH_EXT.test(path.extname(rel))) return send(res, 415, { error: '첨부는 이미지·PDF·글·코드·zip·mp4만 됩니다' });
      if (!(+req.headers['content-length'] <= ATTACH_MAX)) return send(res, 413, { error: '첨부는 파일당 50MB까지입니다' });
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.part-${crypto.randomBytes(4).toString('hex')}`;
    try { await pipeline(req, fs.createWriteStream(tmp)); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    if (req.headers['content-length'] && fs.statSync(tmp).size !== +req.headers['content-length']) { fs.rmSync(tmp, { force: true }); return send(res, 400, { error: '받다가 끊김, 다시 올리세요' }); }
    fs.renameSync(tmp, f);
    const size = fs.statSync(f).size, ts = Date.now();
    db.prepare('insert into files(path,size,ts,machine,session) values(?,?,?,?,?) on conflict(path) do update set size=excluded.size, ts=excluded.ts, machine=excluded.machine, session=excluded.session').run(rel, size, ts, who.machine, who.session);
    note(`파일 올림: ${rel} (${human(size)})`);
    return send(res, 200, { ok: true, path: rel, size });
  }
  if (req.method === 'DELETE') {
    if (!db.prepare('select 1 from files where path = ?').get(rel) && !fs.existsSync(f)) return send(res, 404, { error: '없는 파일' });
    fs.rmSync(f, { force: true });
    db.prepare('delete from files where path = ?').run(rel);
    note(`파일 지움: ${rel}`);
    return send(res, 200, { ok: true });
  }
  return send(res, 405, { error: 'GET, PUT, DELETE만' });
}

// 할 일: 세션이 사용자에게 맡기는 일(보안·승인·사용자가 직접 할 것). 사용자가 체크하면 그 세션에 '끝났으니 이어서'를 지시로 보냄
// 도구: 사용자가 허브에 적어 둔 쓰는 법·명령 예시. 대화창에서 고르거나 @이름으로 부르면 화면이 지시 앞에 붙여 보냄(비밀값은 넣지 않게 안내)
db.exec('create table if not exists tools(id integer primary key, ts integer not null, name text not null unique, desc text, how text, example text, links text, target text)');
db.exec('create table if not exists todos(id integer primary key, ts integer not null, machine text, session text, name text, text text not null, detail text, done_ts integer, note text)');
// 종류: do = 사용자가 할 일(했어요/필요 없음), approve = 승인·확인(진행/거절 — 거절도 세션에 알림)
if (!db.prepare("select 1 from pragma_table_info('todos') where name = 'kind'").get()) db.exec("alter table todos add column kind text default 'do'");
const todoKind = (k, text) => (k === 'approve' || k === 'do' ? k : /^\s*(\[[^\]]*\]\s*)?(승인|확인)/.test(String(text || '')) ? 'approve' : 'do');
if (!db.prepare("select 1 from pragma_table_info('todos') where name = 'check_cmd'").get()) db.exec('alter table todos add column check_cmd text');
function autoDrop() {
  for (const t of db.prepare("select * from todos where done_ts is null and check_cmd like 'hub:seen:%'").all()) {
    const m = t.check_cmd.slice('hub:seen:'.length);
    // prompt는 UserPromptSubmit 훅에서만 생김(손으로 보내는 임시 방법은 reply·busy만 보냄) → 훅이 진짜 들어간 증거
    if (db.prepare("select 1 from events where machine = ? and ts > ? and type = 'prompt' limit 1").get(m, t.ts)) {
      db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), `필요 없어짐(자동 확인: ${m} 훅 신호 들어옴)`, t.id);
      broadcast({ kind: 'todos' });
    }
  }
}
setInterval(autoDrop, 60e3).unref();
const todoRow = (t) => ({ ...t, from: sessions.get(`${t.machine}/${t.session}`) ? `${t.machine}/${t.session}` : null });
async function todos(req, res, p) {
  const byToken = bearer(req);
  if (!byToken && !authed(req)) return send(res, 401, { error: '로그인 또는 토큰 필요' });
  if (p === '/api/todos' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const list = db.prepare('select * from todos where done_ts is null or done_ts > ? order by (done_ts is not null), id desc limit 300').all(Date.now() - 7 * 864e5).map(todoRow);
    if (q.get('txt')) return send(res, 200, list.filter((t) => !t.done_ts).map((t) => `#${t.id}  ${t.machine}  ${t.text.split('\n')[0]}`).join('\n') + '\n');
    return send(res, 200, { todos: list });
  }
  if (p === '/api/todos/checks' && req.method === 'GET') { // hub-hook.sh wait용: 이 컴퓨터가 맡긴 열린 할 일의 셸 확인 명령, 줄마다 "id<TAB>base64"
    if (!byToken) return send(res, 401, { error: '토큰 필요' });
    const machine = header(req, 'x-hub-machine') || '';
    const rows = db.prepare("select id, check_cmd from todos where done_ts is null and machine = ? and (check_cmd like 'exists:%' or check_cmd like 'contains:%')").all(machine);
    return send(res, 200, rows.map((r) => `${r.id}\t${r.check_cmd}`).join('\n') + (rows.length ? '\n' : ''));
  }
  if (p === '/api/todos' && req.method === 'POST') { // 올리기: {text, detail?} — 토큰이면 X-Hub-Machine(·X-Hub-Session) 쪽 세션, 없으면 그 컴퓨터에서 가장 최근에 일한 세션
    const { text, detail, session, check, kind } = JSON.parse((await readBody(req, 64e3)) || '{}');
    const t = String(text || '').trim(); if (!t) return send(res, 400, { error: '할 일 내용(text) 필요' });
    let machine = '나', sid = 'web';
    if (byToken) {
      machine = header(req, 'x-hub-machine') || 'unknown';
      sid = str(session, 80) || header(req, 'x-hub-session')
        || [...sessions.values()].filter((s) => s.machine === machine && s.state !== 'offline').sort((a, b) => b.last - a.last)[0]?.session || 'unknown';
    }
    const s = sessions.get(`${machine}/${sid}`);
    const chk = validCheck(check);
    if (chk === false) return send(res, 400, { error: 'check는 hub:seen:<컴퓨터> / exists:<경로> / contains:<경로>|<글자> 중 하나' });
    const id = Number(db.prepare('insert into todos(ts,machine,session,name,text,detail,check_cmd,kind) values(?,?,?,?,?,?,?,?)').run(Date.now(), machine, sid, s?.name || null, t.slice(0, 2000), detail ? String(detail).slice(0, 8000) : null, chk, todoKind(kind, t)).lastInsertRowid);
    record({ machine, session: sid, type: 'todo', to: String(id), text: `할 일 요청: ${t.split('\n')[0]}` });
    broadcast({ kind: 'todos' });
    return send(res, 200, { ok: true, id });
  }
  const m = /^\/api\/todos\/(\d+)\/(done|undo|drop|check|kind)$/.exec(p);
  if (m && req.method === 'POST') {
    const t = db.prepare('select * from todos where id = ?').get(+m[1]); if (!t) return send(res, 404, { error: '없는 할 일' });
    if (m[2] === 'check') { // 이미 올린 할 일에 자동 정리 확인 붙이기
      const { check } = JSON.parse((await readBody(req, 8e3)) || '{}');
      const chk = validCheck(check);
      if (chk === false) return send(res, 400, { error: 'check는 hub:seen:<컴퓨터> / exists:<경로> / contains:<경로>|<글자> 중 하나' });
      db.prepare('update todos set check_cmd = ? where id = ?').run(chk, t.id);
      autoDrop(); return send(res, 200, { ok: true });
    }
    // 새 기기 붙이기 승인/거절은 화면에 로그인한 사용자만(세션이 토큰으로 자기 기기를 승인하지 못하게)
    const pairId = String(t.session || '').startsWith('pair:') ? t.session.slice(5) : null;
    if (pairId && (m[2] === 'done' || m[2] === 'drop')) {
      if (!authed(req)) return send(res, 403, { error: '새 기기 승인은 허브 화면에서 사용자만 할 수 있습니다' });
      if (t.done_ts) return send(res, 200, { ok: true, already: true });
      const pr = db.prepare('select * from pairs where id = ?').get(pairId);
      if (!pr || pr.status !== 'pending' || Date.now() - pr.ts > PAIR_MS) {
        db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), '만료된 요청', t.id); broadcast({ kind: 'todos' });
        return send(res, 410, { error: '15분이 지나 만료된 요청입니다. 새 기기에서 다시 실행하세요' });
      }
      if (m[2] === 'done') {
        const token = crypto.randomBytes(24).toString('hex');
        db.prepare('insert into devices(machine, token_hash, created) values(?,?,?)').run(pr.machine, sha(token), Date.now());
        db.prepare("update pairs set status = 'approved', token = ? where id = ?").run(token, pairId);
        db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), '승인함', t.id);
      } else {
        db.prepare("update pairs set status = 'rejected' where id = ?").run(pairId);
        db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), '필요 없어짐: 거절함', t.id);
      }
      broadcast({ kind: 'todos' }); return send(res, 200, { ok: true });
    }
    if (m[2] === 'kind') { // 종류 바꾸기 {kind: 'do'|'approve'}
      const { kind } = JSON.parse((await readBody(req, 2e3)) || '{}');
      if (kind !== 'do' && kind !== 'approve') return send(res, 400, { error: "kind는 'do' 또는 'approve'" });
      db.prepare('update todos set kind = ? where id = ?').run(kind, t.id); broadcast({ kind: 'todos' }); return send(res, 200, { ok: true });
    }
    // 승인 항목: '진행'(done)·'거절'(drop) 둘 다 맡긴 세션에 분명한 글로 알림. 거절이면 하지 말라고
    if (t.kind === 'approve' && (m[2] === 'done' || m[2] === 'drop')) {
      if (t.done_ts) return send(res, 200, { ok: true, already: true });
      const { note } = JSON.parse((await readBody(req, 8e3)) || '{}');
      const go = m[2] === 'done', memo = note ? String(note).slice(0, 2000) : '';
      db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), (go ? '진행' : '거절') + (memo ? ': ' + memo : ''), t.id);
      const msg = go
        ? `[허브 승인 #${t.id} 진행] ${t.text}\n사용자가 진행하라고 했습니다.${memo ? '\n사용자 메모: ' + memo : ''}\n진행하세요.`
        : `[허브 승인 #${t.id} 거절] ${t.text}\n사용자가 거절했습니다. 이 일은 하지 마세요.${memo ? '\n사용자 메모: ' + memo : ''}`;
      const s = sessions.get(`${t.machine}/${t.session}`) || { machine: t.machine, session: t.session };
      const aev = record({ machine: t.machine, session: t.session, type: 'ask', text: `승인 #${t.id} ${go ? '진행' : '거절'}${memo ? ': ' + memo : ''}` });
      db.prepare('insert into asks(ts,session,text,event_id) values(?,?,?,?)').run(Date.now(), t.session, msg, aev?.id ?? null);
      const w = waiters.get(t.session)?.shift(); if (w) deliver(w, s);
      broadcast({ kind: 'todos' });
      return send(res, 200, { ok: true, waiting: !w });
    }
    if (m[2] === 'drop') { // 필요 없어짐: 끝난 것으로 옮기되 세션은 안 깨움
      const { note } = JSON.parse((await readBody(req, 8e3)) || '{}');
      db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), '필요 없어짐' + (note ? ': ' + String(note).slice(0, 500) : ''), t.id);
      broadcast({ kind: 'todos' }); return send(res, 200, { ok: true });
    }
    if (m[2] === 'undo') { db.prepare('update todos set done_ts = null, note = null where id = ?').run(t.id); broadcast({ kind: 'todos' }); return send(res, 200, { ok: true }); }
    if (t.done_ts) return send(res, 200, { ok: true, already: true }); // 두 번 눌러도 지시는 한 번만
    const { note } = JSON.parse((await readBody(req, 8e3)) || '{}');
    db.prepare('update todos set done_ts = ?, note = ? where id = ?').run(Date.now(), note ? String(note).slice(0, 2000) : null, t.id);
    // 맡긴 세션을 깨워 이어서 하게(hub-hook wait가 받아 감)
    const msg = `[허브 할 일 #${t.id} 완료] ${t.text}\n사용자가 했다고 체크했습니다.${note ? '\n사용자 메모: ' + note : ''}\n이어서 진행하세요.`;
    const s = sessions.get(`${t.machine}/${t.session}`) || { machine: t.machine, session: t.session };
    const aev = record({ machine: t.machine, session: t.session, type: 'ask', text: `할 일 #${t.id} 했음${note ? ': ' + note : ''} — 이어서 진행` });
    db.prepare('insert into asks(ts,session,text,event_id) values(?,?,?,?)').run(Date.now(), t.session, msg, aev?.id ?? null);
    const w = waiters.get(t.session)?.shift(); if (w) deliver(w, s);
    broadcast({ kind: 'todos' });
    return send(res, 200, { ok: true, waiting: !w });
  }
  return send(res, 405, { error: 'GET/POST /api/todos, POST /api/todos/<id>/done|undo' });
}

// 새 기기 붙이기(join.sh): 1) POST /api/pair {machine} → 일회용 코드, 허브 '할 일'에 승인 요청
// 2) 사용자가 화면에서 코드가 같은지 보고 '했어요' → 이 기기 전용 토큰 발급 3) join.sh가 GET /api/pair/<id>?code= 로 한 번 받아 감(받으면 서버에서 지움)
db.exec(`create table if not exists devices(id integer primary key, machine text not null, token_hash text not null unique, created integer, last_seen integer, revoked integer);
  create table if not exists pairs(id text primary key, code text not null, machine text not null, ts integer not null, status text not null, token text)`);
const PAIR_MS = 15 * 60e3;
let lastPair = 0;
async function pair(req, res, p) {
  if (p === '/api/pair' && req.method === 'POST') { // 인증 없음 → 막 쏘지 못하게: 30초에 한 번, 대기 중 3개까지
    const { machine } = JSON.parse((await readBody(req, 2e3)) || '{}');
    const m = String(machine || '').trim();
    if (!/^[\p{L}\p{N} _.-]{1,20}$/u.test(m)) return send(res, 400, { error: '기기 이름은 글자·숫자·빈칸·_.- 20자까지' });
    if (Date.now() - lastPair < 30e3) return send(res, 429, { error: '30초 뒤 다시 하세요' });
    if (db.prepare("select count(*) n from pairs where status = 'pending' and ts > ?").get(Date.now() - PAIR_MS).n >= 3) return send(res, 429, { error: '승인 기다리는 요청이 너무 많습니다. 허브 할 일부터 정리하세요' });
    lastPair = Date.now();
    const id = crypto.randomBytes(16).toString('hex'), code = crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare("insert into pairs(id, code, machine, ts, status) values(?,?,?,?, 'pending')").run(id, code, m, Date.now());
    db.prepare('insert into todos(ts,machine,session,name,text,detail) values(?,?,?,?,?,?)').run(Date.now(), '허브', `pair:${id}`, null,
      `새 기기 붙이기 승인: "${m}" (코드 ${code})`,
      `새 기기의 터미널에 뜬 코드가 **${code}**와 같으면 **했어요**를 누르세요 → 그 기기 전용 토큰이 나갑니다.\n모르는 요청이면 **필요 없음**(거절). 15분이 지나면 만료됩니다.`);
    record({ machine: '허브', session: `pair:${id}`, type: 'todo', text: `할 일 요청: 새 기기 "${m}" 붙이기 승인 (코드 ${code})` });
    broadcast({ kind: 'todos' });
    return send(res, 200, { id, code });
  }
  const mm = /^\/api\/pair\/([0-9a-f]{32})$/.exec(p);
  if (mm && req.method === 'GET') {
    const pr = db.prepare('select * from pairs where id = ?').get(mm[1]);
    const code = new URL(req.url, 'http://x').searchParams.get('code') || '';
    if (!pr || !eq(code.toUpperCase(), pr.code)) return send(res, 404, { error: '없는 요청' });
    if (pr.status === 'approved' && pr.token) { db.prepare("update pairs set token = null, status = 'taken' where id = ?").run(pr.id); return send(res, 200, { status: 'approved', token: pr.token, machine: pr.machine }); }
    if (pr.status === 'pending' && Date.now() - pr.ts > PAIR_MS) return send(res, 200, { status: 'expired' });
    return send(res, 200, { status: pr.status === 'taken' ? 'taken' : pr.status });
  }
  return send(res, 405, { error: 'POST /api/pair, GET /api/pair/<id>?code=' });
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !authed(req)) { sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return sock.destroy(); }
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true)); });
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 30e3).unref();
// 세션이 6시간 조용하면 '끊김'으로 바뀌는 걸 화면에도 알리려고 5분마다 상태 다시 보냄
setInterval(() => broadcast({ kind: 'sessions', sessions: [...sessions.values()].map(view) }), 300e3).unref();
function deliver(res, s) {
  const a = takeAsk(s.session); if (!a) return send(res, 204, '');
  send(res, 200, a.text);
  record({ machine: s.machine, session: s.session, type: 'busy', text: '허브 지시 받음: ' + a.text.split(/\n/)[0], ref: a.event_id ?? undefined }); // 전달된 때 = 그 세션이 이 지시를 시작
}
function broadcast(msg) { const s = JSON.stringify(msg); wss.clients.forEach((ws) => ws.readyState === 1 && ws.send(s)); }

server.listen(PORT, process.env.HOST || '127.0.0.1', () => console.log(`ai-hub v${VERSION} ${PUBLIC_URL} (listen ${process.env.HOST || '127.0.0.1'}:${PORT})`));
