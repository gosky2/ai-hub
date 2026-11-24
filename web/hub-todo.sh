#!/bin/sh
# AI 허브 '할 일' — 세션이 사용자에게 맡기는 일(보안·꼭 승인받을 것·사용자가 직접 해야 할 것)을 허브 오른쪽 목록에 올림.
# 사용자가 하고 체크하면 이 세션에 "[허브 할 일 #N 완료] … 이어서 진행하세요"가 지시로 들어옴(hub-hook.sh wait 필요).
#   sh hub-todo.sh add [--approve] "할 일 한 줄" ["자세한 설명(마크다운)"] ["확인"]
#        --approve: 승인 요청(허브에 🔐 진행/거절, 결과가 "[허브 승인 #N 진행|거절] …"로 옴 — 거절이면 하지 말 것)
#        옵션이 없으면 "승인…"·"확인…"으로 시작하는 글은 승인으로 봄. 나머지는 사용자가 할 일(했어요/필요 없음)
#   sh hub-todo.sh kind <번호> approve|do   종류 바꾸기
#        확인(맞으면 이미 해결된 것 → 자동으로 뺌, 명령은 안 됨): 'contains:~/.claude/settings.json|hub-hook.sh'(파일에 글자)
#        'exists:~/.ssh/id_ed25519'(파일 있음, 이 컴퓨터가 5분마다 봄) / 'hub:seen:PC'(PC에서 훅 신호가 오면, 서버가 봄)
#   sh hub-todo.sh check <번호> "확인"   이미 올린 할 일에 붙이기
#   sh hub-todo.sh ls          아직 안 한 것
#   sh hub-todo.sh drop <번호>  필요 없어진 것 빼기(세션에 안 알림)
set -e
[ -f "$HOME/.claude/ai-hub.env" ] && . "$HOME/.claude/ai-hub.env"
[ -n "$AI_HUB_TOKEN" ] || { echo "~/.claude/ai-hub.env에 AI_HUB_TOKEN이 없습니다(docs/hooks.md 2번)" >&2; exit 1; }
API="${AI_HUB_URL:-http://localhost:4200}/api/todos"
M="${AI_HUB_MACHINE:-$(hostname)}"
# 한글은 curl 인자로 넘기지 않음: 윈도우 Git Bash의 curl은 인자 속 한글을 cp949로 바꿔 보냄 → 본문은 stdin(@-), 기기 이름 헤더는 %XX로
MH=$(printf '%s' "$M" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g')
# JSON 문자열로(따옴표·역슬래시·줄바꿈·탭)
js() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | awk 'BEGIN{ORS=""} NR>1{print "\\n"} {print}'; }
post() { curl -f -sS -X POST -H "Authorization: Bearer $AI_HUB_TOKEN" -H "X-Hub-Machine: $MH" -H "Content-Type: application/json; charset=utf-8" --data-binary @- "$1"; echo; }
case "$1" in
  add)
    shift; K=
    if [ "$1" = --approve ]; then K=approve; shift; elif [ "$1" = --do ]; then K=do; shift; fi
    [ -n "$1" ] || { echo '할 일 내용을 적으세요: sh hub-todo.sh add [--approve] "…"' >&2; exit 1; }
    printf '{"text":"%s","detail":"%s","check":"%s","kind":"%s"}' "$(js "$1")" "$(js "${2:-}")" "$(js "${3:-}")" "$K" | post "$API" ;;
  kind) printf '{"kind":"%s"}' "$3" | post "$API/$2/kind" ;;
  drop) printf '{}' | post "$API/$2/drop" ;;
  check) printf '{"check":"%s"}' "$(js "$3")" | post "$API/$2/check" ;;
  ls) curl -f -sS -H "Authorization: Bearer $AI_HUB_TOKEN" "$API?txt=1" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
