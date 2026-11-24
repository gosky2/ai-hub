#!/bin/sh
# AI 허브 파일 서버 명령줄. 토큰은 ~/.claude/ai-hub.env(AI_HUB_TOKEN, AI_HUB_MACHINE)를 hub-hook.sh와 같이 씀
#   sh hub-file.sh put <로컬 파일> [원격 경로]   올리기(원격 경로 없으면 파일 이름 그대로, '폴더/'로 끝나면 그 폴더에)
#   sh hub-file.sh get <원격 경로> [로컬 파일]   받기(로컬 없으면 지금 폴더에 같은 이름)
#   sh hub-file.sh ls [경로 앞부분]              목록(크기, 올린 시각 UTC, 올린 컴퓨터, 경로)
#   sh hub-file.sh rm <원격 경로>                지우기
#   sh hub-file.sh url <원격 경로>               화면(로그인)에서 여는 주소
#   sh hub-file.sh share <원격 경로> [시간]      로그인 없이 받는 공유 링크(기본 24시간, 최대 168)
set -e
[ -f "$HOME/.claude/ai-hub.env" ] && . "$HOME/.claude/ai-hub.env"
[ -n "$AI_HUB_TOKEN" ] || { echo "~/.claude/ai-hub.env에 AI_HUB_TOKEN이 없습니다(docs/hooks.md 2번)" >&2; exit 1; }
API="${AI_HUB_URL:-http://localhost:4200}/api/files"
M="${AI_HUB_MACHINE:-$(hostname)}"
MH=$(printf '%s' "$M" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g') # 기기 이름 헤더는 %XX로(윈도우 curl이 인자 속 한글을 cp949로 바꿔서)
# 경로를 %XX로(한글·빈칸), '/'는 그대로
enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g; s/%2f/\//g'; }
c() { curl -f -sS -H "Authorization: Bearer $AI_HUB_TOKEN" -H "X-Hub-Machine: $MH" "$@"; }

case "$1" in
  put)
    [ -f "$2" ] || { echo "올릴 파일이 없습니다: $2" >&2; exit 1; }
    R="${3:-$(basename "$2")}"; case "$R" in */) R="$R$(basename "$2")";; esac
    c -# -T "$2" "$API/$(enc "$R")"; echo ;;
  get)
    [ -n "$2" ] || { echo "받을 경로를 적으세요" >&2; exit 1; }
    c -# -o "${3:-$(basename "$2")}" "$API/$(enc "$2")"; echo "-> ${3:-$(basename "$2")}" ;;
  ls) c "$API?txt=1&prefix=$(enc "$2")" ;;
  rm) [ -n "$2" ] || { echo "지울 경로를 적으세요" >&2; exit 1; }; c -X DELETE "$API/$(enc "$2")"; echo ;;
  url) echo "$API/$(enc "$2")" ;;
  share) [ -n "$2" ] || { echo "공유할 경로를 적으세요" >&2; exit 1; }
    L=$(c -X POST "$API/$(enc "$2")?share=${3:-24}" | sed -n 's/.*"link":"\([^"]*\)".*/\1/p'); [ -n "$L" ] || exit 1; echo "$API/$L" ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
