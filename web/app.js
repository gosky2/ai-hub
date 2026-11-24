// AI 허브 화면: /api/state로 처음 그리고, /ws로 이벤트를 받아 바로 반영
const $ = (id) => document.getElementById(id);
const BASE = location.pathname.replace(/[^/]*$/, ''); // '/' 또는 프록시 아래 '/ai-hub/'
const api = (p, o) => fetch(BASE + 'api/' + p, { credentials: 'same-origin', ...o });
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATE_WORD = { busy: '일하는 중', idle: '쉬는 중', asleep: '대기 끊김', offline: '끊김' }; // 대기 끊김 = 세션은 있는데 허브 지시를 못 받음(깨워야 함)
const sessions = new Map(); // key -> session
let events = [], ws, retry = 0;

// ---- 로그인 ----
async function boot() {
  const r = await api('me').catch(() => null);
  if (!r || r.status === 401) return showLogin();
  $('login').hidden = true; $('app').hidden = false; document.body.classList.add('app-on');
  r.json().then((d) => ($('ver').textContent = d.version ? 'v' + d.version : '')).catch(() => {});
  await load(); connect(); setView(mview); // 지도가 보인 뒤 저장된 이동 값을 지도 안으로
}
function showLogin() { $('app').hidden = true; document.body.classList.remove('app-on'); $('login').hidden = false; $('pw').focus(); }
// 화면 높이 맞추기: 100dvh는 iOS 15.4부터라(앱 최소 15.0) 실제로 보이는 높이(visualViewport — 키보드가 열리면 줄어듦)를 --app-h로 넣음
function fitApp() {
  const h = Math.round(window.visualViewport?.height || window.innerHeight);
  document.documentElement.style.setProperty('--app-h', `${h}px`);
  // iOS는 키보드를 열 때 페이지째 위로 밀어 보이는 칸(visual viewport)을 offsetTop만큼 내림. 높이만 줄이면(0.1.28) 앱이 두 번 올라가
  // 입력칸이 화면 맨 위로 감 → 앱을 보이는 칸의 위치(offsetTop)로 같이 옮겨서 입력칸이 늘 키보드 바로 위에. scrollTo로 되돌리면 iOS와 싸움
  const top = Math.round(window.visualViewport?.offsetTop || 0);
  document.documentElement.style.setProperty('--app-top', `${top}px`);
  try { if (chatAtBottom && document.activeElement === $('askText')) requestAnimationFrame(() => chatToBottom()); } catch {} // 키보드가 열리며 칸이 줄면 대화는 맨 아래로(처음 부를 땐 아직 없음)
}
fitApp();
addEventListener('resize', fitApp);
window.visualViewport?.addEventListener('resize', fitApp);
window.visualViewport?.addEventListener('scroll', fitApp);
$('newMsg').onclick = () => chatToBottom();
$('loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  const r = await api('login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) }).catch(() => null);
  if (r?.ok) { $('pw').value = ''; return boot(); }
  $('loginErr').textContent = r ? (await r.json().catch(() => ({}))).error || '들어가지 못했습니다' : '서버에 연결되지 않습니다. 인터넷을 확인하세요.';
};
$('logout').onclick = async () => { await api('logout', { method: 'POST' }); ws?.close(); showLogin(); };
$('logout2').onclick = () => $('logout').click(); // 폰: 로그아웃은 에이전트 메뉴 안에

async function load() {
  const r = await api('state');
  if (r.status === 401) return showLogin();
  const d = await r.json();
  sessions.clear(); d.sessions.forEach((s) => sessions.set(s.key, s));
  events = d.events; hidden = d.hidden || {};
  renderAll(); loadTodos(); loadTools();
  const last = [...events].reverse().find(isShown);
  if (last) setTick(last);
}
function connect() {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + BASE + 'ws');
  ws.onopen = () => { retry = 0; setLive(true); if (events.length) load(); };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.kind === 'todos') return loadTodos();
    if (d.kind === 'tools') return loadTools();
    if (d.kind === 'sessions') { d.sessions.forEach((s) => sessions.set(s.key, s)); if (d.hidden) hidden = d.hidden; return renderAll(); }
    if (d.session) sessions.set(d.session.key, d.session);
    events.push(d.event); if (events.length > 3000) events.shift();
    renderAll();
    if (d.event.ref && $('msgView').open && !$('mvAsk').hidden) { // 모달이 열린 일의 추가 요청: 보냄 → 받음 → 답함을 바로
      const jid = +$('mvAsk').dataset.id, ids = new Set([jid, ...events.filter((x) => x.type === 'ask' && x.ref === jid).map((x) => x.id)]);
      if (ids.has(d.event.ref)) renderFollow(jid);
    }
    if (d.event.type === 'file') loadFiles();
    if (isShown(d.event)) setTick(d.event);
    flow(d.event);
  };
  ws.onclose = () => { setLive(false); if ($('app').hidden) return; clearTimeout(reconnectT); reconnectT = setTimeout(connect, Math.min(30e3, 1000 * 2 ** retry++)); };
}
// 화면이 다시 앞에 오거나(노트북 깨움·폰 앱 복귀) 인터넷이 돌아오면: 끊겼으면 바로 다시 붙고, 붙어 있어도 지금 상태로 다시 그림
let reconnectT;
function wake() {
  if ($('app').hidden || document.hidden) return;
  if (!ws || ws.readyState > 1) { clearTimeout(reconnectT); retry = 0; connect(); } else load();
}
document.addEventListener('visibilitychange', wake);
addEventListener('online', wake);
function setLive(on) { const el = $('live'); el.classList.toggle('off', !on); el.textContent = on ? 'LIVE' : '다시 연결 중'; }

