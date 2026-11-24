#!/bin/sh
# AI 허브 '세션 작업'(T번호 보드)과 세션 카드 — 세션끼리 나눈 일을 세션이 직접 갱신. 사용자에게 맡기는 일은 hub-todo.sh('사용자 할 일')
#   sh hub-task.sh new "제목" [--to 세션이름] [--when "완료 조건"] [--paths "경로"] [--start]   → T번호
#   sh hub-task.sh start|done|block|ask T12 ["한 줄"] [--paths "경로"]   상태 바꾸기(ask = 질문이 있어 멈춤)
#   sh hub-task.sh ls          열린 작업
#   sh hub-task.sh digest      지난번 digest 뒤 바뀐 작업만(PM용)
#   sh hub-task.sh card [--now "지금 하는 일"] [--decided "정한 것"] [--todo "남은 일"] [--files "중요 파일"]   세션 카드 고치기(준 칸만). 인자 없으면 보기
#   sh hub-task.sh handoff [--model M]   카드를 넘겨 같은 이름·폴더로 새 백그라운드 세션을 띄우고, 이 세션은 30초 뒤 멈춤
# 메시지 규격(세션끼리 SendMessage): "@task T12 → 받는세션 | 우선:높음 / 목표 / 완료조건 / 보고"
#                                   보고 "@done|@block|@ask T12 | 결과 | 위치 | 남은 것" — 허브가 보고 보드를 같이 고침
set -e
[ -f "$HOME/.claude/ai-hub.env" ] && . "$HOME/.claude/ai-hub.env"
[ -n "$AI_HUB_TOKEN" ] || { echo "~/.claude/ai-hub.env에 AI_HUB_TOKEN이 없습니다" >&2; exit 1; }
URL="${AI_HUB_URL:-http://localhost:4200}"
M="${AI_HUB_MACHINE:-$(hostname)}"
MH=$(printf '%s' "$M" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g') # 한글 헤더는 %XX(윈도우 curl cp949 문제)
SID=$(printf '%s' "${CLAUDE_CODE_SESSION_ID:-}" | tr -cd 'A-Za-z0-9-')
js() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | awk 'BEGIN{ORS=""} NR>1{print "\\n"} {print}'; }
H() { curl -f -sS -H "Authorization: Bearer $AI_HUB_TOKEN" -H "X-Hub-Machine: $MH" ${SID:+-H "X-Hub-Session: $SID"} "$@"; }
post() { H -X POST -H "Content-Type: application/json; charset=utf-8" --data-binary @- "$URL$1"; echo; }
# --이름 값 쌍을 JSON 조각으로(값이 빈 것도 보냄: 칸 비우기)
opts() { o=; while [ $# -gt 0 ]; do case "$1" in --start) o="$o,\"start\":true";; --*) k=${1#--}; [ "$k" = to ] && k=owner; [ "$k" = when ] && k=done_when; o="$o,\"$k\":\"$(js "${2:-}")\""; shift;; esac; shift; done; printf '%s' "$o"; }
cmd="$1"; [ $# -gt 0 ] && shift
case "$cmd" in
  new)
    [ -n "$1" ] || { echo '제목을 적으세요: sh hub-task.sh new "제목" [--to 세션]' >&2; exit 1; }
    t=$1; shift; printf '{"op":"new","title":"%s"%s}' "$(js "$t")" "$(opts "$@")" | post /api/tasks ;;
  start|done|block|ask|todo)
    [ -n "$1" ] || { echo "작업 번호를 적으세요: sh hub-task.sh $cmd T12 \"한 줄\"" >&2; exit 1; }
    id=$1; shift; note=; case "$1" in --*|'') ;; *) note=$1; shift;; esac
    printf '{"op":"%s","id":"%s"%s%s}' "$cmd" "$(js "$id")" "${note:+,\"note\":\"$(js "$note")\"}" "$(opts "$@")" | post /api/tasks ;;
  ls) H "$URL/api/tasks?txt=1" ;;
  digest)
    F="$HOME/.claude/.hub-task-since-${SID:-$M}"; since=$(cat "$F" 2>/dev/null || echo 0); case "$since" in ''|*[!0-9]*) since=0;; esac
    now=$(($(date +%s) * 1000)); out=$(H "$URL/api/tasks?txt=1&since=$since"); printf '%s\n' "$now" > "$F"
    if [ -n "$out" ]; then printf '%s\n' "$out"; else echo "(바뀐 작업 없음)"; fi ;;
  card)
    if [ $# -eq 0 ]; then H "$URL/api/card?txt=1${SID:+&session=$SID}"; echo; exit 0; fi
    printf '{"session":"%s"%s}' "$SID" "$(opts "$@")" | post /api/card ;;
  handoff)
    [ -n "$SID" ] || { echo "세션 id(CLAUDE_CODE_SESSION_ID)를 몰라 넘길 수 없습니다. Claude Code 세션 안에서 실행하세요." >&2; exit 1; }
    MODEL=; [ "$1" = --model ] && MODEL=$2
    CARD=$(H "$URL/api/card?txt=1&session=$SID" || true)
    [ -n "$CARD" ] || { echo "세션 카드가 비었습니다. 먼저 sh hub-task.sh card --now … --todo … 로 적으세요." >&2; exit 1; }
    PY=; for p in python3 python; do "$p" -c 'import json' 2>/dev/null && PY=$p && break; done
    INFO=$(claude agents --json 2>/dev/null | { if [ -n "$PY" ]; then "$PY" -c "import json,sys
for a in json.load(sys.stdin):
  if a.get('sessionId')=='$SID': print(a.get('id',''), a.get('cwd',''), a.get('name',''), sep='\t')"; else node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const a of JSON.parse(s||'[]'))if(a.sessionId==='$SID')console.log([a.id,a.cwd,a.name].join('\t'))})"; fi; } || true)
    OLD=$(printf '%s' "$INFO" | cut -f1); DIR=$(printf '%s' "$INFO" | cut -f2); NAME=$(printf '%s' "$INFO" | cut -f3-)
    [ -n "$DIR" ] || DIR=$PWD
    P="[이어받기] 앞 세션이 정리하고 넘긴 카드입니다.
$CARD
CLAUDE.md와 이 카드를 읽고, 이어서 할 준비가 되면 한 줄로 '준비됨'만 답하세요."
    cd "$DIR"
    if [ -n "$NAME" ]; then NEW=$(claude --bg -n "$NAME" ${MODEL:+--model "$MODEL"} "$P"); else NEW=$(claude --bg ${MODEL:+--model "$MODEL"} "$P"); fi
    echo "새 세션 띄움: $NEW (폴더 $DIR${NAME:+, 이름 $NAME})"
    if [ -n "$OLD" ]; then
      if command -v setsid >/dev/null 2>&1; then setsid sh -c "sleep 30; claude stop $OLD" >/dev/null 2>&1 < /dev/null &
      else nohup sh -c "sleep 30; claude stop $OLD" >/dev/null 2>&1 < /dev/null & fi
      echo "이 세션($OLD)은 30초 뒤 멈춥니다. 허브 카드·작업·안 간 지시는 새 세션으로 옮겨집니다."
    else
      echo "이 세션은 백그라운드 세션이 아니라 자동으로 멈추지 않습니다. 새 세션이 뜬 걸 확인한 뒤 직접 닫으세요."
    fi ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
