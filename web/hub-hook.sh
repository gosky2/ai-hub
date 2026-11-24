#!/bin/sh
# Claude Code hook → AI 허브. 허브가 꺼져 있어도 Claude는 안 막힘(늘 성공으로 끝냄).
# 설정: ~/.claude/ai-hub.env 에 AI_HUB_TOKEN=… (필수), AI_HUB_MACHINE=PC (없으면 hostname), AI_HUB_URL=… (기본 http://localhost:4200)
#   sh hub-hook.sh       : hook 입력(JSON)을 허브로 보냄. Stop이면 transcript에서 마지막 답을 붙여 보냄(오른쪽 대화창)
#   sh hub-hook.sh wait  : asyncRewake hook. 허브에서 이 세션에 보낸 지시를 기다렸다가 받으면 exit 2로 세션을 깨움
[ -f "$HOME/.claude/ai-hub.env" ] && . "$HOME/.claude/ai-hub.env"
[ -n "$AI_HUB_TOKEN" ] || exit 0
URL="${AI_HUB_URL:-http://localhost:4200}"
M="${AI_HUB_MACHINE:-$(hostname)}"
MH=$(printf '%s' "$M" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g') # 기기 이름 헤더는 %XX로(윈도우 curl이 인자 속 한글을 cp949로 바꿔서)
# sh hub-hook.sh desc "설명" [세션 id] : 이 세션이 무엇을 하려고 열렸는지 허브에 한 줄 등록. stdin을 안 읽음
# 세션 id는 인자 > CLAUDE_CODE_SESSION_ID(Claude Code가 Bash에 줌). 둘 다 없을 때만 서버가 이 컴퓨터에서 가장 최근에 일한 세션에 붙임(엉뚱한 카드에 붙던 것)
if [ "$1" = desc ]; then
  [ -n "$2" ] || { echo '설명을 적으세요: sh ~/.claude/hub-hook.sh desc "…"' >&2; exit 1; }
  D=$(printf '%s' "$2" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')
  SID=$(printf '%s' "${3:-${CLAUDE_CODE_SESSION_ID:-}}" | tr -cd 'A-Za-z0-9-')
  SJ=; [ -n "$SID" ] && SJ=",\"session\":\"$SID\""
  printf '{"desc":"%s"%s}' "$D" "$SJ" | curl -fsS -m 10 -X POST -H "Authorization: Bearer $AI_HUB_TOKEN" -H "X-Hub-Machine: $MH" -H 'Content-Type: application/json; charset=utf-8' --data-binary @- "$URL/api/desc"
  echo; exit 0
fi
IN=$(cat)

# 첨부("[첨부] 첨부/날짜/xxxx-이름 (크기)")는 ~/.claude/hub-inbox/에 받아 두고 로컬 경로를 붙임 → Claude가 Read로 바로 봄.
# 함수로 따로 둠: $( … ) 안에 case … ;; 를 쓰면 맥 기본 bash 3.2(sh)가 괄호 짝을 잘못 읽어 문법 오류 → 훅 전체가 exit 2로 입력을 막았음(0.1.21)
fetch_attachments() {
  while IFS= read -r line; do
    printf '%s\n' "$line"
    case "$line" in
      "[첨부] 첨부/"*) ;;
      *) continue ;;
    esac
    p=${line#\[첨부\] }; p=${p% (*}
    case "$p" in
      *..*|*\\*) continue ;; # 경로 밖으로 나가는 것 막기
    esac
    dest="$HOME/.claude/hub-inbox/$p"; mkdir -p "$(dirname "$dest")"
    q=$(printf '%s' "$p" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g; s/%2f/\//g')
    if curl -sf -m 300 -H "Authorization: Bearer $AI_HUB_TOKEN" -o "$dest" "$URL/api/files/$q"; then
      if command -v cygpath >/dev/null 2>&1; then dest=$(cygpath -w "$dest"); fi # 윈도우: Read가 읽는 C:\… 경로로
      printf '  → 받아 둠: %s (Read로 열어 보세요)\n' "$dest"
    else
      printf '  → 못 받음: sh ~/.claude/hub-file.sh get "%s" 로 받으세요\n' "$p"
    fi
  done
}

if [ "$1" = wait ]; then
  S=$(printf '%s' "$IN" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$S" ] || exit 0
  L="${TMPDIR:-/tmp}/ai-hub-wait-$S"
  # 세션마다 기다리는 것은 하나만(Stop마다 새로 불려도 겹치지 않게)
  if [ -f "$L" ] && kill -0 "$(cat "$L" 2>/dev/null)" 2>/dev/null; then exit 0; fi
  echo $$ > "$L"
  # 할 일 자동 정리: 이 컴퓨터가 맡긴 할 일 중 확인(check)이 맞는 것(이미 해결됨)은 허브에서 뺌. 컴퓨터마다 5분에 한 번.
  # 확인은 명령이 아니라 정해진 두 가지만(서버가 준 글을 실행하지 않음): exists:<경로>  /  contains:<경로>|<글자>
  checks() {
    C="${TMPDIR:-/tmp}/ai-hub-checks-$M"
    # 시각 파일이 비었거나 깨졌으면 0으로(여러 세션이 동시에 쓰는 사이에 빈 파일을 읽으면 산술식이 깨져 Stop 훅 오류가 났음)
    last=$(cat "$C" 2>/dev/null); case "$last" in ''|*[!0-9]*) last=0;; esac
    [ $(( $(date +%s) - last )) -lt 300 ] && return 0
    date +%s > "$C"
    curl -sf -m 10 -H "Authorization: Bearer $AI_HUB_TOKEN" -H "X-Hub-Machine: $MH" "$URL/api/todos/checks" | while IFS='	' read -r id chk; do
      [ -n "$id" ] || continue
      ok=1
      case "$chk" in
        exists:*) f=${chk#exists:}; case "$f" in "~/"*) f="$HOME/${f#\~/}";; esac; [ -e "$f" ] && ok=0 ;;
        contains:*) r=${chk#contains:}; f=${r%%|*}; t=${r#*|}; case "$f" in "~/"*) f="$HOME/${f#\~/}";; esac
          [ "$r" != "$f" ] && [ -n "$t" ] && [ -f "$f" ] && grep -qF -- "$t" "$f" 2>/dev/null && ok=0 ;;
      esac
      if [ $ok -eq 0 ]; then
        printf '{"note":"자동 확인: 이미 해결됨"}' | curl -sf -m 10 -X POST -H "Authorization: Bearer $AI_HUB_TOKEN" -H 'Content-Type: application/json; charset=utf-8' --data-binary @- "$URL/api/todos/$id/drop" >/dev/null || true
      fi
    done
  }
  # 설정의 wait 훅 timeout(86400초, 하루)보다 조금 짧게. 옛 설정(3600)이면 그때 Claude Code가 끊고 다음 Stop에서 다시 기다림
  end=$(( $(date +%s) + ${AI_HUB_WAIT_SECS:-86000} ))
  while [ "$(date +%s)" -lt "$end" ]; do
    checks
    R=$(curl -sf -m 60 -H "Authorization: Bearer $AI_HUB_TOKEN" -H "X-Hub-Machine: $MH" "$URL/api/inbox?session=$S") || { sleep 15; continue; }
    if [ -n "$R" ]; then
      rm -f "$L"
      R=$(printf '%s\n' "$R" | fetch_attachments)
      printf '[AI 허브에서 사용자가 보낸 지시]\n%s\n' "$R" >&2
      exit 2
    fi
  done
  rm -f "$L"; exit 0
fi

# Stop: 마지막 답(최근 사용자 지시 뒤 assistant 글)을 last_assistant_message로, 마지막 assistant 줄의 모델 id를 model로 붙임(허브 카드에 모델 표시). python 없으면 그냥 보냄
if printf '%s' "$IN" | grep -q '"hook_event_name" *: *"Stop"' && ! printf '%s' "$IN" | grep -q '"model" *: *"'; then
  PY=; for p in python3 python; do "$p" -c '' 2>/dev/null && PY=$p && break; done # 윈도우 python3은 스토어 바로가기일 수 있음
  if [ -n "$PY" ]; then
    OUT=$(printf '%s' "$IN" | "$PY" -c "
import json,sys
d=json.loads(sys.stdin.buffer.read().decode('utf-8','replace')); buf=[]; md=None; us={}; last=None # 윈도우 파이썬은 stdin을 cp949로 읽어 한글이 깨짐(0.1.38~0.1.40 PC 답) → 바이트로 읽어 UTF-8
try:
    for line in open(d.get('transcript_path') or '',encoding='utf-8'):
        try: e=json.loads(line)
        except Exception: continue
        c=(e.get('message') or {}).get('content')
        if e.get('type')=='user':
            if isinstance(c,str) or not any(isinstance(x,dict) and x.get('type')=='tool_result' for x in (c or [])): buf=[]; us={}
        elif e.get('type')=='assistant' and isinstance(c,list):
            md=(e.get('message') or {}).get('model') or md
            u=(e.get('message') or {}).get('usage')
            if isinstance(u,dict): us[(e.get('message') or {}).get('id') or len(us)]=u; last=u
            buf+=[x.get('text','') for x in c if isinstance(x,dict) and x.get('type')=='text']
except Exception: pass
t='\n\n'.join(x for x in buf if x.strip()).strip()
if t and not d.get('last_assistant_message'): d['last_assistant_message']=t[-8000:]
if md and md!='<synthetic>' and not d.get('model'): d['model']=md
# 이 턴의 토큰 합(메시지 id로 겹치지 않게)만 허브에 보냄 — 대화 전문은 안 보냄. ctx = 마지막 요청의 입력(캐시 포함) = 컨텍스트 크기
if us:
    g=lambda u,k: int(u.get(k) or 0)
    d['hub_usage']={'in':sum(g(u,'input_tokens') for u in us.values()),'out':sum(g(u,'output_tokens') for u in us.values()),'cr':sum(g(u,'cache_read_input_tokens') for u in us.values()),'cw':sum(g(u,'cache_creation_input_tokens') for u in us.values()),'ctx':g(last,'input_tokens')+g(last,'cache_read_input_tokens')+g(last,'cache_creation_input_tokens')}
print(json.dumps(d))
" 2>/dev/null) && [ -n "$OUT" ] && IN=$OUT
  fi
fi

# 세션이 켜질 때: 그 폴더 CLAUDE.md의 첫 "# 제목"을 세션 설명 후보로 보냄(허브에서 ✎로 적은 설명이 먼저)
DH=
if printf '%s' "$IN" | grep -q '"hook_event_name" *: *"SessionStart"'; then
  CW=$(printf '%s' "$IN" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p' | head -1 | sed 's/\\\\/\\/g')
  if [ -n "$CW" ] && [ -f "$CW/CLAUDE.md" ]; then
    T=$(sed -n 's/^# *//p' "$CW/CLAUDE.md" | head -1 | cut -c1-120)
    [ -n "$T" ] && DH=$(printf '%s' "$T" | od -An -tx1 -v | tr -d ' \n' | sed 's/\(..\)/%\1/g')
  fi
fi
printf '%s' "$IN" | curl -s -m 3 -o /dev/null -X POST "$URL/api/hook" \
  -H "Authorization: Bearer $AI_HUB_TOKEN" \
  -H "X-Hub-Machine: $MH" \
  ${DH:+-H "X-Hub-Desc: $DH"} \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @- || true
exit 0
