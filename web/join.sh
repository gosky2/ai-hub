#!/bin/sh
# 새 기기를 AI 허브에 붙이기 — 그 기기의 터미널(윈도우는 Git Bash)에서 사용자가 직접 실행:
#   curl -fsSL <허브 주소>/join.sh | sh -s -- "기기이름"   (허브가 이 파일을 줄 때 기본 주소를 자기 주소로 바꿔 줌)
# 하는 일(여러 번 돌려도 같음):
#   1) 토큰이 없으면 허브에 승인 요청 → 화면 '할 일'에서 코드 확인 후 '했어요' → 이 기기 전용 토큰을 받아 ~/.claude/ai-hub.env(600)에 저장
#   2) ~/.claude/hub-hook.sh·hub-todo.sh·hub-file.sh 받기(새 버전으로 덮어씀)
#   3) ~/.claude/settings.json에 허브 훅 5종 추가(이미 있으면 그대로, 다른 설정은 안 건드림, 바꾸기 전 settings.json.bak-ai-hub 백업)
# 그 뒤 이 기기에서 새로 켜는 Claude 세션이 허브에 자동으로 뜸("[기기이름] 폴더").
set -e
URL="${AI_HUB_URL:-http://localhost:4200}"
D="$HOME/.claude"; mkdir -p "$D"
say() { printf '%s\n' "$*"; }
[ -f "$D/ai-hub.env" ] && . "$D/ai-hub.env"
M="${1:-${AI_HUB_MACHINE:-}}"
if [ -z "$M" ]; then printf '이 기기 이름(예: laptop, desktop, server2): '; read -r M < /dev/tty; fi
case "$M" in ''|*[\"\\]*) say "기기 이름이 비었거나 \" \\ 가 들어 있습니다"; exit 1;; esac

# 1) 토큰
if [ -n "${AI_HUB_TOKEN:-}" ] && curl -fs -o /dev/null -H "Authorization: Bearer $AI_HUB_TOKEN" "$URL/api/todos?txt=1"; then
  say "토큰 있음(허브에서 받아 줌) — 파일·훅만 맞춥니다"
else
  # 본문은 stdin으로(윈도우 Git Bash curl은 인자 속 한글을 cp949로 바꿔 보냄)
  R=$(printf '{"machine":"%s"}' "$M" | curl -fsS -X POST -H 'Content-Type: application/json; charset=utf-8' --data-binary @- "$URL/api/pair") || { say "허브에 승인 요청을 못 보냈습니다(30초 뒤 다시 또는 인터넷 확인)"; exit 1; }
  id=$(printf '%s' "$R" | sed -n 's/.*"id":"\([0-9a-f]*\)".*/\1/p'); code=$(printf '%s' "$R" | sed -n 's/.*"code":"\([0-9A-F]*\)".*/\1/p')
  [ -n "$id" ] && [ -n "$code" ] || { say "허브 응답이 이상합니다: $R"; exit 1; }
  say ""
  say "  승인 코드: $code"
  say "  AI 허브 화면 '할 일'에 '새 기기 붙이기 승인: \"$M\" (코드 $code)'가 올라갔습니다."
  say "  코드가 같은지 보고 '했어요'를 누르세요(15분 안). 기다리는 중…"
  T=; n=0
  while [ $n -lt 300 ]; do
    R=$(curl -fsS "$URL/api/pair/$id?code=$code" 2>/dev/null || true)
    case "$R" in
      *'"approved"'*) T=$(printf '%s' "$R" | sed -n 's/.*"token":"\([0-9a-f]*\)".*/\1/p'); break ;;
      *'"rejected"'*) say "허브에서 거절했습니다."; exit 1 ;;
      *'"expired"'*|*'"taken"'*) say "요청이 만료됐습니다. 다시 실행하세요."; exit 1 ;;
    esac
    n=$((n + 1)); sleep 3
  done
  [ -n "$T" ] || { say "15분 안에 승인이 없었습니다. 다시 실행하세요."; exit 1; }
  ( umask 077; printf 'AI_HUB_TOKEN=%s\nAI_HUB_MACHINE=%s\nAI_HUB_URL=%s\n' "$T" "$M" "$URL" > "$D/ai-hub.env" )
  chmod 600 "$D/ai-hub.env" 2>/dev/null || true
  say "승인됨 — 이 기기 전용 토큰을 ~/.claude/ai-hub.env에 저장했습니다(화면에 안 찍음)."
fi