// ---- 이름 ----
// 화면 이름: 정한 이름·RC 제목·폴더 이름(서버가 줌), 없으면 "PC 세션 1a2b". 같은 이름이 둘 이상 떠 있으면 뒤에 세션 id 앞 4자리로 구분
const label = (s) => {
  if (!s.name) return `[${s.machine}] 세션 · ${s.session.slice(0, 4)}`; // 이름도 폴더도 모를 때: 위치 + id 앞 4자리
  let n = 0; for (const x of sessions.values()) if (x.name === s.name && !isHidden(x.key)) n++;
  return n > 1 ? `${s.name} · ${s.session.slice(0, 4)}` : s.name;
};
const ghostLabel = (n) => (/^bridge:session_/.test(n) ? `세션 …${n.slice(-4)}` : n);
function resolve(name) {
  if (!name) return null;
  for (const s of sessions.values()) if (s.name === name || s.key === name || s.session === name || s.aliases?.includes(name)) return s.key;
  return 'g:' + name;
}
// 정리: 숨긴 카드는 숨긴 뒤 새 이벤트가 오면 다시 보임
let hidden = {};
function isHidden(key) {
  if (key.startsWith('g:')) return true; // 허브 훅이 한 번도 없는 세션(Remote Control 목록에만 있는 이름)은 다루지 않음(사용자 지시)
  const s = sessions.get(key);
  if (s && s.acted === false) return true; // 한 번도 일을 안 받은 세션(데몬이 미리 띄운 예비 등) — 0.1.43부터 롱폴로 '쉬는 중'이 돼 보였음. 처음 일을 받으면 나타남
  const ts = hidden[key]; if (!ts) return false;
  if (!key.startsWith('g:')) return (sessions.get(key)?.last || 0) <= ts;
  return !events.some((e) => e.ts > ts && pair(e)?.includes(key));
}
async function hideCard(key) {
  hidden[key] = Date.now(); renderAll();
  const r = await api('session', { method: 'POST', body: JSON.stringify({ key, hide: true }) }).catch(() => null);
  if (!r?.ok) { delete hidden[key]; renderAll(); alert('숨기지 못했습니다'); }
}
// 이름 바꾸기(✎): "[컴퓨터] 닉네임" 꼴. 먼저 화면에 바꾸고 서버가 거절하면 되돌림
// 이름·설명 바꾸기(✎): 창에서 "[위치] 닉네임"과 "무엇을 하려고 연 세션인지" 한 줄. 먼저 화면에 바꾸고 서버가 거절하면 되돌림
let renameKey = null;
function renameCard(key) {
  const s = sessions.get(key); if (!s) return;
  renameKey = key;
  $('rnName').value = s.name || `[${s.machine}] `;
  $('rnDesc').value = s.descSrc === 'manual' ? s.desc || '' : '';
  $('rnDesc').placeholder = s.desc && s.descSrc !== 'manual' ? `지금: ${s.desc} (${s.descSrc === 'self' ? '세션이 등록' : '첫 지시'})` : '예: 영상 제작(MiniMax)';
  $('renameDlg').showModal(); $('rnName').focus();
}
$('renameForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const s = sessions.get(renameKey); if (!s) return $('renameDlg').close();
  let n = $('rnName').value.trim(); const d = $('rnDesc').value.trim();
  if (n && !/^\[/.test(n)) n = `[${s.machine}] ${n}`; // 닉네임만 적으면 위치를 앞에 붙임
  const body = { key: renameKey, desc: d }; if (n && n !== s.name) body.name = n;
  const old = { name: s.name, desc: s.desc, src: s.descSrc };
  if (body.name) s.name = n;
  if (d) { s.desc = d; s.descSrc = 'manual'; } else if (old.src === 'manual') { s.desc = null; s.descSrc = null; }
  $('renameDlg').close(); chatCount = -1; renderAll();
  const r = await api('session', { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
  if (!r?.ok) { Object.assign(s, { name: old.name, desc: old.desc, descSrc: old.src }); chatCount = -1; renderAll(); alert('바꾸지 못했습니다'); }
};
$('rnCancel').onclick = () => $('renameDlg').close();
const nameOf = (key) => (key === 'me' ? '나' : key.startsWith('g:') ? ghostLabel(key.slice(2)) : sessions.has(key) ? label(sessions.get(key)) : key);
const keyOf = (e) => `${e.machine}/${e.session}`;
// 줄 긋는 쌍: 사용자 지시는 나→세션, send는 보낸→받는, receive는 보낸 쪽이 hook 없는(유령) 세션일 때만(아니면 send가 이미 그림)
function pair(e) {
  if (e.type === 'prompt' || e.type === 'ask') return ['me', keyOf(e)];
  if (e.type === 'send') return [keyOf(e), resolve(e.to)];
  if (e.type === 'receive') { const from = resolve(e.to); return from?.startsWith('g:') ? [from, keyOf(e)] : null; }
  return null;
}
const isMsg = (e) => e.type === 'send' || (e.type === 'receive' && resolve(e.to)?.startsWith('g:'));
const isShown = (e) => e.type === 'prompt' || e.type === 'ask' || e.type === 'reply' || isMsg(e) || e.type === 'stop' || e.type === 'file' || e.type === 'todo';
const first = (t) => (t || '').split('\n').find((l) => l.trim()) || '';

// ---- 시간 ----
const ago = (ts) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 45 ? '방금' : s < 3600 ? `${Math.round(s / 60)}분 전` : s < 86400 ? `${Math.round(s / 3600)}시간 전` : `${Math.round(s / 86400)}일 전`;
};
const clock = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

// ---- 그리기 ----
function nodeList() {
  const keys = new Set();
  const live = [...sessions.values()].filter((s) => s.state !== 'offline' || Date.now() - s.last < 864e5).sort((a, b) => a.key.localeCompare(b.key));
  live.forEach((s) => keys.add(s.key));
  for (const e of events.slice(-400)) { const p = pair(e); if (p) p.forEach((k) => k !== 'me' && k.startsWith('g:') && keys.add(k)); }
  const max = innerWidth < 560 ? 8 : 14;
  return [...keys].filter((k) => !isHidden(k)).slice(0, max);
}
// ---- 지도: 카드는 끌어 옮기고(기기마다 기억), 천천히 둥둥 떠다니고, 선은 매 프레임 카드를 따라 다시 그림 ----
// pos = 카드의 기본 자리(자동 배치, 또는 사용자가 옮긴 자리) — 화면 %로. 떠다니는 건 그 위에 몇 px 더함
let pos = new Map();
let savedPos = {}; try { savedPos = JSON.parse(localStorage.getItem('mapPos') || '{}'); } catch {}
const cards = new Map(); // key -> { el, w, h, phase, period, settle }
let links = [];          // 그릴 선(같은 두 카드 사이는 하나로 합침)
let dragging = null, justDragged = false, mapLoop = 0;
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
function autoLayout(keys, box) {
  // 가운데 '나', 바로 옆에 PM(넓은 화면 왼쪽, 폰 아래), 나머지는 바깥 원 — PM 자리 쪽은 비워 둠
  const small = innerWidth < 560, rx = small ? 36 : 40, ry = small ? 40 : 38, out = new Map([['me', [50, 50]]]);
  const pmKey = keys.find((k) => isPM(sessions.get(k)) && sessions.get(k).state !== 'offline') || keys.find((k) => isPM(sessions.get(k)));
  const outer = keys.filter((k) => k !== pmKey);
  if (pmKey) out.set(pmKey, small ? [50, 50 + Math.min(30, (100 / box.height) * 82)] : [50 - Math.min(26, (100 / box.width) * 190), 50]);
  const gapAt = small ? Math.PI / 2 : Math.PI, gap = pmKey ? (40 * Math.PI) / 180 : 0, span = 2 * Math.PI - 2 * gap;
  outer.forEach((k, i) => {
    const a = pmKey ? gapAt + gap + ((i + 0.5) * span) / outer.length : -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(outer.length, 1);
    out.set(k, [50 + rx * Math.cos(a), 50 + ry * Math.sin(a)]);
  });
  return out;
}
function renderOrbit() {
  const keys = nodeList(), box = $('orbit').getBoundingClientRect();
  const auto = autoLayout(keys, box);
  const clamp = (v) => Math.max(6, Math.min(94, +v || 50)); // 저장한 자리가 지도 밖이면 안으로(창 크기·폰↔PC가 바뀌어도)
  pos = new Map(); ['me', ...keys].forEach((k) => { const sp = savedPos[k]; pos.set(k, sp ? [clamp(sp[0]), clamp(sp[1])] : auto.get(k)); });
  const holder = $('nodes'), seen = new Set(['me']);
  if (!holder.querySelector('.me')) holder.insertAdjacentHTML('beforeend', '<div class="me" data-k="me"><span><b>나</b><small>지시하는 사람</small></span></div>');
  keys.forEach((k) => {
    seen.add(k);
    let el = holder.querySelector(`.node[data-k="${CSS.escape(k)}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.k = k; holder.append(el); }
    const s = sessions.get(k), st = s ? s.state : 'idle';
    el.className = `node ${st}${s ? '' : ' ghost'}${isPM(s) ? ' pm' : ''}${dragging?.k === k ? ' dragging' : ''}`;
    el.innerHTML = `<b></b><small><span class="dot ${st}"></span><span></span></small>`;
    el.querySelector('b').textContent = nameOf(k);
    if (s?.desc) { const d = document.createElement('span'); d.className = 'desc'; d.textContent = s.desc; el.querySelector('b').after(d); }
    el.querySelector('small span:last-child').textContent = s ? `${s.machine} · ${STATE_WORD[st]}${s.model ? ' · ' + modelName(s.model) : ''}` : 'hook 없는 세션';
  });
  holder.querySelectorAll('.node').forEach((el) => !seen.has(el.dataset.k) && el.remove());
  $('links').setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  $('links').querySelector('.ring')?.remove(); // 점선 궤도는 뺌(뜻 없이 복잡해 보여서)
  holder.querySelectorAll('.node, .me').forEach((el) => {
    const k = el.dataset.k, w = el.offsetWidth, h = el.offsetHeight;
    let [x, y] = pos.get(k) || [50, 50];
    if (box.width && box.height) { // 저장한 자리·자동 배치 모두 카드가 지도 안에 다 들어오게(끌기와 같은 여백, 좁은 창에서 넓은 카드가 잘리던 것)
      const mx = Math.min(50, ((w / 2 + 4) / box.width) * 100), my = Math.min(50, ((h / 2 + 4) / box.height) * 100);
      x = Math.max(mx, Math.min(100 - mx, x)); y = Math.max(my, Math.min(100 - my, y)); pos.set(k, [x, y]);
    }
    el.style.left = x + '%'; el.style.top = y + '%';
    const c = cards.get(k) || { phase: (hash(k) % 628) / 100, period: 6000 + (hash(k) % 4000) };
    cards.set(k, { ...c, el, w, h });
  });
  for (const k of [...cards.keys()]) if (!seen.has(k)) cards.delete(k);
  renderPending();
  if (!mapLoop) mapLoop = requestAnimationFrame(frame);
}
// 카드 가운데(떠다니는 만큼 더함, 화면 px)
function center(k, t) {
  const p = pos.get(k), c = cards.get(k), b = mapBox; if (!p || !c) return null;
  let fx = 0, fy = 0;
  if (!reduced && dragging?.k !== k) {
    const w = ((t + c.phase * 1000) / c.period) * 2 * Math.PI;
    fy = Math.sin(w) * 4; fx = Math.cos(w * 0.7) * 2;
    if (c.settle) { const s = (t - c.settle) / 520; if (s < 1) fy += Math.sin(s * Math.PI * 3) * 7 * (1 - s); else c.settle = 0; } // 놓으면 살짝 튕기며 자리잡기
  }
  return { x: (p[0] * b.width) / 100 + fx, y: (p[1] * b.height) / 100 + fy, fx, fy, c };
}
let mapBox = { width: 1, height: 1 };
// 카드 테두리에서 나가는 점
function edgePt(k, cx, cy, tx, ty) {
  const c = live.get(k) || cards.get(k), vx = tx - cx, vy = ty - cy, L = Math.hypot(vx, vy) || 1;
  if (!c) return [cx, cy];
  let t = k === 'me' ? (c.w / 2 + 8) / L : Math.min((c.w / 2 + 8) / Math.abs(vx || 1e-9), (c.h / 2 + 8) / Math.abs(vy || 1e-9));
  t = Math.min(t, 0.45);
  return [cx + vx * t, cy + vy * t];
}
// 선 모양: 테두리에서 테두리까지 부드러운 곡선(진행 방향 왼쪽으로 살짝). '나' 가까이 지나가면 '나'를 비켜 바깥으로 더 휨
function linkGeom(a, b, ca, cb) {
  const A = edgePt(a, ca.x, ca.y, cb.x, cb.y), B = edgePt(b, cb.x, cb.y, ca.x, ca.y);
  const dx = B[0] - A[0], dy = B[1] - A[1], d = Math.hypot(dx, dy) || 1, nx = -dy / d, ny = dx / d;
  let mx = (A[0] + B[0]) / 2 + nx * d * 0.12, my = (A[1] + B[1]) / 2 + ny * d * 0.12;
  if (a !== 'me' && b !== 'me') {
    const me = live.get('me'), r = (me?.w || 100) / 2 + 26;
    if (me) {
      const qx = 0.25 * A[0] + 0.5 * mx + 0.25 * B[0], qy = 0.25 * A[1] + 0.5 * my + 0.25 * B[1]; // 곡선 가운데
      const dist = Math.hypot(qx - me.x, qy - me.y);
      if (dist < r) { // 가운데가 '나'에 걸리면 '나'에서 먼 쪽으로 밀어냄
        let ux = qx - me.x, uy = qy - me.y; const L = Math.hypot(ux, uy) || 1; ux /= L; uy /= L;
        if (L < 1) { ux = nx; uy = ny; }
        mx += ux * (r - dist) * 2; my += uy * (r - dist) * 2;
      }
    }
  }
  const flip = dx * (cb.x - ca.x) + dy * (cb.y - ca.y) <= 0 || d < 30; // 카드끼리 맞붙음
  return { A, B, M: [mx, my], flip };
}
const STAR_END_MS = 6000; // 끝난 일의 별이 남는 시간
const qpt = (g, t) => { const u = 1 - t; return [u * u * g.A[0] + 2 * u * t * g.M[0] + t * t * g.B[0], u * u * g.A[1] + 2 * u * t * g.M[1] + t * t * g.B[1]]; };
// 선 종류: 나 → PM '지시', 나 → 다른 세션 '바로', PM → 세션 '맡김', 세션 → PM '보고', 세션 → 나 '할 일', 그 밖 '메시지'
function linkKind(ka, kb) {
  if (ka === 'me') return isPM(sessions.get(kb)) ? ['me', '지시'] : ['direct', '바로'];
  if (kb === 'me') return ['todo-link', '할 일'];
  if (isPM(sessions.get(ka))) return ['delegate', '맡김'];
  if (isPM(sessions.get(kb))) return ['report', '보고'];
  return ['msg', '메시지'];
}
// 세션이 나에게 맡긴 할 일(열린 것): 세션 → 나
const openTodosBy = () => { const m = new Map(); todoRows.filter((t) => !t.done_ts && t.from).forEach((t) => m.set(t.from, (m.get(t.from) || 0) + 1)); return m; };
// 선 모델을 다시 만들고(같은 두 카드 사이는 하나로 합쳐 개수 배지) 카드 표시(응답 대기·할 일)를 맞춤. 실제 그리기는 frame()
function renderPending() {
  const svg = $('links'), NS = 'http://www.w3.org/2000/svg';
  if (!$('arrows')) svg.insertAdjacentHTML('afterbegin', `<defs id="arrows">${['me', 'direct', 'delegate', 'report', 'msg', 'todo-link'].map((c) => `<marker id="ar-${c}" class="ar ar-${c}" viewBox="0 0 12 12" refX="7" refY="6" markerWidth="5" markerHeight="5" markerUnits="strokeWidth" orient="auto"><path d="M2,2.2 Q2,1 3.2,1.6 L10,5.2 Q11,6 10,6.8 L3.2,10.4 Q2,11 2,9.8 Z"/></marker>`).join('')}</defs>`);
  let g = $('pend'); if (!g) { g = document.createElementNS(NS, 'g'); g.id = 'pend'; svg.append(g); }
  const raw = [], waits = new Map();
  // 지도 별 = '진행' 탭의 열린 일(지시됨·진행 중)과 같은 것. 끝난 일은 받는 카드에 닿아 반짝이고 몇 초 안에 사라짐(지난 기록은 진행 탭·대화창에서)
  let soon = 0;
  for (const j of buildJobs()) {
    if (!pos.has(j.from) || !pos.has(j.to)) continue;
    const open = j.st === 'sent' || j.st === 'doing', fin = j.st === 'done' && Date.now() - j.done < STAR_END_MS;
    if (!open && !fin) continue;
    raw.push({ a: j.from, b: j.to, ts: j.ts, done: fin ? j.done : null, title: `${JOB_WORD[j.st]}: ${j.text}` });
    if (open) waits.set(j.to, Math.min(waits.get(j.to) || j.ts, j.ts)); else soon = Math.max(soon, j.done + STAR_END_MS - Date.now());
  }
  clearTimeout(renderPending.t); if (soon > 0) renderPending.t = setTimeout(renderPending, soon + 200); // 끝난 별을 제때 지움
  const todos = openTodosBy();
  for (const [k, n] of todos) if (pos.has(k)) raw.push({ a: k, b: 'me', ts: Date.now(), title: `나에게 맡긴 할 일 ${n}개`, n });
  // 메시지 하나 = 별 하나(합치지 않음). 선·알약 이름표 없이, 꼬리 달린 빛점이 보낸 카드에서 받는 카드로 날아감. 종류는 색, 자세히는 마우스를 올리면
  const old = new Map(links.map((x) => [x.key, x]));
  g.innerHTML = '';
  const seen = new Map();
  links = raw.map((m) => {
    const base = `${m.a}|${m.b}|${m.ts}`, nth = (seen.get(base) || 0) + 1; seen.set(base, nth);
    const key = nth > 1 ? `${base}#${nth}` : base, [cls, word] = linkKind(m.a, m.b), done = !!m.done;
    const star = document.createElementNS(NS, 'g'); star.setAttribute('class', `star ${cls}${done ? ' done' : ''}`);
    const tt = document.createElementNS(NS, 'title'); tt.textContent = `${word}${done ? ' ✓' : ''} · ${nameOf(m.a)} → ${nameOf(m.b)}\n${m.title}`;
    const dots = [];
    for (let i = 0; i < 5; i++) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('class', i ? `tail t${i}` : 'head'); c.setAttribute('r', i ? 3 - i * 0.45 : 4); dots.push(c); star.append(c); }
    dots[0].append(tt);
    g.append(star);
    const o = old.get(key);
    return { key, a: m.a, b: m.b, cls, done, star, dots, phase: o?.phase ?? (hash(key) % 1000) / 1000, pulse: o?.pulse || 0, speed: 0.8 + (hash(key + 's') % 40) / 100 };
  });
  $('nodes').querySelectorAll('.node[data-k]').forEach((el) => {
    const k = el.dataset.k, w = waits.get(k), n = todos.get(k);
    el.classList.toggle('waiting', !!w);
    el.querySelector('.chips')?.remove();
    if (w || n) el.insertAdjacentHTML('beforeend', `<span class="chips">${w ? `<span class="chip">응답 대기 ${Math.max(1, Math.round((Date.now() - w) / 60e3))}분</span>` : ''}${n ? `<span class="chip todo">할 일 ${n}</span>` : ''}</span>`);
    const c = cards.get(k); if (c) { c.w = el.offsetWidth; c.h = el.offsetHeight; }
  });
  const total = todoRows.filter((t) => !t.done_ts).length, me = $('nodes').querySelector('.me');
  if (me) { me.classList.toggle('has-todo', total > 0); me.dataset.todo = total ? `할 일 ${total}` : ''; }
}
// 매 프레임: 카드 둥둥·끌기 위치 → 선·이름표·빛 알갱이를 따라 그림(가려진 동안은 쉼)
let lastT = 0;
function frame(t) {
  mapLoop = requestAnimationFrame(frame);
  lastT = t;
  if ($('app').hidden || !$('orbit').offsetWidth) return;
  // 선 끝점은 카드가 화면에 실제로 그려진 자리(getBoundingClientRect, 지도 기준)에서 읽음 — 끌기·창 크기·배율(zoom)과 상관없이 같은 좌표.
  // (전엔 카드 자리를 따로 계산해서, '나'를 끌거나 배율이 바뀌면 선이 엉뚱한 데로 감 — 0.1.29 '나 → PM' 선이 왼쪽 위로 가던 것)
  const ob = $('orbit').getBoundingClientRect(); mapBox = { width: ob.width, height: ob.height };
  const svg = $('links'), vb = `0 0 ${ob.width.toFixed(1)} ${ob.height.toFixed(1)}`;
  if (svg.getAttribute('viewBox') !== vb) svg.setAttribute('viewBox', vb);
  live = new Map();
  for (const [k, c] of cards) {
    if (!c.el.isConnected) continue;
    if (!c.el.closest('#nodes')) continue; // 끝점은 지도 안 카드만(머리·에이전트 목록·대화창의 같은 이름 요소 아님)
    const r = c.el.getBoundingClientRect(); if (!r.width) continue;
    const x = r.left - ob.left + r.width / 2, y = r.top - ob.top + r.height / 2;
    if (x < 0 || y < 0 || x > ob.width || y > ob.height) continue; // 가운데가 지도 밖인 카드(예전 창 크기에서 저장한 자리)는 선을 안 그림 — 0.1.32 로고 위로 가던 선
    live.set(k, { x, y, w: r.width, h: r.height });
  }
  // 그다음 둥둥(다음 프레임 선에 반영 — 한 프레임 늦어도 눈에 안 띔)
  for (const [k] of cards) { const c = center(k, t); if (c) c.c.el.style.transform = `translate(-50%, -50%) translate(${c.fx.toFixed(1)}px, ${c.fy.toFixed(1)}px)`; }
  const hide = (l) => { l.star.style.display = 'none'; };
  const put = (c, x, y) => { c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1)); };
  for (const l of links) {
    const ca = live.get(l.a), cb = live.get(l.b);
    if (!ca || !cb) { hide(l); continue; } // 끝을 못 찾으면 안 그림(0,0으로 떨어지지 않게)
    const g = linkGeom(l.a, l.b, ca, cb);
    if (g.flip) { hide(l); continue; }
    l.star.style.display = '';
    if (reduced) { const [x, y] = qpt(g, 0.5 + (l.phase - 0.5) * 0.3); put(l.dots[0], x, y); for (let i = 1; i < 5; i++) l.dots[i].style.display = 'none'; continue; } // 움직임 줄이기: 길 위에 멈춘 별
    // 날아감: 보낸 쪽 → 받는 쪽(끝난 건 느리고 흐리게). 기다리는 일은 받는 카드 근처에 닿아 잠깐 맴돌며 반짝
    const hot = t - l.pulse < 1800, dur = 4200 * l.speed;
    let cyc = hot ? (t - l.pulse) / 1800 : ((t / dur) + l.phase) % 1, fly = 0.78;
    if (l.done) { const age = Date.now() - l.done; cyc = Math.min(1, age / 2200); fly = 1; l.star.style.opacity = age > 2200 ? Math.max(0, 1 - (age - 2200) / (STAR_END_MS - 2200)).toFixed(2) : ''; } // 끝남: 한 번 닿고 사라짐
    const s = Math.min(1, cyc / fly), stay = !l.done && cyc > fly;
    let hx, hy;
    if (stay) { const [bx, by] = qpt(g, 0.97), a = t / 420 + l.phase * 6.28, r = 7; hx = bx + Math.cos(a) * r; hy = by + Math.sin(a) * r * 0.6; }
    else [hx, hy] = qpt(g, s);
    put(l.dots[0], hx, hy);
    l.dots[0].style.opacity = stay ? (0.55 + 0.45 * Math.abs(Math.sin(t / 180 + l.phase * 9))).toFixed(2) : '';
    for (let i = 1; i < 5; i++) { // 꼬리·별가루: 지나온 자리에 옅게
      const si = s - i * 0.035, d = l.dots[i];
      if (stay || si <= 0) { d.style.display = 'none'; continue; }
      d.style.display = ''; const [x, y] = qpt(g, si); put(d, x, y);
    }
    l.star.classList.toggle('hot', hot || (l.done && Date.now() - l.done > 2000)); // 닿는 순간 반짝
  }
}
let live = new Map();
// 새 일이 넘어갈 때: 그 선의 알갱이를 한 번 밝게 + 받는 카드 근처에 첫 줄 말풍선
function flow(e) {
  const pr = pair(e); if (!pr) return;
  if (!pos.has(pr[1]) || !pos.has(pr[0])) renderOrbit();
  const l = links.filter((x) => x.a === pr[0] && x.b === pr[1]).pop(); // 그 둘 사이 가장 최근 별
  if (l) l.pulse = performance.now();
  [pr[0], pr[1]].forEach((k) => { const el = cards.get(k)?.el; if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 1800); } });
  const text = first(e.text), cb = center(pr[1], lastT);
  if (text && cb) {
    const bub = document.createElement('div'); bub.className = 'bubble'; bub.textContent = text;
    bub.style.left = cb.x + 'px'; bub.style.top = cb.y - (cb.c.h / 2) - 6 + 'px';
    $('nodes').append(bub); setTimeout(() => bub.remove(), 6200);
  }
}
// 끌기: 카드·'나'를 마우스나 손가락으로 끌어 옮김(5px 넘게 움직이면 끌기, 아니면 누르기 = 자세히). 놓은 자리는 이 기기에 기억
$('nodes').addEventListener('pointerdown', (ev) => {
  const el = ev.target.closest('.node[data-k], .me'); if (!el || ev.button > 0) return;
  const k = el.dataset.k, r = $('orbit').getBoundingClientRect();
  dragging = { k, el, x0: ev.clientX, y0: ev.clientY, moved: false, r, id: ev.pointerId };
});
addEventListener('pointermove', (ev) => {
  const d = dragging; if (!d || ev.pointerId !== d.id) return;
  if (!d.moved && Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < 5) return;
  if (!d.moved) { d.moved = true; d.el.classList.add('dragging'); try { d.el.setPointerCapture(ev.pointerId); } catch {} }
  const c = cards.get(d.k), mx = ((c?.w || 80) / 2 + 4) / d.r.width * 100, my = ((c?.h || 60) / 2 + 4) / d.r.height * 100; // 카드가 지도 밖으로 반쯤 나가지 않게
  const x = Math.max(mx, Math.min(100 - mx, ((ev.clientX - d.r.left - mview.x) / mview.s / d.r.width) * 100)), y = Math.max(my, Math.min(100 - my, ((ev.clientY - d.r.top - mview.y) / mview.s / d.r.height) * 100)); // 지도 배율·이동을 되돌린 자리
  pos.set(d.k, [x, y]); d.el.style.left = x + '%'; d.el.style.top = y + '%';
});
function endDrag(ev) {
  const d = dragging; if (!d || (ev && ev.pointerId !== d.id)) return;
  dragging = null; d.el.classList.remove('dragging');
  if (d.moved) {
    savedPos[d.k] = pos.get(d.k); try { localStorage.setItem('mapPos', JSON.stringify(savedPos)); } catch {}
    const c = cards.get(d.k); if (c) c.settle = performance.now();
    justDragged = true; setTimeout(() => (justDragged = false), 50); // 끌기 끝의 click은 무시
    $('mapReset').hidden = false;
  }
}
addEventListener('pointerup', endDrag); addEventListener('pointercancel', endDrag);
// 지도만 확대·축소·이동(0.1.34): 카드·말풍선이 든 #nodes에 translate+scale. 선은 카드가 그려진 자리(rect)에서 읽어 저절로 따라감. 지도 밖(머리·대화·지표)은 그대로
let mview = { s: 1, x: 0, y: 0 }; try { const v = JSON.parse(localStorage.getItem('mapView') || 'null'); if (v && v.s > 0) mview = { s: +v.s, x: +v.x || 0, y: +v.y || 0 }; } catch {}
const clampS = (v) => Math.min(2, Math.max(0.5, v));
function setView(v) {
  const s = Math.round(clampS(v.s) * 100) / 100, r = $('orbit').getBoundingClientRect();
  // 이동은 지도 안으로만: 확대면 내용이 칸을 꽉 채우는 범위, 축소면 칸 안에서만. 100%는 이동 없음(0.1.45 저장된 이동 값 때문에 카드가 왼쪽 밖으로 밀렸음)
  const lim = (val, W) => (W ? Math.min(Math.max(val, Math.min(0, W * (1 - s))), Math.max(0, W * (1 - s))) : val);
  mview = { s, x: Math.round(lim(v.x, r.width)), y: Math.round(lim(v.y, r.height)) };
  const plain = mview.s === 1 && !mview.x && !mview.y;
  $('nodes').style.transform = plain ? '' : `translate(${mview.x}px, ${mview.y}px) scale(${mview.s})`;
  $('mapPct').textContent = `${Math.round(mview.s * 100)}%`;
  try { plain ? localStorage.removeItem('mapView') : localStorage.setItem('mapView', JSON.stringify(mview)); } catch {}
  $('mapReset').hidden = plain && !Object.keys(savedPos).length;
}
function zoomAt(s, cx, cy) { const k = clampS(s) / mview.s; setView({ s: mview.s * k, x: cx - (cx - mview.x) * k, y: cy - (cy - mview.y) * k }); } // (cx, cy) 지도 기준 px가 제자리
const zoomMid = (f) => { const r = $('orbit').getBoundingClientRect(); zoomAt(mview.s * f, r.width / 2, r.height / 2); };
$('mapIn').onclick = () => zoomMid(1.2); $('mapOut').onclick = () => zoomMid(1 / 1.2); $('mapPct').onclick = () => setView({ s: 1, x: 0, y: 0 });
$('orbit').addEventListener('wheel', (e) => { // Ctrl(맥 Cmd)+휠·트랙패드 핀치(ctrl 붙어 옴). 그냥 휠은 페이지 스크롤 그대로
  if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault();
  const r = $('orbit').getBoundingClientRect(); zoomAt(mview.s * Math.exp(Math.max(-1, Math.min(1, -e.deltaY / 300))), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });
// 빈 곳 끌기 = 지도 이동, 두 손가락 = 핀치(카드 위에서 시작하면 카드 끌기)
const ptrs = new Map(); let pan = null, pinch = null;
const opt = (e) => { const r = $('orbit').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function startGesture() {
  const ps = [...ptrs.values()]; pan = pinch = null;
  if (ps.length === 1) pan = { p: ps[0], v: { ...mview } };
  else if (ps.length >= 2) { const [a, b] = ps; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v: { ...mview } }; }
}
$('orbit').addEventListener('pointerdown', (e) => {
  if (e.button > 0 || dragging || e.target.closest('.node, .me, button, .node-pop, .map-zoom')) return;
  ptrs.set(e.pointerId, opt(e)); try { $('orbit').setPointerCapture(e.pointerId); } catch {} startGesture();
});
$('orbit').addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, opt(e));
  if (pinch) {
    const [a, b] = [...ptrs.values()], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], s2 = clampS(pinch.v.s * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d));
    const px = (pinch.m[0] - pinch.v.x) / pinch.v.s, py = (pinch.m[1] - pinch.v.y) / pinch.v.s; // 핀치 시작 때 손가락 가운데 아래 있던 지도 점
    setView({ s: s2, x: m[0] - px * s2, y: m[1] - py * s2 });
  } else if (pan) { const p = ptrs.get(e.pointerId); setView({ s: pan.v.s, x: pan.v.x + p[0] - pan.p[0], y: pan.v.y + p[1] - pan.p[1] }); }
});
const endPtr = (e) => { if (ptrs.delete(e.pointerId)) startGesture(); };
$('orbit').addEventListener('pointerup', endPtr); $('orbit').addEventListener('pointercancel', endPtr);
setView(mview);
addEventListener('resize', () => setView(mview)); // 창 크기가 바뀌면 이동 값을 다시 지도 안으로
$('mapReset').onclick = () => { savedPos = {}; try { localStorage.removeItem('mapPos'); } catch {} setView({ s: 1, x: 0, y: 0 }); $('mapReset').hidden = true; renderOrbit(); };
// 카드 누르면 자세히(이름·설명·상태·지금 하는 일 + 바로 보내기·이름 바꾸기·숨기기)
// 모델: 훅이 알려 준 id(claude-opus-5-5)를 짧게, 고르기는 별칭(opus·sonnet·haiku)으로. 비용은 상대값만(₩ 많을수록 비쌈)
const MODELS = [['opus', 'Opus', '₩₩₩', '가장 잘함'], ['sonnet', 'Sonnet', '₩₩', '보통'], ['haiku', 'Haiku', '₩', '빠르고 쌈']];
const modelName = (id) => { const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id || ''); return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : (id || ''); };
const modelAlias = (id) => MODELS.find(([a]) => String(id || '').toLowerCase().includes(a))?.[0] || '';
function modelBlock(s) { // 허브 앱이 띄운 세션(PM)은 고르면 앱이 다시 띄움, 그 밖은 그 세션에서 /model 을 치라고 안내
  const cur = modelAlias(s.model), want = s.wantModel ? modelAlias(s.wantModel) || s.wantModel : '';
  const opts = MODELS.map(([a, n, c, d]) => `<option value="${a}"${(want || cur) === a ? ' selected' : ''}>${n} ${c} · ${d}</option>`).join('');
  const how = isPM(s)
    ? (want ? `<small class="np-note busy">허브 앱이 ${esc(want)}(으)로 다시 띄우기를 기다리는 중(대화 이어짐) <button type="button" data-np="model-cancel" class="link-btn">취소</button></small>` : '<small class="np-note">고르면 허브 앱이 그 모델로 다시 띄움(대화 이어짐)</small>')
    : `<small class="np-note">허브에서 바꿀 수 없는 세션: 그 세션 입력칸에 <code id="npCmd">/model ${esc(want || cur || 'sonnet')}</code> <button type="button" data-np="model-copy" class="link-btn">복사</button></small>`;
  return `<dt>모델</dt><dd><span class="np-model">${esc(s.model ? modelName(s.model) : '모름(새 hub-hook.sh면 첫 답 뒤 보임)')}</span>
    <select id="npModel" aria-label="모델 고르기">${cur || want ? '' : '<option value="" selected>고르기</option>'}${opts}</select>${how}</dd>`;
}
function openCard(k) {
  const s = sessions.get(k), pop = $('nodePop'); if (!s || !pop) return;
  const L = live.get(k), c0 = center(k, lastT); if (!L && !c0) return;
  const c = L || { x: c0.x, y: c0.y, h: c0.c.h }, w = Math.min(280, mapBox.width - 16); // 그려진 자리(지도 배율·이동 반영)
  pop.innerHTML = `<div class="np-head"><span class="dot ${s.state}"></span><b>${esc(label(s))}</b><button type="button" class="np-x" aria-label="닫기">×</button></div>
    ${s.desc ? `<p class="np-desc">${esc(s.desc)}</p>` : ''}
    ${s.state === 'asleep' ? `<p class="np-sleep">허브 지시를 지금은 못 받아요(대기 끊김). 보내면 쌓아 두고 PM에게 깨우기를 부탁해요. <button type="button" data-np="wake" class="link-btn">지금 깨우기</button></p>` : ''}
    <dl class="np-info"><dt>상태</dt><dd>${esc(STATE_WORD[s.state])} · ${esc(s.machine)} · ${ago(s.last)}</dd>${s.doing ? `<dt>하는 일</dt><dd>${esc(first(s.doing))}</dd>` : ''}${modelBlock(s)}</dl>
    <div class="np-act"><button type="button" data-np="send" class="primary">이 세션에 보내기</button><button type="button" data-np="rename">이름·설명</button><button type="button" data-np="hide">숨기기</button></div>`;
  pop.style.width = w + 'px';
  pop.style.left = Math.max(8, Math.min(mapBox.width - w - 8, c.x - w / 2)) + 'px';
  pop.hidden = false; pop.dataset.k = k;
  let top = c.y + c.h / 2 + 10; const ph = pop.offsetHeight; if (top + ph > mapBox.height - 8) top = Math.max(8, c.y - c.h / 2 - 10 - ph); // 지도는 넘친 것을 자르니 아래가 모자라면 카드 위로
  pop.style.top = top + 'px';
}
$('nodes').addEventListener('click', (ev) => {
  if (justDragged) return;
  const n = ev.target.closest('.node[data-k]'); if (!n) return;
  openCard(n.dataset.k);
  if (innerWidth >= 900 && sessions.has(n.dataset.k)) { askTo = n.dataset.k; askPicked = true; renderAskTo(); } // 오른쪽 대화창이 그 에이전트와의 대화로
});
$('nodePop').addEventListener('click', (ev) => {
  const pop = $('nodePop'), k = pop.dataset.k, b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.np === 'model-copy') { const t = $('npCmd').textContent; navigator.clipboard?.writeText(t).then(() => (b.textContent = '복사됨'), () => (b.textContent = '복사 안 됨')); return; }
  if (b.dataset.np === 'model-cancel') { setWantModel(k, ''); return; }
  if (b.dataset.np === 'wake') {
    b.disabled = true;
    api('wake', { method: 'POST', body: JSON.stringify({ key: k }) }).then((r) => r.json()).then((d) => { b.textContent = wakeWord(d); }, () => { b.textContent = '못 보냄'; b.disabled = false; });
    return;
  }
  pop.hidden = true;
  if (b.dataset.np === 'send') pickTarget(k); else if (b.dataset.np === 'rename') renameCard(k); else if (b.dataset.np === 'hide') hideCard(k);
});
const wakeWord = (d) => d.awake ? '이미 깨어 있음' : !d.waker ? 'PM이 없어 못 깨움' : !d.targets?.length ? '방금 부탁함(10분 뒤 다시)' : `${d.waker}에게 깨우기 부탁 ${d.targets.length}개${d.pmAsleep ? (d.pmWaker ? ` · PM은 ${d.pmWaker}가 먼저 깨움` : ' · PM도 끊겼고 깨울 세션이 없음(그 PC에서 직접)') : ''}`;
async function wakeAll(btn) {
  btn.disabled = true;
  const d = await api('wake', { method: 'POST', body: JSON.stringify({ all: true }) }).then((r) => r.json()).catch(() => null);
  btn.textContent = d ? (d.awake ? '깨울 세션 없음' : wakeWord(d)) : '못 보냄';
  setTimeout(() => { btn.disabled = false; btn.textContent = '전체 깨우기'; }, 6000);
}
async function setWantModel(k, want) {
  const s = sessions.get(k); if (!s) return;
  if (!isPM(s)) { $('npCmd').textContent = `/model ${want}`; return; } // 안내 명령만 바꿈
  const r = await api('model', { method: 'POST', body: JSON.stringify({ key: k, want }) }).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : {};
  if (r?.ok) { s.wantModel = d.want || null; if (!$('nodePop').hidden && $('nodePop').dataset.k === k) openCard(k); }
  else alert(d.error || '모델을 못 바꿨습니다');
}
$('nodePop').addEventListener('change', (ev) => { if (ev.target.id === 'npModel' && ev.target.value) setWantModel($('nodePop').dataset.k, ev.target.value); });
document.addEventListener('pointerdown', (ev) => { const pop = $('nodePop'); if (pop && !pop.hidden && !ev.target.closest('#nodePop, .node')) pop.hidden = true; });