# 2) 스크립트
for f in hub-hook.sh hub-todo.sh hub-file.sh hub-task.sh; do curl -fsSL "$URL/$f" -o "$D/$f.new" && mv "$D/$f.new" "$D/$f"; done
say "스크립트 받음: ~/.claude/hub-hook.sh, hub-todo.sh, hub-file.sh, hub-task.sh"

# 3) 훅(설정 합치기): python3 → python → node 중 되는 것으로
S="$D/settings.json"
[ -f "$S" ] && cp "$S" "$S.bak-ai-hub"
PY=; for p in python3 python; do "$p" -c 'import json' 2>/dev/null && PY=$p && break; done # 윈도우 python3은 스토어 바로가기일 수 있음
if [ -n "$PY" ]; then
  "$PY" - "$S" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p, encoding='utf-8')) if os.path.exists(p) and os.path.getsize(p) else {}
h = d.setdefault('hooks', {})
def c(**k): return {'type': 'command', 'command': 'sh ~/.claude/hub-hook.sh', 'timeout': 5, **k}
w = {'type': 'command', 'command': 'sh ~/.claude/hub-hook.sh wait', 'asyncRewake': True, 'timeout': 86400}
want = {'SessionStart': [{'hooks': [c(), w]}], 'UserPromptSubmit': [{'hooks': [c()]}],
        'PostToolUse': [{'matcher': '', 'hooks': [c(**{'async': True})]}],
        'Stop': [{'hooks': [c(timeout=10), w]}], 'SessionEnd': [{'hooks': [c()]}]}
added = 0
for ev, L in want.items():
    cur = h.setdefault(ev, [])
    if not any('hub-hook.sh' in x.get('command', '') for e in cur for x in e.get('hooks', [])): cur += L; added += 1
up = 0
for e in [e for L in h.values() for e in L]:
    for x in e.get('hooks', []):
        if 'hub-hook.sh wait' in x.get('command', '') and x.get('timeout', 0) < 86400: x['timeout'] = 86400; up += 1 # 예전 3600(1시간 뒤 대기가 끊김) → 하루
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print((f'훅 {added}종 추가' if added else '훅 이미 있음') + (f', 대기 시간 하루로 {up}곳' if up else ''))
PY
elif command -v node >/dev/null 2>&1; then
  node - "$S" <<'JS'
const fs = require('fs'), p = process.argv[2];
const d = fs.existsSync(p) && fs.statSync(p).size ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
const h = (d.hooks ||= {});
const c = (k = {}) => ({ type: 'command', command: 'sh ~/.claude/hub-hook.sh', timeout: 5, ...k });
const w = { type: 'command', command: 'sh ~/.claude/hub-hook.sh wait', asyncRewake: true, timeout: 86400 };
const want = { SessionStart: [{ hooks: [c(), w] }], UserPromptSubmit: [{ hooks: [c()] }], PostToolUse: [{ matcher: '', hooks: [c({ async: true })] }],
  Stop: [{ hooks: [c({ timeout: 10 }), w] }], SessionEnd: [{ hooks: [c()] }] };
let added = 0;
for (const [ev, L] of Object.entries(want)) { const cur = (h[ev] ||= []); if (!cur.some((e) => (e.hooks || []).some((x) => String(x.command || '').includes('hub-hook.sh')))) { cur.push(...L); added++; } }
let up = 0;
for (const L of Object.values(h)) for (const e of L) for (const x of e.hooks || []) if (String(x.command || '').includes('hub-hook.sh wait') && (x.timeout || 0) < 86400) { x.timeout = 86400; up++; }
fs.writeFileSync(p, JSON.stringify(d, null, 2));
console.log((added ? `훅 ${added}종 추가` : '훅 이미 있음') + (up ? `, 대기 시간 하루로 ${up}곳` : ''));
JS
else
  say "python·node가 없어 settings.json을 못 고쳤습니다. 저장소 docs/claude-integration.md의 훅 설정을 직접 넣으세요."; exit 1
fi

# 4) 확인: 저장한 토큰으로 허브에 실제로 들어가지는지
. "$D/ai-hub.env"
if curl -fs -o /dev/null -H "Authorization: Bearer $AI_HUB_TOKEN" "$URL/api/todos?txt=1"; then say "허브 연결 확인됨"; else say "토큰으로 허브에 못 들어갑니다 — ~/.claude/ai-hub.env를 지우고 다시 실행하세요"; exit 1; fi
say ""
say "끝. 이제 이 기기에서 새로 켜는 Claude 세션이 허브에 \"[$M] 폴더\" 이름으로 뜹니다(이미 켜진 세션은 다시 시작)."