function setTick(e) {
  const pr = pair(e);
  const who = pr ? `${nameOf(pr[0])} → ${nameOf(pr[1])}` : e.type === 'file' || e.type === 'todo' ? e.machine : e.type === 'reply' ? `${nameOf(keyOf(e))} 답` : `${nameOf(keyOf(e))} 끝남`;
  $('tick').textContent = `${clock(e.ts)}  ${who}${first(e.text) ? ': ' + first(e.text).replace(/\*\*|`/g, '') : ''}`;
}

// 지표: 24시간을 30분 칸 48개로 나눈 작은 꺾은선
function series(filter) {
  const now = Date.now(), bins = new Array(48).fill(0);
  for (const e of events) { const i = 47 - Math.floor((now - e.ts) / 1800e3); if (i >= 0 && i < 48 && filter(e)) bins[i]++; }
  return bins;
}
function spark(bins) {
  const max = Math.max(1, ...bins), w = 100, h = 30;
  const pts = bins.map((v, i) => `${((i / (bins.length - 1)) * w).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="area" d="M0,${h} L${pts.join(' L')} L${w},${h}Z"/><path d="M${pts.join(' L')}" vector-effect="non-scaling-stroke"/></svg>`;
}
function renderMetrics() {
  const all = [...sessions.values()].filter((s) => !isHidden(s.key)), today = new Date().setHours(0, 0, 0, 0);
  const on = all.filter((s) => s.state !== 'offline').length, busy = all.filter((s) => s.state === 'busy').length;
  const msgs = events.filter((e) => e.ts >= today && isMsg(e)).length;
  const machines = {};
  all.forEach((s) => (machines[s.machine] = Math.max(machines[s.machine] || 0, s.last)));
  const mList = Object.entries(machines).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, t]) => `<li><span>${esc(m)}</span><span>${ago(t)}</span></li>`).join('') || '<li><span>아직 없음</span></li>';
  $('metrics').innerHTML = `
    <article class="metric"><h3>접속한 세션</h3><div class="v">${on}</div>${spark(series(() => true))}</article>
    <article class="metric"><h3>오늘 주고받은 메시지</h3><div class="v">${msgs}</div>${spark(series(isMsg))}</article>
    <article class="metric"><h3>일하는 세션</h3><div class="v">${busy}</div>${spark(series((e) => e.type === 'prompt'))}</article>
    <article class="metric"><h3>컴퓨터별 마지막 활동</h3><ul>${mList}</ul></article>`;
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function renderSessions() {
  // 24시간 넘게 조용한 끊김 세션은 맨 뒤에 흐리게
  const old = (s) => s.state === 'offline' && Date.now() - s.last > 864e5;
  const list = [...sessions.values()].filter((s) => !isHidden(s.key)).sort((a, b) => old(a) - old(b) || (a.state === 'offline') - (b.state === 'offline') || b.last - a.last);
  $('sessionList').innerHTML = list.length ? list.map((s) => `<li data-k="${esc(s.key)}" class="${old(s) ? 'old' : ''}${isPM(s) ? ' pm' : ''}" title="눌러서 이 세션에 지시">
      <span class="dot ${s.state}" title="${STATE_WORD[s.state]}"></span><b>${esc(label(s))}</b><span class="when">${esc(s.machine)}, ${ago(s.last)}<button type="button" class="hide-x" data-rename aria-label="${esc(label(s))} 이름 바꾸기" title="이름 바꾸기">✎</button><button type="button" class="hide-x" data-hide aria-label="${esc(label(s))} 숨기기" title="숨기기(새 활동이 오면 다시 보임)">×</button></span>
      ${s.desc ? `<span class="desc" title="${esc(s.desc)}">${esc(s.desc)}</span>` : ''}<span class="doing">${esc(STATE_WORD[s.state])}${s.doing ? ' — ' + esc(first(s.doing)) : ''}</span></li>`).join('')
    : '<li class="empty">아직 들어온 세션이 없습니다. docs/hooks.md대로 hook을 넣으면 여기에 뜹니다.</li>';
}
// ---- 대화(카톡처럼) ----
// 내 지시(터미널에서 친 것·허브에서 보낸 것)는 오른쪽, 세션 답과 세션끼리 주고받은 말은 왼쪽
const isChat = (e) => e.type === 'prompt' || e.type === 'ask' || e.type === 'reply' || e.type === 'file' || e.type === 'todo' || isMsg(e);
const initial = (n) => (n || "?").replace(/^\[[^\]]*\]\s*/, "").slice(0, 2); // "[server] dev" → "dev"
// 시스템 태그 지우기(서버 stripSys와 같음, 0.1.5 전에 저장된 글용)
const SYS = '(?:task-notification|system-reminder|local-command-[\\w-]+|command-[\\w-]+)';
const stripSys = (t) => String(t || '').replace(new RegExp(`<(${SYS})\\b[^>]*>[\\s\\S]*?</\\1>`, 'g'), '').replace(new RegExp(`</?${SYS}\\b[^>]*>`, 'g'), '').trim();
const HUB_ASK = /\[AI 허브에서 사용자가 보낸 지시\]/;
// 작은 마크다운: 먼저 전부 이스케이프하고 나서 굵게·코드·코드 블록·목록·제목·표·링크(http/https만)만 태그로 바꿈
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}
function md(text) {
  const blocks = [], out = [];
  const s = esc(text).replace(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g, (_, c) => `\u0001${blocks.push(c.replace(/\n$/, '')) - 1}\u0001`);
  let open = null; // 'ul' | 'ol' | 'table'
  const close = () => { if (open) { out.push(`</${open}>`); open = null; } };
  const start = (t) => { if (open !== t) { close(); out.push(`<${t}>`); open = t; } };
  for (const line of s.split('\n')) {
    let m;
    if ((m = /^\s*\u0001(\d+)\u0001\s*$/.exec(line))) { close(); out.push(`<pre><code>${blocks[m[1]]}</code></pre>`); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { close(); out.push(`<p class="h">${inline(m[2])}</p>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // |---|---| 줄
      start('table'); out.push(`<tr>${line.trim().slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`); continue;
    }
    if ((m = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line))) { start(m[1] ? 'ol' : 'ul'); out.push(`<li>${inline(m[2])}</li>`); continue; }
    close();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join('').replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${blocks[i]}</code>`);
}
let chatCount = -1;
// ---- 대화 자동 스크롤 ----
// '맨 아래에 있나'는 다시 그리기 직전에 재지 않고 스크롤할 때마다 기억함: 대화 칸이 가려져 있으면(폰의 지도 탭) 높이가 0이라 늘 틀렸음.
// 맨 아래로는 그린 직후·다음 프레임·이미지 다 뜬 뒤 다시 내림(iOS WebKit은 그린 직후 scrollTop이 덜 먹고, 썸네일이 뜨며 높이가 늘어남)
let chatAtBottom = true, chatForceBottom = false, lastChatId = 0, newWhileUp = 0;
const chatBoxEl = () => $('chatList');
function chatToBottom() {
  const box = chatBoxEl(), go = () => { box.scrollTop = box.scrollHeight; };
  go(); requestAnimationFrame(() => { go(); setTimeout(go, 120); });
  box.querySelectorAll('img').forEach((img) => { if (!img.complete) img.addEventListener('load', () => { if (chatAtBottom) go(); }, { once: true }); });
  chatAtBottom = true; newWhileUp = 0; showNewBtn();
}
function showNewBtn() {
  const b = $('newMsg'); if (!b) return;
  b.hidden = !newWhileUp; b.textContent = `↓ 새 메시지 ${newWhileUp}`;
}
chatBoxEl().addEventListener('scroll', () => {
  const box = chatBoxEl(); if (!box.clientHeight) return; // 가려진 동안은 안 잼
  chatAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (chatAtBottom && newWhileUp) { newWhileUp = 0; showNewBtn(); }
}, { passive: true });
// ---- 요청·답 짝 ----
// 서버가 이벤트에 ref(어느 요청에 대한 것인지)를 붙여 줌: 답(reply)·보낸 메시지(send) → 그 세션이 하던 요청, 받은 메시지(receive) → 보낸 메시지.
// receive는 대화창에 안 나오니 그 ref(보낸 쪽 send)로 따라감 → 'PM이 맡긴 일'의 보고가 그 맡김에 붙음
function threads() {
  const byId = new Map(events.map((e) => [e.id, e]));
  const shown = (id) => { let x = byId.get(id); if (x?.type === 'receive') x = x.ref ? byId.get(x.ref) : null; return x || null; };
  const answers = new Map();
  for (const e of events) {
    if (!e.ref || (e.type !== 'reply' && e.type !== 'send')) continue;
    const r = shown(e.ref); if (!r || r.id === e.id) continue;
    if (e.type === 'reply' || r.type === 'send') answers.set(r.id, (answers.get(r.id) || 0) + 1); // 지시 중에 PM이 남에게 맡긴 send는 '답'으로 안 셈
  }
  // ref 없는 옛 답: 그 세션에 간 직전 지시로 추정(흐리게)
  const guess = (e) => { for (let i = events.indexOf(e) - 1; i >= 0; i--) { const x = events[i]; if (keyOf(x) === keyOf(e) && (x.type === 'ask' || x.type === 'prompt')) return x; } return null; };
  return { shown, answers, guess };
}
const reqQuote = (r) => first(stripSys(splitAtt(r.text || '').body)).slice(0, 20);
function renderChat() {
  // 대화창 = 지금 고른 에이전트(기본 PM)와 나의 대화. 그 에이전트가 다른 세션과 주고받은 것(맡김·보고·메시지·그 요청에 낸 답)은 얇은 한 줄로
  const V = askTo, byId = new Map(events.map((e) => [e.id, e]));
  const fromPeer = (e) => e.type === 'reply' && e.ref && byId.get(e.ref)?.type === 'receive'; // 다른 세션 요청에 낸 답
  const mineView = (e) => {
    if (!V) return true;
    if (e.type === 'file') return e.machine === '나' || keyOf(e) === V;
    if (e.type === 'prompt' || e.type === 'ask' || e.type === 'reply' || e.type === 'todo') return keyOf(e) === V;
    const pr = pair(e); return !!pr && pr.includes(V);
  };
  const list = events.filter((e) => isChat(e) && e.text && mineView(e) && !(e.type === 'file' && String(e.to || '').startsWith('첨부/')) && !(e.type === 'prompt' && (HUB_ASK.test(e.text) || !stripSys(e.text)))).slice(-300), box = $('chatList');
  // 다시 그릴지: 개수만 보면 300개(slice)가 꽉 찬 뒤엔 늘 같아서 새 말풍선이 안 그려졌음 → 마지막 이벤트 id까지 봄(+ 보는 에이전트)
  const sig = `${V}:${list.length}:${list[list.length - 1]?.id ?? 0}`;
  if (sig === chatCount) return;
  const prevLast = lastChatId;
  chatCount = sig;
  const th = threads();
  const items = list.map((e) => {
    if (e.type === 'todo')
      return `<li class="cm sys todo-sys">${esc(nameOf(keyOf(e)))} · ${clock(e.ts)} · <a href="#" data-todo="${esc(e.to || '')}">${esc(e.text)}</a></li>`;
    if (e.type === 'file') // 파일 알림은 가운데 작은 줄, 누르면 파일 칸에서 미리보기
      return { file: true, html: `<li class="cm sys">${esc(e.machine)} · ${clock(e.ts)} · ${e.text.startsWith('파일 지움') ? esc(e.text) : `<a href="#" data-file="${esc(e.to || '')}">${esc(e.text)}</a>`}</li>` };
    const k = keyOf(e), { body: text, atts } = splitAtt(e.type === 'prompt' ? stripSys(e.text) : e.text), pv = preview(text);
    // 답이면 원래 요청을 작게 인용(누르면 그 요청으로), 요청이면 처리 중 / ✓ 답 n
    let quote = '', status = '';
    if (e.type === 'reply' || (e.type === 'send' && e.ref)) {
      const r = e.ref ? th.shown(e.ref) : e.type === 'reply' ? th.guess(e) : null, g = !e.ref;
      if (r && r.id !== e.id) quote = `<button type="button" class="quote${g ? ' guess' : ''}" data-jump="${r.id}" title="누르면 그 요청으로">↩ '${esc(reqQuote(r))}…'에 대한 ${e.type === 'send' && r.type === 'send' ? '보고' : '답'}${g ? ' (추정)' : ''}</button>`;
    }
    if (e.type === 'prompt' || e.type === 'ask' || (e.type === 'send' && !e.ref) || (e.type === 'send' && isPM(sessions.get(k)))) { // 새 요청(내 지시·PM이 맡긴 일·처음 보내는 메시지)만 '처리 중·✓'. 보고(ref 있는 send)엔 안 붙임
      const n = th.answers.get(e.id);
      status = n ? `<span class="st ok">✓ 답${n > 1 ? ' ' + n + '개' : ''}</span>` : Date.now() - e.ts < 3 * 3600e3 ? '<span class="st wait">처리 중…</span>' : '';
    }
    const bb = `<div class="row"><div class="bb" data-id="${e.id}">${md(pv.text)}${attHtml(atts)}${pv.more ? `<button type="button" class="more" data-more>전체 보기${pv.code ? ' · 코드 있음' : ''}</button>` : ''}</div><time>${clock(e.ts)}</time></div>`;
    const pmKey = (key) => isPM(sessions.get(key));
    // 다른 에이전트와 주고받은 것: 얇은 한 줄(누르면 펼침)
    const thin = (other, word) => `<li class="cm thin" data-eid="${e.id}"><details><summary><span class="who">↔ <b>${esc(nameOf(other))}</b>${word} · ${clock(e.ts)}</span><span class="sum">${esc(first(text).replace(/^\[[^\]]*\]\s*/, '').slice(0, 50))}</span></summary>${quote}${bb}</details></li>`;
    if (V && fromPeer(e)) { const r = byId.get(e.ref), from = r && resolve(r.to); return thin(from || k, ' 요청에 답함'); }
    if (V && (e.type === 'send' || e.type === 'receive')) {
      const pr = pair(e), out = pr[0] === V, other = out ? pr[1] : pr[0], vPM = pmKey(V);
      return thin(other, out ? (vPM ? '에게 맡김' : pmKey(other) ? '에게 보고' : '에게 보냄') : (vPM ? '에게서 보고' : pmKey(other) ? '에게서 맡김 받음' : '에게서 받음'));
    }
    if (e.type === 'prompt' || e.type === 'ask') // 내 지시: PM에게 보낸 건 그냥, 다른 세션에 바로 보낸 건 '바로' 표시
      return `<li class="cm mine${pmKey(k) ? '' : ' direct'}" data-eid="${e.id}"><span class="nm">${pmKey(k) ? '' : '<span class="tag">바로</span> '}나<i>→</i>${esc(nameOf(k))} ${status}</span>${bb}</li>`;
    if (e.type === 'reply')
      return `<li class="cm${pmKey(k) ? ' pm-say' : ''}" data-eid="${e.id}"><span class="av${pmKey(k) ? ' pm' : ''}">${pmKey(k) ? 'PM' : esc(initial(nameOf(k)))}</span><span class="nm">${esc(nameOf(k))}</span>${quote}${bb}</li>`;
    // 세션끼리: PM이 맡긴 일 / PM에게 온 보고는 구분해서 작게
    const [x, y] = pair(e), kind = pmKey(x) ? ['delegate', '맡김'] : pmKey(y) ? ['report', '보고'] : ['', ''];
    if (kind[0]) // PM이 맡긴 일·PM에게 온 보고는 한 줄 요약으로 접어 둠(누르면 펼침)
      return `<li class="cm peer ${kind[0]} compact" data-eid="${e.id}"><details><summary><span class="tag ${kind[0]}">${kind[1]}</span> <b>${esc(nameOf(kind[0] === 'delegate' ? y : x))}</b><span class="sum">${esc(first(text).replace(/^\[[^\]]*\]\s*/, '').slice(0, 60))}</span>${e.type === 'send' ? status : ''}<time>${clock(e.ts)}</time></summary>${quote}${bb}</details></li>`;
    return `<li class="cm peer" data-eid="${e.id}"><span class="av">${esc(initial(nameOf(x)))}</span><span class="nm">${esc(nameOf(x))}<i>→</i>${esc(nameOf(y))} ${e.type === 'send' ? status : ''}</span>${quote}${bb}</li>`;
  });
  // 연달아 나온 '파일 올림' 줄은 한 줄로 접음("파일 3개 올림 ▸")
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (!items[i]?.file) { out.push(items[i]); continue; }
    let j = i; while (j < items.length && items[j]?.file) j++;
    const run = items.slice(i, j).map((x) => x.html);
    out.push(run.length < 2 ? run[0] : `<li class="cm sys group"><details><summary>파일 ${run.length}개 올림</summary><ul>${run.join('')}</ul></details></li>`);
    i = j - 1;
  }
  box.innerHTML = list.length ? out.join('') : isPM(sessions.get(V)) || !V ? '<li class="empty">PM에게 할 일을 말하면 PM이 세션들에 나눠 주고, 오간 말이 여기에 쌓입니다.</li>' : `<li class="empty">${esc(nameOf(V))}와 나눈 대화가 아직 없습니다. 아래에 쓰면 PM을 거치지 않고 바로 갑니다.</li>`;
  lastChatId = list[list.length - 1]?.id ?? 0;
  // 맨 아래 근처에 있었거나(스크롤로 기억) 처음 그릴 때·내가 보낸 직후면 맨 아래로. 위로 올려 읽는 중이면 그대로 두고 '↓ 새 메시지 n'
  if (chatAtBottom || chatForceBottom || prevLast === 0) chatToBottom();
  else { newWhileUp += list.filter((x) => x.id > prevLast).length; showNewBtn(); }
  chatForceBottom = false;
}
$('chatList').onclick = (ev) => {
  const j = ev.target.closest('[data-jump]');
  if (j) { // 원래 요청으로 이동 + 잠깐 강조
    const li = $('chatList').querySelector(`li[data-eid="${j.dataset.jump}"]`);
    li?.querySelector('details')?.setAttribute('open', ''); // 접힌 맡김·보고면 펼침
    if (!li) { $('askNote').textContent = '그 요청은 대화창에 보이는 범위(최근 300개)보다 오래됐습니다'; return; }
    li.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' }); li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash');
    return;
  }
  const a = ev.target.closest('[data-file]');
  if (a) { ev.preventDefault(); return openViewer(a.dataset.file); }
  if (ev.target.closest('a[data-todo]')) { ev.preventDefault(); return setTab('todo'); }
  if (ev.target.closest('.bb a')) return; // 말풍선 안 링크는 그대로 열기
  const b = ev.target.closest('[data-more]'); if (!b) return; // 말풍선 아무 데나가 아니라 '전체 보기' 버튼만
  openMsg(events.find((e) => e.id === +b.closest('.bb').dataset.id));
};
// 말풍선엔 앞부분만: 코드 블록이 있으면 그 앞 글까지("…붙여 넣을 프롬프트예요."), 아니면 4줄·280자까지. 나머지는 '전체 보기' 창에서
function preview(t) {
  const i = t.indexOf('```'), code = i >= 0;
  let head = (code ? t.slice(0, i) : t).trim();
  if (code && !head) head = first(t.slice(i + 3).replace(/^[^\n]*\n/, '')) + ' …'; // 글 없이 코드로 시작하면 코드 첫 줄만
  const lines = head.split('\n'), cut = lines.length > 4 || head.length > 280;
  if (cut) head = lines.slice(0, 4).join('\n').slice(0, 280).replace(/\s+\S*$/, '') + ' …';
  return { text: head, more: code || cut, code };
}
// 메시지 끝의 "[첨부] 경로 (크기)" 줄을 떼어 이미지는 작은 미리보기, 그 밖은 이름·크기로(누르면 크게 보기 창)
const ATT_RE = /^\[첨부\] (첨부\/[^\n]+?) \(([^)\n]+)\)$/;
function splitAtt(t) {
  const atts = [], body = String(t || '').split('\n').filter((l) => { const m = ATT_RE.exec(l.trim()); if (m) atts.push({ path: m[1], size: m[2] }); return !m; }).join('\n').trim();
  return { body: body === '(첨부만 보냄)' ? '' : body, atts };
}
const attName = (p) => p.split('/').pop().replace(/^[a-z0-9]{4}-/, '');
const attHtml = (atts) => (atts.length ? `<span class="atts">${atts.map((a) => (kindOf(a.path) === 'image'
  ? `<button type="button" class="att img" data-file="${esc(a.path)}" title="${esc(attName(a.path))} (${esc(a.size)})"><img src="${fileUrl(a.path)}" alt="${esc(attName(a.path))}" loading="lazy"></button>`
  : `<button type="button" class="att" data-file="${esc(a.path)}"><b>${esc(attName(a.path))}</b><small>${esc(a.size)}</small></button>`)).join('')}</span>` : '');
// 전체 보기 창: 마크다운 정리해서 크게, 코드 블록마다 복사 버튼(프롬프트 그대로 붙여 넣기용)
let mvText = '';
function openMsg(e) {
  if (!e) return;
  resetJobModal(); // 추가 요청 칸·목록은 '진행' 일 모달에서만
  const pr = pair(e), k = keyOf(e);
  mvText = e.type === 'prompt' ? stripSys(e.text) : e.text;
  $('mvWho').textContent = e.type === 'reply' ? `${nameOf(k)}의 답` : pr ? `${nameOf(pr[0])} → ${nameOf(pr[1])}` : nameOf(k);
  $('mvMeta').textContent = `${e.machine} · ${new Date(e.ts).toLocaleString('ko-KR')} · ${mvText.length.toLocaleString()}자`;
  { const sa = splitAtt(mvText); $('mvBody').innerHTML = md(sa.body) + attHtml(sa.atts); }
  $('mvBody').querySelectorAll('pre').forEach((pre) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'code-copy'; b.textContent = '복사';
    b.onclick = async () => { const t = pre.querySelector('code').textContent; try { await navigator.clipboard.writeText(t); b.textContent = '복사됨'; } catch { prompt('코드', t); } setTimeout(() => (b.textContent = '복사'), 1500); };
    const wrap = document.createElement('div'); wrap.className = 'code-wrap'; pre.replaceWith(wrap); wrap.append(pre, b);
  });
  $('msgView').showModal(); $('msgView').querySelector('.mv-body').scrollTop = 0;
}
function resetJobModal() { $('mvJump').hidden = true; $('mvAsk').hidden = true; $('mvAsk').dataset.id = ''; $('mvAsk').dataset.to = ''; $('mvFollow').innerHTML = ''; $('mvAskText').value = ''; $('mvAskNote').textContent = ''; mvAtt = []; renderMvAtt(); }
$('msgView').addEventListener('close', resetJobModal); // 닫으면 초기화(다음에 다른 데서 열 때 남지 않게)
$('mvClose').onclick = () => $('msgView').close();
$('mvBody').addEventListener('click', (ev) => { const a = ev.target.closest('[data-file]'); if (a) { $('msgView').close(); openViewer(a.dataset.file); } });
$('msgView').onclick = (ev) => { if (ev.target === $('msgView')) $('msgView').close(); };
$('mvCopy').onclick = async () => { try { await navigator.clipboard.writeText(mvText); $('mvCopy').textContent = '복사됨'; } catch { prompt('글', mvText); } setTimeout(() => ($('mvCopy').textContent = '글 복사'), 1500); };

// ---- 허브에서 세션에 지시 ----
// PM: 이름에 'PM'이 든 세션(예: "[server] PM")이 요청을 받아 나눠 줌 → 지시 받는 기본 세션. 다른 세션을 고르면 이 화면을 닫을 때까지 그쪽
// 받는 세션은 사용자가 고를 때만 바뀜. 화면을 열면 PM. 그 전엔 새 이벤트마다 '가장 최근에 일한 세션'으로 다시 골라서 저절로 바뀌었음
let askTo = null, askPicked = false, chatFor = null;
const isPM = (s) => /(^|[\s\]])PM\b/.test(s?.name || '');
function renderAskTo() {
  const all = [...sessions.values()].filter((s) => !isHidden(s.key));
  if (!askPicked) { // 아직 안 골랐으면 PM(나중에 PM이 떠도 PM으로). PM이 없을 때만 처음 한 번 아무 세션
    const pm = all.filter(isPM).sort((a, b) => (a.state === 'offline') - (b.state === 'offline') || b.last - a.last)[0]; // 떠 있는 PM 먼저, 그다음 최근
    if (pm) askTo = pm.key;
    else if (!askTo || !sessions.has(askTo)) askTo = all.filter((s) => s.state !== 'offline').sort((a, b) => b.last - a.last)[0]?.key || null;
  }
  // 목록: 접속한 세션 + 지금 고른 세션(끊겨도 빠지지 않게 — 빠지면 브라우저가 첫 항목으로 바꿔 버림)
  const list = all.filter((s) => s.state !== 'offline' || s.key === askTo).sort((a, b) => isPM(b) - isPM(a) || a.key.localeCompare(b.key));
  $('askTo').innerHTML = list.length ? list.map((s) => `<option value="${esc(s.key)}"${s.key === askTo ? ' selected' : ''}>${isPM(s) ? 'PM · ' : ''}${esc(label(s))} · ${esc(s.machine)} · ${STATE_WORD[s.state]}</option>`).join('')
    : '<option value="">접속한 세션이 없습니다</option>';
  // 기본은 PM에게. 다른 세션이면 보내기 단추·테두리·안내 줄로 분명히
  const t = sessions.get(askTo), pm = all.find(isPM), toPM = isPM(t);
  $('askSend').textContent = !t ? '보내기' : toPM ? 'PM에게 보내기' : `${label(t)}에게 보내기`;
  $('askSend').disabled = !askTo;
  $('ask').classList.toggle('direct', !!t && !toPM);
  $('askBanner').hidden = !t || toPM;
  if (t && !toPM) $('askBanner').innerHTML = `PM을 거치지 않고 <b>${esc(label(t))}</b>에게 바로 보냅니다${pm ? ' <button type="button" class="link-btn" data-back-pm>PM에게로</button>' : ' (PM 세션이 아직 없음)'}`;
  const keysHint = innerWidth >= 560 ? ' (Enter 보내기, Shift+Enter 줄바꿈)' : ''; // 폰엔 키 안내를 뺌
  $('askText').placeholder = toPM ? 'PM에게 할 일을 말하세요' + keysHint : t ? `${label(t)}에게 바로 지시${innerWidth >= 560 ? ' (Enter 보내기)' : ''}` : '지시할 세션이 없습니다';
  if (!pm) $('askOther').hidden = false; // PM이 없으면 고르는 칸을 열어 둠
  $('askPick').hidden = !pm;
  // 머리: PM 상태 + 접는 세션 목록
  const h = t || pm; // 머리 = 지금 대화하는 에이전트
  $('pmName').textContent = h ? label(h) : 'PM';
  $('pmState').textContent = h ? STATE_WORD[h.state] : '아직 안 떠 있음';
  $('pmDot').className = `dot ${h ? h.state : 'offline'}`;
  $('chatBackPM').hidden = !t || toPM || !pm;
  const info = h && !toPM ? [h.desc, h.state === 'busy' && h.doing ? '하는 일: ' + first(h.doing) : '', h.model ? modelName(h.model) : '', h.machine].filter(Boolean).join(' · ') : '';
  $('chatInfo').hidden = !info; $('chatInfo').textContent = info;
  if (chatFor !== askTo) { chatFor = askTo; chatCount = -1; renderChat(); } // 에이전트를 바꾸면 대화창도 그 에이전트 것으로
  const on = all.filter((s) => s.state !== 'offline'), busy = on.filter((s) => s.state === 'busy').length;
  $('whoSum').textContent = `세션 ${on.length}${busy ? ` · 일하는 중 ${busy}` : ''}`;
  const ordered = agentOrder(all);
  $('whoList').innerHTML = ordered.map((s) => agentRow(s, true)).join(''); // 대화창 위 '세션 n ▾'도 같은 줄 모양
  renderAgents(ordered);
}
// ---- 에이전트 목록(왼쪽 위 로고 밑 드롭다운 · 대화창 위 목록이 같은 데이터·같은 줄 모양) ----
// 정렬: PM 먼저 → 일하는 중 → 이름순. 끊긴 세션은 아래 접힘에 흐리게
const agentOrder = (list) => [...list].sort((a, b) => isPM(b) - isPM(a) || (a.state === 'offline') - (b.state === 'offline') || (b.state === 'busy') - (a.state === 'busy') || label(a).localeCompare(label(b), 'ko'));
function agentRow(s, compact) {
  const woke = s.wokeAt && Date.now() - s.wokeAt < 10 * 60e3 && s.state !== 'asleep' ? ' · 방금 깨어남' : ''; // 깨우기 결과
  const doing = (s.doing ? `${STATE_WORD[s.state]} — ${first(s.doing)}` : STATE_WORD[s.state]) + woke;
  return `<li class="ag ${s.state}${isPM(s) ? ' pm' : ''}"><button type="button" data-k="${esc(s.key)}">
    <span class="dot ${s.state}"></span>
    <span class="ag-main"><b>${isPM(s) ? '<span class="ag-pm">PM</span>' : ''}${esc(label(s))}</b>${s.desc ? `<span class="ag-desc">${esc(s.desc)}</span>` : ''}${compact ? '' : `<span class="ag-doing">${esc(doing)}</span>`}</span>
    <span class="ag-meta">${esc(s.machine)}${s.model ? ` · ${esc(modelName(s.model))}` : ''}<br>${ago(s.last)}</span></button>
    <div class="ag-act" hidden><button type="button" data-ag="send" class="primary">이 세션에 보내기</button><button type="button" data-ag="map">지도에서 보기</button><button type="button" data-ag="rename">이름·설명</button><button type="button" data-ag="hide">숨기기</button>${s.state === 'asleep' ? '<button type="button" data-ag="wake">깨우기</button>' : ''}</div></li>`;
}
function renderAgents(ordered) {
  const on = ordered.filter((s) => s.state !== 'offline'), off = ordered.filter((s) => s.state === 'offline'), busy = on.filter((s) => s.state === 'busy').length;
  const sleep = on.filter((s) => s.state === 'asleep').length;
  $('agentsBtn').textContent = `에이전트 ${on.length}${busy ? ` · 일하는 중 ${busy}` : ''}${sleep ? ` · 대기 끊김 ${sleep}` : ''} ▾`;
  const wa = $('wakeAll'); wa.hidden = !sleep; if (!wa.disabled) wa.textContent = `전체 깨우기 ${sleep}`;
  const open = $('agentsPanel').querySelector('.ag.open button[data-k]')?.dataset.k;
  $('agentsList').innerHTML = on.length ? on.map((s) => agentRow(s)).join('') : '<li class="empty">접속한 에이전트가 없습니다</li>';
  $('agentsOff').hidden = !off.length;
  $('agentsOff').querySelector('summary').textContent = `끊긴 에이전트 ${off.length}`;
  $('agentsOffList').innerHTML = off.map((s) => agentRow(s)).join('');
  if (open) { const li = $('agentsPanel').querySelector(`button[data-k="${CSS.escape(open)}"]`)?.closest('.ag'); if (li) { li.classList.add('open'); li.querySelector('.ag-act').hidden = false; } }
}
function agentsShow(on) {
  const p = $('agentsPanel'); $('agentsBtn').setAttribute('aria-expanded', String(on));
  if (on) { p.hidden = false; requestAnimationFrame(() => p.classList.add('show')); }
  else { p.classList.remove('show'); setTimeout(() => { if (!p.classList.contains('show')) p.hidden = true; }, reduced ? 0 : 160); }
}
$('agentsBtn').onclick = () => agentsShow($('agentsPanel').hidden);
$('agentsPanel').addEventListener('click', (ev) => {
  if (ev.target.closest('.ap-x')) return agentsShow(false);
  if (ev.target.closest('#wakeAll')) return wakeAll(ev.target.closest('#wakeAll'));
  const act = ev.target.closest('[data-ag]'), li = ev.target.closest('.ag'); if (!li) return;
  const k = li.querySelector('button[data-k]').dataset.k;
  if (act?.dataset.ag === 'wake') { act.disabled = true; api('wake', { method: 'POST', body: JSON.stringify({ key: k }) }).then((r) => r.json()).then((d) => { act.textContent = wakeWord(d); }, () => { act.disabled = false; act.textContent = '못 보냄'; }); return; }
  if (act) {
    agentsShow(false);
    if (act.dataset.ag === 'send') pickTarget(k);
    else if (act.dataset.ag === 'rename') renameCard(k);
    else if (act.dataset.ag === 'hide') hideCard(k);
    else if (act.dataset.ag === 'map') { setTab('board'); const el = cards.get(k)?.el; if (el) { el.classList.remove('spot'); void el.offsetWidth; el.classList.add('spot'); setTimeout(() => openCard(k), 300); } }
    return;
  }
  // 줄을 누르면 그 줄 아래에 메뉴(다시 누르면 닫힘), 지도 카드도 잠깐 강조
  const was = li.classList.contains('open');
  $('agentsPanel').querySelectorAll('.ag.open').forEach((x) => { x.classList.remove('open'); x.querySelector('.ag-act').hidden = true; });
  if (!was) { li.classList.add('open'); li.querySelector('.ag-act').hidden = false; const el = cards.get(k)?.el; if (el) { el.classList.remove('spot'); void el.offsetWidth; el.classList.add('spot'); } }
});
document.addEventListener('pointerdown', (ev) => { if (!$('agentsPanel').hidden && !ev.target.closest('#agentsPanel, #agentsBtn')) agentsShow(false); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('agentsPanel').hidden) agentsShow(false); });
function pickTarget(key) { if (!sessions.has(key)) return; askTo = key; askPicked = true; if (!isPM(sessions.get(key))) $('askOther').hidden = false; renderAskTo(); setTab('chat'); $('askText').focus(); }
$('askTo').onchange = () => { askTo = $('askTo').value; askPicked = true; renderAskTo(); };
$('askPick').onclick = () => { const o = $('askOther'); o.hidden = !o.hidden; $('askPick').setAttribute('aria-expanded', String(!o.hidden)); if (!o.hidden) $('askTo').focus(); };
$('chatBackPM').onclick = () => { const pm = [...sessions.values()].filter((s) => !isHidden(s.key)).find(isPM); if (pm) { askTo = pm.key; askPicked = false; $('askOther').hidden = true; renderAskTo(); } };
$('askBanner').onclick = (ev) => { if (ev.target.closest('[data-back-pm]')) { const pm = [...sessions.values()].find(isPM); if (pm) { askTo = pm.key; askPicked = false; $('askOther').hidden = true; renderAskTo(); } } };
$('whoList').onclick = (ev) => { const b = ev.target.closest('button[data-k]'); if (b) { pickTarget(b.dataset.k); $('who').open = false; } }; // 대화창 쪽 목록은 누르면 바로 보내기
$('askText').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('ask').requestSubmit(); } };
// ---- 첨부: 붙여넣기·끌어 놓기·📎. 보낼 때 파일 서버 '첨부/날짜/'에 올리고 메시지에 "[첨부] 경로 (크기)" 줄을 붙임
// → 받는 쪽 hub-hook.sh wait가 그 줄을 보고 ~/.claude/hub-inbox/에 받아 둔 뒤 로컬 경로를 알려 줌(Claude가 Read로 봄)
const ATTACH_MAX = 50 * 1048576, ATTACH_MAX_N = 10, ATTACH_OK = /\.(png|jpe?g|gif|webp|pdf|txt|md|json|csv|log|ya?ml|js|ts|py|sh|html|css|zip|mp4)$/i;
let attach = []; // {file, url, err?, busy?} — err(빨강)·busy(바꾸는 중)는 보내기를 막음(조용히 빠지지 않게)
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf', 'text/plain': 'txt', 'video/mp4': 'mp4' };
const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /hei[cf]/i.test(f.type);
// 아이폰 사진(HEIC)은 서버가 안 받으니 JPEG로 바꿈(iOS WebKit은 HEIC를 그릴 줄 앎)
function heicToJpeg(f) {
  return new Promise((ok, no) => {
    const u = URL.createObjectURL(f), im = new Image();
    im.onload = () => { const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; c.getContext('2d').drawImage(im, 0, 0); URL.revokeObjectURL(u);
      c.toBlob((bl) => (bl ? ok(new File([bl], f.name.replace(/\.(heic|heif)$/i, '') + '.jpg', { type: 'image/jpeg' })) : no(new Error('JPEG로 못 바꿈'))), 'image/jpeg', 0.9); };
    im.onerror = () => { URL.revokeObjectURL(u); no(new Error('HEIC를 못 읽음 — 사진 앱에서 JPEG로 내보내 주세요')); };
    im.src = u;
  });
}
function addAttach(list) {
  for (const f0 of list) {
    if (!f0) continue;
    // 붙여넣은 스크린샷·iOS에서 끌어 온 사진은 이름이 'image.png'뿐이거나 없고, 확장자 없이 type만 올 때가 있어 이름을 만들어 줌
    const ext = MIME_EXT[f0.type] || (f0.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    let f = f0;
    if (!f0.name || f0.name === 'image.png') f = new File([f0], `붙여넣기-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${ext}`, { type: f0.type });
    else if (!/\.[a-z0-9]{2,5}$/i.test(f0.name) && f0.type) f = new File([f0], `${f0.name}.${ext}`, { type: f0.type });
    const a = { file: f, url: null };
    if (attach.filter((x) => !x.err).length >= ATTACH_MAX_N) a.err = `한 번에 ${ATTACH_MAX_N}개까지`;
    else if (f.size > ATTACH_MAX) a.err = '50MB까지';
    else if (isHeic(f)) { a.busy = true; heicToJpeg(f).then((j) => { a.file = j; a.url = URL.createObjectURL(j); }, (e) => { a.err = e.message; }).finally(() => { a.busy = false; renderAttach(); }); }
    else if (!ATTACH_OK.test(f.name)) a.err = `${(f.name.split('.').pop() || '?').toUpperCase()}는 못 보냄(이미지·PDF·글·코드·zip·mp4만)`;
    else if (!f.size) a.err = '빈 파일(0B) — 다시 넣어 주세요';
    if (!a.err && !a.busy && f.type.startsWith('image/')) a.url = URL.createObjectURL(f);
    attach.push(a);
  }
  renderAttach();
}
function attachBlock() { // 보내기를 막는 이유(없으면 '')
  if (attach.some((a) => a.busy)) return '첨부를 준비하는 중입니다. 잠시 뒤 보내세요';
  if (attach.some((a) => a.err)) return '빨간 첨부는 못 보냅니다. ×로 빼고 보내세요';
  return '';
}
function renderAttach() {
  $('askFiles').innerHTML = attach.map((a, i) => `<li class="${a.err ? 'bad' : a.busy ? 'busy' : ''}">${a.url ? `<img src="${a.url}" alt="">` : `<span class="af-ext">${a.busy ? '…' : esc((a.file.name.split('.').pop() || '').toUpperCase())}</span>`}<span class="af-nm">${esc(a.file.name)}<small>${a.err ? esc(a.err) : a.busy ? 'JPEG로 바꾸는 중' : size(a.file.size)}</small></span><button type="button" data-i="${i}" aria-label="${esc(a.file.name)} 빼기">×</button></li>`).join('');
  $('askNote').textContent = attachBlock();
}
$('askFiles').onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; const [a] = attach.splice(+b.dataset.i, 1); if (a?.url) URL.revokeObjectURL(a.url); renderAttach(); };
$('askPickFile').onchange = () => { addAttach([...$('askPickFile').files]); $('askPickFile').value = ''; };
$('askText').addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addAttach(fs); } });
const chatBox = document.querySelector('.chat');
// iOS는 끌어 온 사진의 types에 'Files'가 없고 'public.png'·'image/png'·URL 글로 올 때가 있어 넓게 받음
const dragHasFile = (dt) => dt && [...dt.types].some((t) => t === 'Files' || /^(image\/|public\.|com\.)/i.test(t) || t === 'text/uri-list');
chatBox.addEventListener('dragover', (e) => { if (dragHasFile(e.dataTransfer)) { e.preventDefault(); chatBox.classList.add('drag'); } });
chatBox.addEventListener('dragleave', (e) => { if (!chatBox.contains(e.relatedTarget)) chatBox.classList.remove('drag'); });
chatBox.addEventListener('drop', async (e) => {
  const dt = e.dataTransfer; if (!dragHasFile(dt)) return;
  e.preventDefault(); chatBox.classList.remove('drag');
  let fs = [...dt.files];
  if (!fs.length) fs = [...dt.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
  if (!fs.length) { // 파일 대신 주소(URL)로만 온 경우: 같은 곳·blob·data 주소면 받아 와서 파일로
    const u = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split('\n').find((l) => l && !l.startsWith('#'))?.trim();
    if (u) { try { const r = await fetch(u); if (!r.ok) throw 0; const bl = await r.blob(); fs = [new File([bl], decodeURIComponent(u.split(/[?#]/)[0].split('/').pop() || ''), { type: bl.type })]; } catch { $('askNote').textContent = `끌어 놓은 것이 파일이 아니라 주소로 왔고 받아 오지 못했습니다(${u.slice(0, 60)}). 📎로 넣어 주세요`; return; } }
  }
  if (!fs.length) { $('askNote').textContent = `끌어 놓은 것에서 파일을 못 읽었습니다(형식: ${[...dt.types].join(', ') || '없음'}). 📎로 넣어 주세요`; return; }
  addAttach(fs);
});
function putFile(p, file, onPct) {
  return new Promise((ok, no) => {
    const x = new XMLHttpRequest(); x.open('PUT', fileUrl(p));
    x.upload.onprogress = (e) => e.lengthComputable && onPct(Math.round((e.loaded / e.total) * 100));
    x.onload = () => (x.status === 200 ? ok() : no(new Error((() => { try { return JSON.parse(x.responseText).error; } catch { return `올리기 실패(${x.status})`; } })())));
    x.onerror = () => no(new Error('올리다 끊김'));
    x.send(file);
  });
}
$('ask').onsubmit = async (e) => {
  e.preventDefault();
  let text = $('askText').value.trim(); if ((!text && !attach.length) || !askTo) return;
  const blk = attachBlock(); if (blk) { $('askNote').textContent = blk; return; }
  const btn = $('askSend'); btn.disabled = true; $('askNote').textContent = '';
  if (attach.length) {
    const day = new Date().toLocaleDateString('sv-SE'), lines = [];
    try {
      for (const [i, a] of attach.entries()) {
        const p = `첨부/${day}/${Math.random().toString(36).slice(2, 6)}-${a.file.name.replace(/[\\/]/g, '_')}`;
        await putFile(p, a.file, (v) => ($('askNote').textContent = `첨부 올리는 중 ${i + 1}/${attach.length} · ${v}%`));
        lines.push(`[첨부] ${p} (${size(a.file.size)})`);
      }
    } catch (err) { btn.disabled = false; const a = attach[lines.length]; if (a) a.err = `못 올림: ${err.message}`; renderAttach(); return; }
    text = `${text || '(첨부만 보냄)'}\n\n${lines.join('\n')}`;
  }
  const use = toolsIn(text); if (use.length) text = `${use.map(toolBlock).join('\n\n')}\n\n---\n${text}`; // 고른 도구·@도구 → 지시 앞에
  const r = await api('ask', { method: 'POST', body: JSON.stringify({ to: askTo, text }) }).catch(() => null);
  btn.disabled = false;
  if (!r?.ok) { $('askNote').textContent = r ? (await r.json().catch(() => ({}))).error || '보내지 못했습니다' : '서버에 연결되지 않습니다'; return; }
  $('askText').value = ''; chatForceBottom = true; chatToBottom(); // 보낸 직후엔 항상 맨 아래
  attach.forEach((a) => a.url && URL.revokeObjectURL(a.url)); attach = []; renderAttach();
  $('askTool').value = '';
  const d = await r.json().catch(() => ({}));
  $('askNote').textContent = d.asleep ? `보냈어요. 그 세션은 지금 대기가 끊겨 바로 못 받아요 — ${d.waker ? `${d.waker}에게 깨우기를 부탁했어요` : '깨울 세션이 없어요. 그 컴퓨터에서 세션을 한 번 깨워 주세요'}.` : d.waiting ? '보냈어요. 세션이 지금 일을 끝내면 바로 받아요(hook wait가 있어야 함).' : '';
};
$('sessionList').onclick = (ev) => { const li = ev.target.closest('li[data-k]'); if (!li) return; ev.target.closest('[data-rename]') ? renameCard(li.dataset.k) : ev.target.closest('[data-hide]') ? hideCard(li.dataset.k) : pickTarget(li.dataset.k); };


// ---- 파일(맥 Finder처럼: 폴더 들어가기, 아이콘/목록 보기, 눌러서 크게 보기) ----
const FILE_API = BASE + 'api/files';
const fileUrl = (p, dl) => `${FILE_API}/${p.split('/').map(encodeURIComponent).join('/')}${dl ? '?dl=1' : ''}`;
const EXT = (p) => (p.split('/').pop().includes('.') ? p.split('.').pop().toLowerCase() : '');
const KINDS = [
  ['image', /^(png|jpe?g|gif|webp|avif|bmp)$/], ['video', /^(mp4|m4v|webm|mov|mkv)$/], ['audio', /^(mp3|wav|m4a|ogg|flac|aac)$/],
  ['pdf', /^pdf$/], ['code', /^(js|mjs|cjs|ts|tsx|jsx|py|sh|rs|go|java|kt|swift|c|h|cpp|css|html|json|ya?ml|toml|xml|sql)$/],
  ['doc', /^(txt|md|srt|vtt|log|csv|rtf|docx?|hwp|pptx?|xlsx?)$/], ['archive', /^(zip|tar|gz|tgz|7z|rar|bz2|xz)$/],
  ['app', /^(exe|msi|apk|aab|ipa|dmg|pkg|deb|appimage)$/],
];
const kindOf = (p) => (KINDS.find(([, r]) => r.test(EXT(p))) || ['other'])[0];
const TEXTY = /^(txt|md|srt|vtt|log|csv|js|mjs|cjs|ts|tsx|jsx|py|sh|rs|go|java|kt|swift|c|h|cpp|css|html|json|ya?ml|toml|xml|sql)$/;
const size = (n) => (n < 1024 ? `${n}B` : n < 1048576 ? `${Math.round(n / 1024)}KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1073741824).toFixed(2)}GB`);

// 아이콘(직접 그림): 폴더는 탭 달린 둥근 폴더, 파일은 귀퉁이 접힌 종이 + 가운데 종류 기호. 색은 허브 팔레트로 종류마다
const TINT = { video: ['#f4c8ff', '#d89ef0'], image: ['#8ef0df', '#5fcfbd'], audio: ['#ffc56e', '#e7a443'], pdf: ['#ff9aa8', '#e57388'],
  code: ['#9fe6ff', '#6cc4e6'], doc: ['#d9cdf2', '#b3a3d8'], archive: ['#f2b98a', '#d8955e'], app: ['#b7b0ff', '#8f86f0'], other: ['#8a7aa8', '#6d5e8a'] };
const SYM = {
  video: '<rect x="20" y="30" width="22" height="17" rx="2.5"/><path d="M20 35h22M20 42h22M25 30v5M31 30v5M37 30v5M25 42v5M31 42v5M37 42v5"/>',
  image: '<rect x="20" y="29" width="22" height="18" rx="2.5"/><circle cx="35.5" cy="34.5" r="2.2"/><path d="M21 45l6.5-7 5 5 3-3 5.5 5"/>',
  audio: '<path d="M28 44V31l11-2.5V42"/><circle cx="25.5" cy="44" r="3"/><circle cx="36.5" cy="42" r="3"/>',
  pdf: '<path d="M22 31h18M22 36h18M22 41h12"/><rect x="34" y="40" width="8" height="7" rx="1.5"/>',
  code: '<path d="M26 32l-6 6 6 6M36 32l6 6-6 6M33 29l-4 18"/>',
  doc: '<path d="M22 30h18M22 35h18M22 40h18M22 45h11"/>',
  archive: '<path d="M31 8v4M31 15v4M31 22v4"/><rect x="27.5" y="28" width="7" height="10" rx="1.5"/><path d="M31 31.5v3"/>',
  app: '<path d="M31 28l11 5v12l-11 5-11-5V33z"/><path d="M20 33l11 5 11-5M31 38v12"/>',
  other: '',
};
function iconSvg(k) {
  if (k === 'folder') return '<svg class="ic" viewBox="0 0 64 64" aria-hidden="true"><path d="M6 17a5 5 0 0 1 5-5h13.5a4 4 0 0 1 2.8 1.2L31 17h22a5 5 0 0 1 5 5v3H6z" fill="#5fcfbd"/><rect x="6" y="21" width="52" height="33" rx="5" fill="#8ef0df"/><path d="M6 26h52" stroke="#ffffff55" stroke-width="1.5"/></svg>';
  const [c, d] = TINT[k] || TINT.other;
  return `<svg class="ic" viewBox="0 0 64 64" aria-hidden="true"><path d="M16 5h21l14 14v36a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z" fill="${c}"/><path d="M37 5v10a4 4 0 0 0 4 4h10z" fill="${d}"/><g fill="none" stroke="#1b1029" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${SYM[k] || ''}</g></svg>`;
}

let fileRows = [], cwd = '', view = 'grid', findT, items = [];
try { view = localStorage.getItem('fileView') === 'list' ? 'list' : 'grid'; } catch {}
async function loadFiles() {
  const r = await fetch(`${FILE_API}?prefix=${encodeURIComponent(cwd)}`, { credentials: 'same-origin' }).catch(() => null);
  if (!r?.ok) return;
  fileRows = (await r.json()).files; renderFiles();
}
// 지금 폴더(cwd) 아래를 폴더·파일로 나눔. 찾기 칸에 글이 있으면 하위 폴더까지 이름으로 찾아 파일만
function children() {
  const q = $('fileFind').value.trim().toLowerCase(), dirs = new Map(), files = [];
  for (const f of fileRows) {
    const rest = f.path.slice(cwd.length);
    if (q) { if (rest.toLowerCase().includes(q)) files.push({ ...f, name: rest }); continue; }
    const i = rest.indexOf('/');
    if (i < 0) { files.push({ ...f, name: rest }); continue; }
    const n = rest.slice(0, i), d = dirs.get(n) || { dir: true, name: n, path: cwd + n + '/', count: 0, size: 0, ts: 0 };
    d.count++; d.size += f.size; d.ts = Math.max(d.ts, f.ts); dirs.set(n, d);
  }
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
  return [...[...dirs.values()].sort(byName), ...files.sort(byName)];
}
function renderCrumbs() {
  const parts = cwd.split('/').filter(Boolean);
  $('crumbs').innerHTML = (cwd ? `<button type="button" class="back" data-cd="${esc(parts.slice(0, -1).map((x) => x + '/').join(''))}" aria-label="위 폴더로">←</button>` : '')
    + `<button type="button" data-cd="">파일</button>`
    + parts.map((x, i) => `<span aria-hidden="true">/</span><button type="button" data-cd="${esc(parts.slice(0, i + 1).map((y) => y + '/').join(''))}"${i === parts.length - 1 ? ' aria-current="page"' : ''}>${esc(x)}</button>`).join('');
}
function renderFiles() {
  renderCrumbs();
  items = children();
  const list = $('fileList'); list.className = view === 'list' ? 'file-list' : 'file-grid';
  document.querySelectorAll('.view-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  if (!items.length) {
    list.innerHTML = `<li class="empty">${$('fileFind').value.trim() ? '이 폴더에 그 이름의 파일이 없습니다.' : cwd ? '빈 폴더입니다. 파일을 끌어 놓으면 여기로 올라갑니다.' : '아직 올린 파일이 없습니다. 올리기를 누르거나 파일을 여기에 끌어 놓으세요.'}</li>`;
    return;
  }
  list.innerHTML = items.map((it, i) => {
    const k = it.dir ? 'folder' : kindOf(it.path);
    const pic = k === 'image' ? `<span class="thumb"><img src="${fileUrl(it.path)}" alt="" loading="lazy" draggable="false"></span>` : iconSvg(k);
    const meta = it.dir ? `${it.count}개 · ${size(it.size)}` : `${size(it.size)} · ${esc(it.machine || '')} · ${ago(it.ts)}`;
    return `<li><button type="button" class="fi${sel.has(it.path) ? ' sel' : ''}" data-i="${i}" draggable="true" aria-pressed="${sel.has(it.path)}" title="${esc(it.name)}">${pic}<span class="nm">${esc(it.name)}</span><small>${meta}</small></button></li>`;
  }).join('');
}
function cd(path) { cwd = path; sel.clear(); $('fileFind').value = ''; loadFiles(); }
$('crumbs').onclick = (ev) => { const b = ev.target.closest('button[data-cd]'); if (b) cd(b.dataset.cd); };
$('fileList').onclick = (ev) => {
  const b = ev.target.closest('.fi'); if (!b) return;
  if (pressed) { pressed = false; return; } // 길게 눌러 메뉴를 연 뒤 따라오는 click
  const it = items[+b.dataset.i];
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey || sel.size) { toggleSel(it.path); return; } // 고르는 중엔 누르면 고르기
  it.dir ? cd(it.path) : openViewer(it.path);
};
document.querySelector('.view-seg').onclick = (ev) => {
  const b = ev.target.closest('button[data-view]'); if (!b) return;
  view = b.dataset.view; try { localStorage.setItem('fileView', view); } catch {} renderFiles();
};
$('fileFind').oninput = () => { clearTimeout(findT); findT = setTimeout(renderFiles, 150); };

// ---- 파일·폴더 메뉴(우클릭·길게 누르기)·여러 개 고르기·끌어서 다른 폴더로 옮기기 ----
const sel = new Set(); let pressed = false;
function toggleSel(p) { sel.has(p) ? sel.delete(p) : sel.add(p); renderFiles(); }
const baseName = (p) => p.replace(/\/$/, '').split('/').pop();
const parentOf = (p) => p.replace(/\/$/, '').split('/').slice(0, -1).map((x) => x + '/').join('');
// 고른 것(눌린 것이 고른 것 안에 있으면 고른 것 전부, 아니면 그것 하나)
const targetsFor = (p) => (sel.has(p) ? [...sel] : [p]);
function openMenu(p, x, y) {
  const ps = targetsFor(p), one = ps.length === 1, dir = p.endsWith('/'), m = $('fileMenu');
  const acts = one ? (dir ? ['open', 'rename', 'move', 'select', 'del'] : ['open', 'down', 'copy', 'share', 'rename', 'move', 'select', 'del']) : ['move', 'unselect', 'del'];
  const word = { open: '열기', down: '받기', copy: '주소 복사', share: '공유 링크(24시간)', rename: '이름 바꾸기', move: '옮기기…', select: sel.has(p) ? '고르기 풀기' : '고르기(여러 개)', unselect: '고르기 모두 풀기', del: one ? '지우기' : `${ps.length}개 지우기` };
  m.innerHTML = `<p class="cm-h">${esc(one ? baseName(p) : `${ps.length}개 고름`)}</p>` + acts.map((a) => `<button type="button" role="menuitem" data-act="${a}"${a === 'del' ? ' class="danger"' : ''}>${word[a]}</button>`).join('');
  m.dataset.p = p; m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`; m.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  m.querySelector('button').focus();
}
const closeMenu = () => { $('fileMenu').hidden = true; };
$('fileList').addEventListener('contextmenu', (ev) => {
  const b = ev.target.closest('.fi'); if (!b) return;
  ev.preventDefault(); const r = b.getBoundingClientRect();
  openMenu(items[+b.dataset.i].path, ev.clientX || r.left + 20, ev.clientY || r.top + 20); // 키보드(메뉴 키)면 좌표가 0
});
// 폰·태블릿: 길게 누르기(0.5초, 손가락이 10px 넘게 움직이면 취소)
let lp = null;
$('fileList').addEventListener('pointerdown', (ev) => {
  const b = ev.target.closest('.fi'); if (!b || ev.pointerType === 'mouse') return;
  const x = ev.clientX, y = ev.clientY;
  lp = { x, y, t: setTimeout(() => { lp = null; pressed = true; navigator.vibrate?.(15); openMenu(items[+b.dataset.i].path, x, y); }, 500) };
});
const lpCancel = (ev) => { if (lp && (ev.type !== 'pointermove' || Math.hypot(ev.clientX - lp.x, ev.clientY - lp.y) > 10)) { clearTimeout(lp.t); lp = null; } };
['pointerup', 'pointercancel', 'pointermove'].forEach((t) => $('fileList').addEventListener(t, lpCancel));
document.addEventListener('pointerdown', (ev) => { if (!$('fileMenu').hidden && !ev.target.closest('#fileMenu')) closeMenu(); });
document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Escape') return;
  if (!$('fileMenu').hidden) { closeMenu(); return; }
  if (sel.size && $('files').contains(document.activeElement)) { sel.clear(); renderFiles(); }
});
$('fileMenu').onkeydown = (ev) => { // 위·아래 화살표로 옮겨 다님
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  ev.preventDefault(); const bs = [...$('fileMenu').querySelectorAll('button')], i = bs.indexOf(document.activeElement);
  bs[(i + (ev.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
};
$('fileMenu').onclick = async (ev) => {
  const b = ev.target.closest('button[data-act]'); if (!b) return;
  const p = $('fileMenu').dataset.p, ps = targetsFor(p), a = b.dataset.act; closeMenu();
  if (a === 'open') return p.endsWith('/') ? cd(p) : openViewer(p);
  if (a === 'select') return toggleSel(p);
  if (a === 'unselect') { sel.clear(); return renderFiles(); }
  if (a === 'down') { if (IOS) { await openViewer(p); return $('vwDown').click(); } const l = document.createElement('a'); l.href = fileUrl(p, 1); l.download = baseName(p); l.click(); return; } // 아이폰은 크게 보기의 저장하기 흐름으로
  if (a === 'share') { await openViewer(p); return $('vwShare').click(); }
  if (a === 'copy') { const url = location.origin + fileUrl(p); try { await navigator.clipboard.writeText(url); } catch { prompt('주소', url); } return; }
  if (a === 'rename') {
    const n = prompt('새 이름', baseName(p))?.trim(); if (!n || n === baseName(p)) return;
    if (/[\\/]/.test(n) || n === '.' || n === '..') return alert('이름에 / \\ 는 못 씁니다');
    return moveItems([p], parentOf(p), n);
  }
  if (a === 'move') {
    const d = prompt('옮길 폴더(맨 위는 빈 칸). 예: 프로젝트/자료/', cwd); if (d == null) return;
    return moveItems(ps, d.trim().replace(/^\/+/, '').replace(/\/*$/, '/').replace(/^\/$/, ''));
  }
  if (a === 'del') {
    const files = ps.flatMap((x) => (x.endsWith('/') ? fileRows.filter((f) => f.path.startsWith(x)).map((f) => f.path) : [x]));
    if (!confirm(`${ps.length === 1 ? baseName(p) + (p.endsWith('/') ? ' 폴더' : '') : ps.length + '개'}를 지울까요?${files.length > ps.length ? ` 안에 든 파일 ${files.length}개가 모두 지워집니다.` : ''} 되돌릴 수 없습니다.`)) return;
    let bad = 0;
    for (const f of files) { const r = await fetch(fileUrl(f), { method: 'DELETE', credentials: 'same-origin' }).catch(() => null); if (!r?.ok) bad++; }
    sel.clear(); loadFiles(); if (bad) alert(`${bad}개는 지우지 못했습니다`);
  }
};
// 옮기기(이름 바꾸기도): 서버 {move:{from,to}}. 같은 이름이 이미 있으면 먼저 물음(서버는 덮어쓰지 않고 건너뜀)
async function moveItems(ps, dest, newName) {
  ps = ps.filter((x) => parentOf(x) !== dest || newName); // 이미 그 폴더에 있는 것은 뺌
  const bad = ps.find((x) => x.endsWith('/') && dest.startsWith(x)); if (bad) return alert(`${baseName(bad)} 폴더를 자기 안으로는 못 옮깁니다`);
  if (!ps.length) return;
  const r0 = await fetch(`${FILE_API}?prefix=${encodeURIComponent(dest)}`, { credentials: 'same-origin' }).catch(() => null);
  const there = r0?.ok ? (await r0.json()).files.map((f) => f.path) : [];
  const dst = (x) => dest + (newName || baseName(x)) + (x.endsWith('/') ? '/' : '');
  const clash = ps.filter((x) => there.some((t) => (x.endsWith('/') ? t.startsWith(dst(x)) : t === dst(x))));
  if (clash.length && !confirm(`'${dest || '맨 위'}'에 같은 이름이 있습니다: ${clash.map(baseName).join(', ')}\n확인 = 겹치는 파일은 그대로 두고 나머지만 옮김 · 취소 = 그만둠`)) return;
  let moved = 0, skipped = 0, err = '';
  for (const x of ps) {
    const r = await fetch(FILE_API, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ move: { from: x, to: dst(x) } }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) err = d.error || '서버에 연결되지 않습니다'; else { moved += d.moved; skipped += d.skipped.length; }
  }
  sel.clear(); loadFiles();
  $('moveNote').textContent = err ? `옮기지 못함: ${err}` : `${dest || '맨 위'}로 ${moved}개 옮김${skipped ? ` · 같은 이름이라 건너뜀 ${skipped}개` : ''}`;
  $('moveNote').className = `move-note${err ? ' bad' : ''}`; clearTimeout(moveItems.t); moveItems.t = setTimeout(() => ($('moveNote').textContent = ''), 5000);
}
// 끌어서 옮기기: 목록의 파일·폴더를 폴더 칸이나 위쪽 경로(상위 폴더)에 놓음. PC에서 끌어 오는 올리기(Files)와 다른 종류(MOVE_T)로 구분
const MOVE_T = 'application/x-hub-move';
let dragPs = null;
$('fileList').addEventListener('dragstart', (ev) => {
  const b = ev.target.closest('.fi'); if (!b) return;
  dragPs = targetsFor(items[+b.dataset.i].path);
  ev.dataTransfer.setData(MOVE_T, JSON.stringify(dragPs)); ev.dataTransfer.effectAllowed = 'move';
  $('files').classList.add('moving'); $('moveNote').className = 'move-note'; $('moveNote').textContent = `${dragPs.length}개 옮기는 중 · 폴더나 위쪽 경로에 놓으세요`;
});
addEventListener('dragend', () => { if (!dragPs) return; dragPs = null; $('files').classList.remove('moving'); document.querySelectorAll('.drop-on').forEach((e) => e.classList.remove('drop-on')); if ($('moveNote').textContent.endsWith('놓으세요')) $('moveNote').textContent = ''; });
const dropDir = (ev) => { // 놓을 수 있는 폴더 경로, 없으면 null
  if (!dragPs || !ev.dataTransfer.types.includes(MOVE_T)) return null;
  const c = ev.target.closest('#crumbs button[data-cd]'), f = ev.target.closest('#fileList .fi');
  const d = c ? c.dataset.cd : f && items[+f.dataset.i]?.dir ? items[+f.dataset.i].path : null;
  if (d == null || d === cwd || dragPs.some((x) => x.endsWith('/') && d.startsWith(x))) return null;
  return { d, el: c || f };
};
for (const box of [$('fileList'), $('crumbs')]) {
  box.addEventListener('dragover', (ev) => { const t = dropDir(ev); if (!t) return; ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'move'; document.querySelectorAll('.drop-on').forEach((e) => e !== t.el && e.classList.remove('drop-on')); t.el.classList.add('drop-on'); });
  box.addEventListener('dragleave', (ev) => { const e = ev.target.closest?.('.drop-on'); if (e && !e.contains(ev.relatedTarget)) e.classList.remove('drop-on'); });
  box.addEventListener('drop', (ev) => { const t = dropDir(ev); if (!t) return; ev.preventDefault(); ev.stopPropagation(); const ps = dragPs; t.el.classList.remove('drop-on'); moveItems(ps, t.d); });
}

// ---- 크게 보기(모달) ----
let vwPath = null;
const vwFiles = () => items.filter((x) => !x.dir);
async function openViewer(p) {
  let f = fileRows.find((x) => x.path === p);
  if (!f) { // 대화창 알림에서 연 다른 폴더 파일
    const r = await fetch(`${FILE_API}?prefix=${encodeURIComponent(p)}`, { credentials: 'same-origin' }).catch(() => null);
    f = r?.ok ? (await r.json()).files.find((x) => x.path === p) : null;
    if (!f) return alert('지워졌거나 없는 파일입니다');
  }
  vwPath = p;
  const k = kindOf(p), u = fileUrl(p), dlg = $('viewer'), body = $('vwBody');
  $('vwName').textContent = p.split('/').pop();
  $('vwMeta').textContent = `${p} · ${size(f.size)} · ${f.machine || ''}${f.session && f.session !== 'web' && f.session !== 'files' ? ' ' + f.session.slice(0, 8) : ''} · ${new Date(f.ts).toLocaleString('ko-KR')}`;
  $('vwDown').href = fileUrl(p, 1);
  const list = vwFiles(), i = list.findIndex((x) => x.path === p);
  $('vwPrev').disabled = i <= 0; $('vwNext').disabled = i < 0 || i >= list.length - 1;
  body.className = `vw-body k-${k}`;
  if (k === 'image') body.innerHTML = `<img src="${u}" alt="${esc(p)}">`;
  else if (k === 'video') body.innerHTML = `<video src="${u}#t=0.1" preload="metadata" controls autoplay playsinline></video>`;
  else if (k === 'audio') body.innerHTML = `${iconSvg('audio')}<audio src="${u}" controls autoplay></audio>`;
  else if (k === 'pdf') body.innerHTML = `<iframe src="${u}" title="${esc(p)}"></iframe>`;
  else if (TEXTY.test(EXT(p))) {
    body.innerHTML = '<p class="vw-note">불러오는 중…</p>';
    const big = f.size > 1048576; // 1MB 넘으면 앞부분만
    const r = await fetch(u, { credentials: 'same-origin', headers: big ? { Range: 'bytes=0-1048575' } : {} }).catch(() => null);
    if (vwPath !== p) return;
    const t = r?.ok ? await r.text() : null;
    body.innerHTML = t == null ? '<p class="vw-note">내용을 불러오지 못했습니다.</p>'
      : (big ? '<p class="vw-note">1MB까지만 보여 줍니다. 전체는 받기로.</p>' : '') + (EXT(p) === 'md' ? `<div class="vw-md">${md(t)}</div>` : `<pre class="vw-pre"></pre>`);
    const pre = body.querySelector('.vw-pre'); if (pre) pre.textContent = t;
  } else body.innerHTML = `${iconSvg(k)}<dl class="vw-info"><dt>크기</dt><dd>${size(f.size)}</dd><dt>올린 곳</dt><dd>${esc(f.machine || '')}</dd><dt>올린 때</dt><dd>${esc(new Date(f.ts).toLocaleString('ko-KR'))}</dd></dl><p class="vw-note">이 종류는 미리 볼 수 없습니다. 받기로 내려받으세요.</p>`;
  if (!dlg.open) dlg.showModal();
}
function closeViewer() { const d = $('viewer'); if (d.open) d.close(); }
$('viewer').addEventListener('close', () => { $('vwBody').innerHTML = ''; vwPath = null; $('vwSharebox').hidden = true; }); // 영상·소리 멈춤
$('viewer').onclick = (ev) => { if (ev.target === $('viewer')) closeViewer(); }; // 바깥(배경) 누르면 닫기
$('vwClose').onclick = closeViewer;
const step = (d) => { const l = vwFiles(), i = l.findIndex((x) => x.path === vwPath); if (i >= 0 && l[i + d]) openViewer(l[i + d].path); };
$('vwPrev').onclick = () => step(-1); $('vwNext').onclick = () => step(1);
$('viewer').onkeydown = (ev) => {
  if (ev.target.closest('video, audio, input, textarea')) return;
  if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); } else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
};
$('vwCopy').onclick = async () => {
  const url = location.origin + fileUrl(vwPath);
  try { await navigator.clipboard.writeText(url); $('vwCopy').textContent = '복사됨'; } catch { prompt('주소', url); }
  setTimeout(() => ($('vwCopy').textContent = '주소 복사'), 1500);
};
// 공유 링크: 로그인 없이 이 파일 하나만 24시간 받는 주소(서버가 서명). 비밀번호 모르는 사람에게 보낼 때
$('vwShare').onclick = async () => {
  const b = $('vwShare'), r = await fetch(fileUrl(vwPath) + '?share=24', { method: 'POST' }).catch(() => null), d = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok || !d.link) { b.textContent = d.error || '못 만듦'; return setTimeout(() => (b.textContent = '공유 링크'), 2000); }
  const url = d.shortUrl || `${location.origin}${FILE_API}/${d.link}`; // 짧은 주소 <SHORT_URL>/s/<코드>(서버가 만듦)
  if (navigator.share && matchMedia('(pointer: coarse)').matches) return shareAsk('24시간 받기 링크를 만들었습니다', '공유하기', { title: vwPath.split('/').pop(), text: '24시간 받기 링크', url }); // 폰: 공유 시트
  try { await navigator.clipboard.writeText(url); b.textContent = '복사됨(24시간)'; } catch { prompt('24시간 공유 링크', url); }
  setTimeout(() => (b.textContent = '공유 링크'), 2000);
};
// 공유 시트는 누른 버튼 옆에 붙어 뜸(iOS 26 팝오버) → 맨 아래 버튼에서 열면 잘림. 화면 가운데 버튼을 한 번 더 눌러 열게 함(fetch 뒤라 사용자 동작도 새로 필요)
function shareAsk(msg, label, data) {
  $('vwShareMsg').textContent = msg; $('vwShareGo').textContent = label; $('vwSharebox').hidden = false;
  $('vwShareGo').onclick = async () => { $('vwSharebox').hidden = true; try { await navigator.share(data); } catch (e) { if (e?.name !== 'AbortError') alert('공유하지 못했습니다: ' + (e?.message || e)); } };
}
$('vwShareNo').onclick = () => ($('vwSharebox').hidden = true);
// 받기(아이폰·아이패드): <a download>는 홈 화면 앱에서 링크 공유 시트로 새서 '파일에 저장'이 안 됨 → 파일을 받아 공유 시트에 파일로 넘김('비디오 저장'·'파일에 저장')
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
$('vwDown').onclick = (ev) => {
  if (!IOS || !navigator.canShare) return; // 그 밖은 브라우저 기본 받기
  const p = vwPath, f = fileRows.find((x) => x.path === p) || vwFiles().find((x) => x.path === p);
  if (f && f.size > 500 * 1048576) return; // shortcut: 500MB 넘으면 메모리에 못 올림 → Safari 기본 받기로
  ev.preventDefault();
  const b = $('vwDown'), name = p.split('/').pop(), x = new XMLHttpRequest();
  x.open('GET', fileUrl(p)); x.responseType = 'blob';
  x.onprogress = (e) => e.lengthComputable && (b.textContent = `받는 중 ${Math.round((e.loaded / e.total) * 100)}%`);
  x.onloadend = () => {
    b.textContent = '받기';
    if (vwPath !== p) return;
    if (x.status !== 200) return alert('받지 못했습니다');
    const file = new File([x.response], name, { type: x.response.type || 'application/octet-stream' });
    if (!navigator.canShare({ files: [file] })) { location.href = fileUrl(p, 1); return; }
    shareAsk(`${name} 받음 · 공유 시트에서 '비디오 저장'이나 '파일에 저장'을 고르세요`, '저장하기', { files: [file] });
  };
  x.send();
};
// 폰 시트: 머리를 아래로 쓸어내리면 닫기
for (const id of ['viewer', 'msgView']) {
  const dlg = $(id); let y0 = null;
  dlg.querySelector('.vw-head').addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  dlg.querySelector('.vw-head').addEventListener('touchend', (e) => { if (y0 != null && e.changedTouches[0].clientY - y0 > 70) dlg.close(); y0 = null; });
}
$('viewer').addEventListener('click', (ev) => { if (ev.target === $('viewer')) $('viewer').close(); }); // 바깥 누르면 닫기
$('vwDel').onclick = async () => {
  const p = vwPath; if (!p || !confirm(`${p} 파일을 지울까요? 되돌릴 수 없습니다.`)) return;
  const r = await fetch(fileUrl(p), { method: 'DELETE', credentials: 'same-origin' }).catch(() => null);
  if (!r?.ok) return alert(r ? (await r.json().catch(() => ({}))).error || '지우지 못했습니다' : '서버에 연결되지 않습니다');
  closeViewer(); loadFiles();
};

// 올리기: 지금 폴더로. XHR로 진행률 표시. 같은 이름이 있으면 덮어씀
function upload(file) {
  const p = cwd + file.name;
  const li = document.createElement('li'); li.innerHTML = `<span>${esc(p)}</span><span>올리는 중 0%</span><progress max="100" value="0"></progress>`;
  $('uploads').append(li);
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', fileUrl(p));
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const v = Math.round((e.loaded / e.total) * 100); li.querySelector('progress').value = v; li.children[1].textContent = `올리는 중 ${v}%`; } };
  // 완료는 3초 보이고 사라짐, 실패·끊김은 눌러서 지울 때까지 남김
  xhr.onload = () => { if (xhr.status === 200) { li.children[1].textContent = '완료'; li.children[1].className = 'ok'; setTimeout(() => li.remove(), 3000); loadFiles(); } else { li.children[1].textContent = '실패 · 눌러서 닫기'; li.children[1].className = 'bad'; li.title = xhr.responseText; li.onclick = () => li.remove(); } };
  xhr.onerror = () => { li.children[1].textContent = '끊김 · 눌러서 닫기'; li.children[1].className = 'bad'; li.onclick = () => li.remove(); };
  xhr.send(file);
}
$('filePick').onchange = () => { [...$('filePick').files].forEach(upload); $('filePick').value = ''; };
const fz = $('files');
fz.ondragover = (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; if (!fz.classList.contains('drag')) { fz.querySelector('.drop-hint').textContent = `여기에 놓으면 '${cwd.replace(/\/$/, '') || '맨 위'}' 폴더로 올라갑니다`; fz.classList.add('drag'); } } };
fz.ondragleave = (e) => { if (!fz.contains(e.relatedTarget)) fz.classList.remove('drag'); };
fz.ondrop = (e) => { e.preventDefault(); fz.classList.remove('drag'); [...e.dataTransfer.files].forEach(upload); };

// ---- 내가 할 일: 세션이 맡긴 것. 체크하면 서버가 그 세션에 '했으니 이어서'를 보냄 ----
let todoRows = [];
async function loadTodos() {
  const r = await api('todos').catch(() => null);
  if (!r?.ok) return;
  todoRows = (await r.json()).todos; renderTodos();
}
function renderTodos() {
  const open = todoRows.filter((t) => !t.done_ts), done = todoRows.filter((t) => t.done_ts);
  if (!$('app').hidden) renderPending(); // 지도에 할 일 선·표시
  document.querySelectorAll('[data-todo-count]').forEach((b) => (b.textContent = open.length || ''));
  const who = (t) => (String(t.session).startsWith("pair:") ? "새 기기 붙이기" : t.from ? nameOf(t.from) : t.name || `${t.machine} 세션 ${String(t.session).slice(0, 4)}`);
  // 종류: 승인(🔐 진행/거절 — 둘 다 세션에 알림) / 사용자가 할 일(했어요/필요 없음)
  const item = (t) => {
    const ap = t.kind === 'approve', note = t.note || '', rejected = ap && note.startsWith('거절'), memo = note.replace(/^(진행|거절):?\s*/, '');
    const doneLine = ap ? `${rejected ? '✕ 거절함' : '✓ 진행함'} · ${ago(t.done_ts)}${memo ? ' — ' + esc(memo) : ''}`
      : `✓ ${ago(t.done_ts)} 체크${note ? ' — ' + esc(note) : ''} <button type="button" data-undo>되돌리기</button>`;
    const act = ap ? `<input type="text" placeholder="메모(선택): 예) 768P 하나만" aria-label="세션에게 남길 메모"><button type="button" data-done class="go">진행</button><button type="button" data-drop class="td-drop no">거절</button>`
      : `<input type="text" placeholder="메모(선택): 예) 넣었음, 비번은 따로 줌" aria-label="세션에게 남길 메모"><button type="button" data-done>했어요</button><button type="button" data-drop class="td-drop" title="세션에 알리지 않고 뺌">필요 없음</button>`;
    return `<li class="td${ap ? ' approve' : ''}${t.done_ts ? ' done' : ''}${rejected ? ' rejected' : ''}" data-id="${t.id}">
      <div class="td-head"><span class="td-from">${ap ? '<span class="td-kind" title="승인 요청">🔐 승인</span> ' : ''}${esc(who(t))}</span><time>${ago(t.ts)}</time></div>
      <div class="td-text">${md(t.text)}</div>
      ${t.detail ? `<details><summary>자세히</summary><div class="td-detail">${md(t.detail)}</div></details>` : ''}
      ${t.done_ts ? `<div class="td-done">${doneLine}</div>` : `<div class="td-act">${act}</div>`}</li>`;
  };
  $('todoList').innerHTML = (open.length ? open.map(item).join('') : '<li class="empty">지금 할 일이 없습니다. 세션이 승인이나 직접 할 일을 맡기면 여기에 뜹니다.</li>')
    + (done.length ? `<li class="td-sep">끝난 것</li>${done.map(item).join('')}` : '');
}
$('todoList').onclick = async (ev) => {
  const li = ev.target.closest('li.td'); if (!li) return;
  const id = li.dataset.id;
  if (ev.target.closest('[data-done]')) {
    const btn = ev.target.closest('[data-done]'); btn.disabled = true;
    const note = li.querySelector('input')?.value.trim() || '';
    const r = await api(`todos/${id}/done`, { method: 'POST', body: JSON.stringify({ note }) }).catch(() => null);
    if (!r?.ok) { btn.disabled = false; return alert('체크하지 못했습니다'); }
    loadTodos();
  } else if (ev.target.closest('[data-drop]')) {
    await api(`todos/${id}/drop`, { method: 'POST', body: '{}' }).catch(() => null); loadTodos();
  } else if (ev.target.closest('[data-undo]')) {
    await api(`todos/${id}/undo`, { method: 'POST' }).catch(() => null); loadTodos();
  }
};
$('todoList').onkeydown = (ev) => { if (ev.key === 'Enter' && ev.target.matches('.td-act input') && !ev.isComposing) ev.target.closest('li').querySelector('[data-done]').click(); };

// ---- 진행: 누가 어떤 일을 하는지 한눈에(요청 하나 = 한 줄). 이미 있는 요청·답 짝(ref)을 씀 ----
// 요청 = 나 → 세션(허브 지시 ask) 또는 세션 → 세션(SendMessage). 받아 감 = ask는 'busy ref=요청', send는 받는 쪽 receive(ref=요청)
// 끝남 = 받는 쪽이 그 요청(ask id 또는 receive id)에 붙인 답(reply)이나 보고(send). 보고(요청한 쪽으로 돌아가는 send)는 새 줄로 안 셈
const JOB_SKIP = /^\s*\[허브 (PM )?깨우기\]/;
function buildJobs() {
  const byId = new Map(events.map((e) => [e.id, e])), started = new Map(), doneBy = new Map(), rcv = new Map();
  for (const e of events) {
    if (e.type === 'busy' && e.ref) started.set(e.ref, e.ts);
    if (e.type === 'receive' && e.ref) { started.set(e.ref, e.ts); rcv.set(e.ref, e.id); }
    if ((e.type === 'reply' || e.type === 'send') && e.ref) { const k = keyOf(e) + '|' + e.ref; if (!doneBy.has(k)) doneBy.set(k, e); } // 그 요청에 붙은 첫 답·보고(모달에 전문)
  }
  const byKey = new Map(); for (const e of events) { const k = keyOf(e); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(e); }
  const requester = (id) => {
    const r = byId.get(id); if (!r) return null;
    if (r.type === 'ask') return 'me';
    if (r.type === 'receive') return (r.ref && pair(byId.get(r.ref) || {})?.[0]) || resolve(r.to) || null; // 받은 메시지 → 그걸 보낸 세션
    return pair(r)?.[0] || null;
  };
  const jobs = [];
  for (const e of events) {
    if (e.type !== 'ask' && e.type !== 'send') continue;
    if (JOB_SKIP.test(e.text || '')) continue;
    if (e.type === 'ask' && e.ref) continue; // 추가 요청은 원래 일 줄에 묶음
    const pr = pair(e); if (!pr || isHidden(pr[1])) continue;
    const [from, to] = pr;
    if (e.type === 'send' && e.ref && requester(e.ref) === to) continue; // 요청한 쪽에 돌려주는 보고
    const key = e.type === 'ask' ? e.id : rcv.get(e.id);
    const ans = key != null ? doneBy.get(to + '|' + key) : null, done = ans?.ts;
    let st = done ? 'done' : started.has(e.id) ? 'doing' : 'sent', end = done, answer = ans || null, got = started.get(e.id) || null;
    let guess = false;
    if (st !== 'done') { // 짝(ref)을 못 찾은 것(글이 다르거나 여러 곳에 한꺼번에 보냄): 받는 쪽이 그 뒤 일을 시작했다가 쉬었거나 요청한 쪽에 보고했으면 끝난 것으로 봄
      // 받는 쪽 '받음'이 보낸 쪽 '보냄' 기록보다 먼저 들어올 때가 있어(같은 글을 여러 곳에 보낼 때) 10초 앞부터 봄
      const after = (byKey.get(to) || []).filter((x) => x.ts >= e.ts - 10e3 && x.id !== e.id);
      const go = after.find((x) => (x.type === 'receive' && (e.type === 'send' ? x.text === e.text || x.ts > e.ts : x.ts > e.ts)) || ((x.type === 'prompt' || x.type === 'busy') && x.ts > e.ts)); // 앞선 10초는 같은 글의 '받음'만
      const rest = go && after.find((x) => x.ts > e.ts && x.ts >= go.ts && x.id !== go.id && (x.type === 'reply' || x.type === 'idle' || x.type === 'stop' || (x.type === 'send' && from !== 'me' && resolve(x.to) === from)));
      if (rest) { st = 'done'; end = rest.ts; guess = true; if (rest.type === 'reply' || rest.type === 'send') answer = rest; } else if (go && st === 'sent') st = 'doing';
      if (go && !got) got = go.ts;
      // 3분 넘게 대기면 다시 확인: 받는 쪽이 쉬는 중이고 그 뒤 활동(답·보고·쉼)이 있었으면 끝남(추정)
      const ts = sessions.get(to);
      if (st !== 'done' && Date.now() - e.ts > 3 * 60e3 && ts && (ts.state === 'idle' || ts.state === 'asleep')) {
        const act = after.find((x) => x.ts > e.ts && (x.type === 'reply' || x.type === 'send' || x.type === 'idle' || x.type === 'stop'));
        if (act) { st = 'done'; end = act.ts; guess = true; if (act.type === 'reply' || act.type === 'send') answer = act; }
      }
    }
    if (st === 'sent' && Date.now() - e.ts > 3 * 3600e3) st = 'stale'; // 몇 시간 지나도 안 받아 간 것은 접음
    const ups = events.filter((x) => x.type === 'ask' && x.ref === e.id).map((u) => ({ ev: u, got: started.get(u.id) || null, ans: doneBy.get(to + '|' + u.id) || null }));
    const openUp = ups.find((u) => !u.ans);
    if (openUp && (st === 'done' || st === 'stale')) { st = openUp.got ? 'doing' : 'sent'; end = null; guess = false; } // 끝난 일에 추가 요청 → 답 올 때까지 다시 진행
    else if (ups.length && !openUp && st !== 'done') { st = 'done'; end = ups[ups.length - 1].ans.ts; }
    jobs.push({ id: e.id, from, to, ts: e.ts, done: end, st, got, answer, guess, ups: ups.length, upList: ups, upWait: !!openUp, full: e.text, text: first(e.text).replace(/^\[[^\]]*→[^\]]*\]\s*/, '').replace(/\*\*|`/g, '') });
  }
  return jobs.reverse();
}
const JOB_WORD = { sent: '지시됨', doing: '진행 중', done: '완료', stale: '안 받아 감' };
// 토큰: 세션별 오늘·7일(서버 /api/usage, 1분에 한 번). 금액은 API 단가 기준 추정(구독 청구와 다름)
let usageData = null, usageAt = 0;
const tokFmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const usd = (v) => (v >= 10 ? '$' + v.toFixed(0) : '$' + v.toFixed(2));
async function loadUsage(force) {
  if (!force && Date.now() - usageAt < 60e3) return;
  usageAt = Date.now();
  const r = await api('usage').catch(() => null); if (!r?.ok) return;
  usageData = await r.json().catch(() => null); renderUsage();
}
function renderUsage() {
  const box = $('jobsUsage'); if (!box) return;
  const u = usageData; if (!u) { box.innerHTML = ''; return; }
  const rows = u.sessions.filter((x) => sessions.has(x.key) && !isHidden(x.key) && (x.today.tok || x.week.tok));
  box.innerHTML = `<div class="ju-sum"><b>오늘 토큰 ${tokFmt(u.today.tok)} · ${usd(u.today.usd)}</b><span>7일 ${tokFmt(u.week.tok)} · ${usd(u.week.usd)} <small>(API 단가 기준 추정)</small></span></div>`
    + (rows.length ? `<ul>${rows.map((x) => `<li><b>${esc(nameOf(x.key))}</b><span>오늘 ${tokFmt(x.today.tok)} · ${usd(x.today.usd)}</span><span class="ju-w">7일 ${usd(x.week.usd)}</span>${x.ctx >= 150e3 ? `<span class="ju-big" title="마지막 요청 입력 ${tokFmt(x.ctx)} — 새로 띄우면 비용이 줄어요">컨텍스트 ${tokFmt(x.ctx)} · 새로 띄우기 권장</span>` : x.ctx ? `<span class="ju-ctx">컨텍스트 ${tokFmt(x.ctx)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="ju-none">아직 모인 사용량이 없어요(새 hub-hook.sh를 넣은 세션이 턴을 끝내면 쌓임)</p>');
}
function renderJobs() {
  if ($('app').dataset.side !== 'jobs' && $('app').dataset.tab !== 'jobs') return;
  loadUsage(); renderUsage();
  const jobs = buildJobs(), clip = (t, n = 32) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  // 위: AI별 한 줄
  const ais = [...sessions.values()].filter((s) => !isHidden(s.key) && s.state !== 'offline').sort((a, b) => isPM(b) - isPM(a) || label(a).localeCompare(label(b), 'ko'));
  $('jobsTop').innerHTML = ais.map((s) => {
    const mine = jobs.filter((j) => j.to === s.key && (j.st === 'sent' || j.st === 'doing')), doing = mine.filter((j) => j.st === 'doing');
    const now = doing[0]?.text || (s.state === 'busy' ? first(s.doing) : '');
    const word = s.state === 'asleep' ? '대기 끊김' : doing.length ? `진행 중 ${doing.length}` : mine.length ? `지시됨 ${mine.length}` : s.state === 'busy' ? '일하는 중' : '쉬는 중';
    return `<li class="jt ${s.state}"><span class="dot ${s.state}"></span><b>${esc(label(s))}</b><span class="jt-w">${esc(word)}</span>${now ? `<span class="jt-now">${esc(clip(now, 40))}</span>` : ''}</li>`;
  }).join('') || '<li class="empty">접속한 AI가 없습니다</li>';
  // 아래: 일 한 줄씩(진행·지시 먼저, 완료는 최근 하루만 · 접기)
  const day = Date.now() - 864e5, open = jobs.filter((j) => j.st === 'sent' || j.st === 'doing'), done = jobs.filter((j) => j.st === 'done' && j.done > day), stale = jobs.filter((j) => j.st === 'stale' && j.ts > day);
  const row = (j) => {
    const s = sessions.get(j.to), word = j.st === 'sent' && s?.state === 'asleep' ? '깨우는 중' : JOB_WORD[j.st];
    return `<li class="jb ${j.st}${j.guess ? ' guess' : ''}" data-id="${j.id}"><span class="jb-st">${word}${j.guess && j.st === 'done' ? '(추정)' : ''}</span><b>${esc(nameOf(j.to))}</b><span class="jb-t">${esc(clip(j.text))}${j.ups ? ` <i class="jb-up">${j.upWait ? '추가 요청 대기' : '+추가 요청 ' + j.ups}</i>` : ''}</span><small>${j.from === 'me' ? '나' : esc(nameOf(j.from))} · ${clock(j.done || j.ts)}</small></li>`;
  };
  $('jobsList').innerHTML = (open.length ? open.map(row).join('') : '<li class="empty">진행 중인 일이 없습니다</li>')
    + (done.length ? `<li class="jb-fold"><details${open.length ? '' : ' open'}><summary>완료 ${done.length}개 (접힘 · 끝난 일)</summary><ul>${done.map(row).join('')}</ul></details></li>` : '')
    + (stale.length ? `<li class="jb-fold"><details><summary>오래돼 안 받아 간 것 ${stale.length}개 (접힘)</summary><ul>${stale.map(row).join('')}</ul></details></li>` : '');
}
// 진행 줄을 누르면: 상태·맡긴 쪽→받은 쪽·시각·지시 전문·답이나 보고 전문을 모달로('대화에서 보기'로 대화창 이동)
function openJob(id) {
  const j = buildJobs().find((x) => x.id === +id); if (!j) return;
  const s = sessions.get(j.to), word = (j.st === 'sent' && s?.state === 'asleep' ? '깨우는 중' : JOB_WORD[j.st]) + (j.guess && j.st === 'done' ? '(추정 — 받는 쪽이 그 뒤 쉬거나 보고함)' : '');
  const when = (t) => (t ? new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  const ans = j.answer ? (j.answer.type === 'prompt' ? stripSys(j.answer.text) : j.answer.text) : '';
  mvText = `[${word}] ${j.from === 'me' ? '나' : nameOf(j.from)} → ${nameOf(j.to)}\n\n지시:\n${j.full}${ans ? `\n\n${j.answer.type === 'send' ? '보고' : '답'}:\n${ans}` : ''}`;
  $('mvWho').textContent = `${word} · ${j.from === 'me' ? '나' : nameOf(j.from)} → ${nameOf(j.to)}`;
  $('mvMeta').textContent = `지시 ${when(j.ts)} · 받음 ${when(j.got)} · 끝남 ${when(j.done)}`;
  const sec = (h, t) => { const sa = splitAtt(t); return `<h3 class="mv-sec">${h}</h3>${md(sa.body)}${attHtml(sa.atts)}`; };
  $('mvBody').innerHTML = sec('지시', j.full) + (ans ? sec(j.answer.type === 'send' ? '보고' : '답', ans) : `<p class="mv-none">${j.st === 'done' ? '답 글은 따로 없이 끝났어요(받는 쪽이 일을 마치고 쉼).' : '아직 답이 없어요.'}</p>`);
  $('mvJump').hidden = false; $('mvJump').dataset.id = j.id;
  // 추가 요청: 그 일을 받은 에이전트에게(허브 지시와 같은 길, ref = 원래 일). 보낸 것은 아래에 쌓임
  const t = sessions.get(j.to), why = !t ? '허브에 없는 세션이라 보낼 수 없어요' : isHidden(j.to) ? '숨긴 세션이라 보낼 수 없어요' : t.state === 'offline' ? '끊긴 세션이라 보낼 수 없어요(그 세션을 다시 켜야 함)' : '';
  renderFollow(j.id);
  $('mvAsk').hidden = false; $('mvAsk').dataset.id = j.id; $('mvAsk').dataset.to = j.to; $('mvAsk').dataset.sum = first(j.full).replace(/^\[[^\]]*\]\s*/, '').slice(0, 30);
  $('mvAskTo').textContent = `${nameOf(j.to)}에게 추가 요청`;
  $('mvAskWhy').textContent = why; $('mvAskWhy').hidden = !why;
  $('mvAsk').querySelectorAll('textarea, button, input').forEach((x) => (x.disabled = !!why));
  mvAtt = []; renderMvAtt(); $('mvAskText').value = ''; $('mvAskNote').textContent = '';
  $('msgView').showModal(); $('msgView').querySelector('.mv-body').scrollTop = 0;
}
function renderFollow(id) {
  const j = buildJobs().find((x) => x.id === +id); if (!j) return;
  $('mvFollow').innerHTML = j.upList.map((u) => {
    const st = u.ans ? ['ok', `답함 ${clock(u.ans.ts)}`] : u.got ? ['got', `받음 ${clock(u.got)} · 답 기다리는 중`] : ['wait', sessions.get(j.to)?.state === 'asleep' ? '아직 안 받아 감 · 깨우는 중' : '받음 확인 중…'];
    const ans = u.ans ? `<div class="fu-ans"><b>${esc(nameOf(j.to))}</b>${md(u.ans.text || '')}</div>` : '';
    return `<li><time>${clock(u.ev.ts)} <span class="fu-st ${st[0]}">${st[1]}</span></time>${md(u.ev.text.replace(/^\[추가 요청:[^\]]*\]\s*/, ''))}${ans}</li>`;
  }).join('');
}
let mvAtt = [];
function renderMvAtt() { $('mvAskFiles').innerHTML = mvAtt.map((f, i) => `<li>${esc(f.name)} <small>${size(f.size)}</small><button type="button" data-i="${i}" aria-label="빼기">×</button></li>`).join(''); }
$('mvAskFiles').onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (b) { mvAtt.splice(+b.dataset.i, 1); renderMvAtt(); } };
$('mvAskPick').onchange = () => { mvAtt.push(...$('mvAskPick').files); $('mvAskPick').value = ''; renderMvAtt(); };
async function sendFollow(body) {
  const f = $('mvAsk'), note = $('mvAskNote'), id = +f.dataset.id, to = f.dataset.to;
  let text = String(body || '').trim(); if (!text && !mvAtt.length) return;
  f.querySelectorAll('button').forEach((x) => (x.disabled = true)); note.textContent = '';
  try {
    if (mvAtt.length) {
      const day = new Date().toLocaleDateString('sv-SE'), lines = [];
      for (const [i, file] of mvAtt.entries()) {
        const p = `첨부/${day}/${Math.random().toString(36).slice(2, 6)}-${file.name.replace(/[\\/]/g, '_')}`;
        await putFile(p, file, (v) => (note.textContent = `첨부 올리는 중 ${i + 1}/${mvAtt.length} · ${v}%`));
        lines.push(`[첨부] ${p} (${size(file.size)})`);
      }
      text = `${text || '(첨부만 보냄)'}\n\n${lines.join('\n')}`;
    }
    const r = await api('ask', { method: 'POST', body: JSON.stringify({ to, ref: id, text: `[추가 요청: ${f.dataset.sum}] ${text}` }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || '보내지 못했습니다');
    note.textContent = d.asleep ? '보냈어요. 대기가 끊긴 세션이라 PM에게 깨우기를 부탁했어요.' : d.waiting ? '보냈어요 — 받음 확인 중(지금 하던 걸 끝내면 받아요)' : '보냈어요 — 바로 받아 갔어요'; // 그 뒤 받음·답함은 위 목록에
    $('mvAskText').value = ''; mvAtt = []; renderMvAtt();
  } catch (e) { note.textContent = e.message; }
  f.querySelectorAll('button').forEach((x) => (x.disabled = false));
}
$('mvAsk').onsubmit = (ev) => { ev.preventDefault(); sendFollow($('mvAskText').value); };
$('mvAskText').onkeydown = (ev) => { if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); sendFollow($('mvAskText').value); } };
$('mvPoke').onclick = () => sendFollow('어디까지 됐는지 한 줄로 알려 주세요.');
$('mvStop').onclick = () => { if (confirm(`${nameOf($('mvAsk').dataset.to)}에게 이 일을 멈추라고 보낼까요?`)) sendFollow('이 일은 멈춰 주세요. 하던 데까지 한 줄로 알려 주고, 더 진행하지 마세요.'); };
function jumpToChat(id) {
  if ($('app').dataset.tab !== 'board') setTab('chat'); setSide('chat');
  requestAnimationFrame(() => { const el = $('chatList').querySelector(`[data-id="${id}"]`)?.closest('li') || $('chatList').querySelector(`[data-id="${id}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.remove('spot'); void el.offsetWidth; el.classList.add('spot'); } });
}
$('jobsList').addEventListener('click', (ev) => { const li = ev.target.closest('li.jb[data-id]'); if (li) openJob(li.dataset.id); });
$('mvJump').onclick = () => { const id = $('mvJump').dataset.id; $('msgView').close(); jumpToChat(id); };

// ---- 탭: 넓은 화면은 오른쪽 칸 대화/파일, 좁은 화면은 지도/대화/파일 ----
function setSide(s) {
  $('app').dataset.side = s;
  document.querySelectorAll('.side-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.side === s)));
  if (s === 'files') loadFiles();
  if (s === 'todo') loadTodos();
  if (s === 'jobs') renderJobs();
  if (s === 'chat' && chatAtBottom) requestAnimationFrame(chatToBottom); // 가려져 있던 대화 칸이 보이면 맨 아래로
}
function setTab(t) {
  $('app').dataset.tab = t;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === t)));
  if (t === 'board') renderOrbit(); else setSide(t);
}
document.querySelector('.tabs').onclick = (ev) => { const b = ev.target.closest('button[data-tab]'); if (b) setTab(b.dataset.tab); };
document.querySelector('.side-tabs').onclick = (ev) => { const b = ev.target.closest('button[data-side]'); if (b) { setSide(b.dataset.side); if ($('app').dataset.tab !== 'board') setTab(b.dataset.side); } };
setTab('board'); setSide('chat');

function renderAll() { renderOrbit(); renderMetrics(); renderSessions(); renderChat(); renderAskTo(); renderJobs(); }
addEventListener('resize', () => !$('app').hidden && renderOrbit());
setInterval(() => !$('app').hidden && (renderMetrics(), renderSessions(), renderPending(), renderJobs()), 30e3); // 'n분 전'·'응답 대기 n분' 갱신, 오래된 대기 정리
boot();

// ---- 도구: 쓰는 법·명령 예시를 허브에 적어 두고, 대화창에서 고르거나 @이름으로 부르면 지시 앞에 붙여 보냄 ----
let tools = [];
async function loadTools() {
  const r = await api('tools').catch(() => null); if (!r?.ok) return;
  tools = (await r.json()).tools; renderTools();
}
const toolTarget = (t) => (t.target && sessions.has(t.target) ? label(sessions.get(t.target)) : t.target ? '(지금 없는 세션)' : '');
function renderTools() {
  const q = $('toolFind').value.trim().toLowerCase(), open = $('toolsList').querySelector('.ag.open')?.dataset.id;
  const list = tools.filter((t) => !q || [t.name, t.desc, t.how].some((x) => (x || '').toLowerCase().includes(q)));
  $('toolsBtn').textContent = `도구 ${tools.length} ▾`;
  $('toolsList').innerHTML = list.length ? list.map((t) => `<li class="ag${String(t.id) === open ? ' open' : ''}" data-id="${t.id}"><button type="button">
    <span class="tool-ic" aria-hidden="true">⚒</span><span class="ag-main"><b>@${esc(t.name)}</b>${t.desc ? `<span class="ag-desc">${esc(t.desc)}</span>` : ''}</span>
    <span class="ag-meta">${esc(toolTarget(t))}<br>${ago(t.ts)}</span></button>
    <div class="ag-act"${String(t.id) === open ? '' : ' hidden'}><button type="button" data-tl="use" class="primary">대화에서 쓰기</button><button type="button" data-tl="edit">고치기</button><button type="button" data-tl="del">지우기</button></div></li>`).join('')
    : `<li class="empty">${q ? '찾는 도구가 없습니다' : '아직 도구가 없습니다. + 도구 추가로 쓰는 법·명령을 적어 두세요'}</li>`;
  $('askTool').hidden = !tools.length;
  const cur = $('askTool').value;
  $('askTool').innerHTML = '<option value="">도구 쓰기…</option>' + tools.map((t) => `<option value="${t.id}">@${esc(t.name)}</option>`).join('');
  $('askTool').value = tools.some((t) => String(t.id) === cur) ? cur : '';
}
// 보낼 때 붙일 도구: 고른 것 + 글 안의 @이름(긴 이름부터, 같은 도구는 한 번)
function toolsIn(text) {
  const out = tools.filter((t) => String(t.id) === $('askTool').value);
  for (const t of [...tools].sort((a, b) => b.name.length - a.name.length)) if (!out.includes(t) && new RegExp(`(^|\\s)@${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s,.!?])`).test(text)) out.push(t);
  return out;
}
const toolBlock = (t) => [`[도구 @${t.name}] 이 도구를 참고해서 진행하세요.`, t.desc && `설명: ${t.desc}`, t.how && `쓰는 법:\n${t.how}`, t.example && `명령 예시:\n${t.example}`, t.links && `관련 파일·링크:\n${t.links}`].filter(Boolean).join('\n');
function useTool(t) {
  $('askTool').value = String(t.id);
  if (t.target && sessions.has(t.target)) pickTarget(t.target); else { setTab('chat'); $('askText').focus(); }
}
$('askTool').onchange = () => { const t = tools.find((x) => String(x.id) === $('askTool').value); if (t?.target && sessions.has(t.target)) pickTarget(t.target); };
function toolsShow(on) {
  const p = $('toolsPanel'); $('toolsBtn').setAttribute('aria-expanded', String(on));
  if (on) { agentsShow(false); p.hidden = false; requestAnimationFrame(() => p.classList.add('show')); $('toolFind').focus(); }
  else { p.classList.remove('show'); setTimeout(() => { if (!p.classList.contains('show')) p.hidden = true; }, reduced ? 0 : 160); }
}
$('toolsBtn').onclick = () => toolsShow($('toolsPanel').hidden);
$('agentsBtn').addEventListener('click', () => toolsShow(false));
$('toolFind').oninput = renderTools;
document.addEventListener('pointerdown', (ev) => { if (!$('toolsPanel').hidden && !ev.target.closest('#toolsPanel, #toolsBtn, #toolDlg')) toolsShow(false); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('toolsPanel').hidden && !$('toolDlg').open) toolsShow(false); });
$('toolsPanel').addEventListener('click', async (ev) => {
  if (ev.target.closest('.ap-x')) return toolsShow(false);
  if (ev.target.closest('#toolAdd')) return editTool(null);
  const li = ev.target.closest('.ag[data-id]'); if (!li) return;
  const t = tools.find((x) => String(x.id) === li.dataset.id), act = ev.target.closest('[data-tl]')?.dataset.tl;
  if (act === 'use') { toolsShow(false); return useTool(t); }
  if (act === 'edit') return editTool(t);
  if (act === 'del') {
    if (!confirm(`@${t.name} 도구를 지울까요?`)) return;
    const r = await api(`tools/${t.id}`, { method: 'DELETE' }).catch(() => null);
    return r?.ok ? loadTools() : alert('지우지 못했습니다');
  }
  const was = li.classList.contains('open');
  $('toolsList').querySelectorAll('.ag.open').forEach((x) => { x.classList.remove('open'); x.querySelector('.ag-act').hidden = true; });
  if (!was) { li.classList.add('open'); li.querySelector('.ag-act').hidden = false; }
});
let toolEditing = null;
function editTool(t) {
  toolEditing = t?.id || null;
  $('toolDlgTitle').textContent = t ? `@${t.name} 고치기` : '도구 추가';
  $('tlName').value = t?.name || ''; $('tlDesc').value = t?.desc || ''; $('tlHow').value = t?.how || ''; $('tlEx').value = t?.example || ''; $('tlLinks').value = t?.links || '';
  const ss = [...sessions.values()].filter((s) => !isHidden(s.key) || s.key === t?.target).sort((a, b) => isPM(b) - isPM(a) || label(a).localeCompare(label(b), 'ko'));
  $('tlTarget').innerHTML = '<option value="">정하지 않음(지금 고른 세션으로)</option>' + ss.map((s) => `<option value="${esc(s.key)}">${isPM(s) ? 'PM · ' : ''}${esc(label(s))} · ${esc(s.machine)}</option>`).join('')
    + (t?.target && !sessions.has(t.target) ? `<option value="${esc(t.target)}">(지금 없는 세션) ${esc(t.target)}</option>` : '');
  $('tlTarget').value = t?.target || '';
  $('toolNote').textContent = '';
  $('toolDlg').showModal(); $('tlName').focus();
}
// 비밀값처럼 보이는 것(키 접두사·password= 등)이 있으면 한 번 더 물음
const SECRETY = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY|(pass(word)?|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,})/i;
$('toolForm').onsubmit = async (ev) => {
  ev.preventDefault();
  const body = { id: toolEditing, name: $('tlName').value, desc: $('tlDesc').value, how: $('tlHow').value, example: $('tlEx').value, links: $('tlLinks').value, target: $('tlTarget').value };
  if (SECRETY.test([body.how, body.example, body.links, body.desc].join('\n')) && !confirm('비밀값(키·비밀번호·토큰)처럼 보이는 글이 있어요. 세션에 그대로 전달됩니다. 그래도 저장할까요?')) return;
  const r = await api('tools', { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
  if (!r?.ok) { $('toolNote').textContent = r ? (await r.json().catch(() => ({}))).error || '저장하지 못했습니다' : '서버에 연결되지 않습니다'; return; }
  $('toolDlg').close(); loadTools();
};
$('tlCancel').onclick = () => $('toolDlg').close();
