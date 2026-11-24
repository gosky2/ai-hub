# Claude Code 연동

> **English summary** — AI Hub uses only public Claude Code features: **hooks** (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd) report activity and, via an `asyncRewake` hook, deliver hub instructions to an idle session; **SendMessage** (sessions messaging each other) is observed, not relayed; **background sessions** (`claude --bg`, `claude agents`, `--resume`) are what `aihub session` drives; **Remote Control** (`--rc`) is optional. Your Claude login stays inside Claude Code — the hub never sees it.

AI Hub는 Claude Code의 공개 기능만 씁니다. Claude 계정·로그인 정보는 Claude Code 안에만 있고 허브로 가지 않습니다. 허브는 Anthropic API를 부르지 않습니다.

## 훅

`aihub hook install`(또는 `join.sh`)이 `~/.claude/settings.json`에 아래를 **합칩니다**(다른 훅·설정은 그대로, 바꾸기 전 `settings.json.bak-ai-hub`).

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "sh ~/.claude/hub-hook.sh", "timeout": 5 },
                                     { "type": "command", "command": "sh ~/.claude/hub-hook.sh wait", "asyncRewake": true, "timeout": 86400 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "sh ~/.claude/hub-hook.sh", "timeout": 5 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.claude/hub-hook.sh", "async": true, "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "sh ~/.claude/hub-hook.sh", "timeout": 10 },
                                     { "type": "command", "command": "sh ~/.claude/hub-hook.sh wait", "asyncRewake": true, "timeout": 86400 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "sh ~/.claude/hub-hook.sh", "timeout": 5 }] }]
  }
}
```

| 훅 | 허브가 받는 것 | 화면 |
|---|---|---|
| SessionStart | 세션 시작, 폴더, 폴더 `CLAUDE.md`의 첫 제목 | 카드가 뜸 |
| UserPromptSubmit | 사용자 지시 / 다른 세션에서 온 메시지(`<cross-session-message>`) | 일하는 중, 지시·받음 선 |
| PostToolUse | SendMessage면 받는 이와 글, 그 밖엔 '일하는 중' 신호 | 맡김·보고 선 |
| Stop | 마지막 답(transcript에서), 모델, 그 턴의 토큰 합 | 대화창 답, 쉬는 중 |
| SessionEnd | 끝남 | 끊김 |
| SessionStart·Stop의 `wait` | 허브에 붙어 이 세션 앞으로 온 지시를 기다림(최대 하루) | 지시가 오면 `exit 2`로 세션을 깨워 처리 |

- 허브가 꺼져 있거나 네트워크가 끊겨도 Claude Code는 막히지 않습니다(훅은 늘 성공으로 끝남, 3~10초 제한).
- 훅이 보내는 글은 서버에서 앞 `TEXT_LIMIT`(기본 4000)자만 남깁니다. 대화창에 보이는 답도 이 길이까지입니다. 덜 남기려면 줄이세요(0이면 내용을 안 남김).
- 대화 전문·파일 내용은 보내지 않습니다. 토큰 사용량은 숫자 합만 보냅니다.

## SendMessage (세션끼리)

PM이 다른 세션에 일을 맡기는 건 Claude Code의 SendMessage입니다(같은 컴퓨터의 세션, Remote Control 세션). 허브는 **보낸 쪽 PostToolUse**와 **받는 쪽 UserPromptSubmit**을 짝지어 "누가 누구에게 무엇을 맡겼는지" 그립니다. 메시지를 나르거나 바꾸지 않습니다.

받는 세션은 다른 세션의 글을 **동료 요청**으로 다루는 것이 기본입니다(역할 공통 규칙). 사용자 지시를 다른 세션 메시지로 받으려면 각자 규칙(CLAUDE.md)에 분명히 적어야 합니다.

## 백그라운드 세션과 `aihub session`

| `aihub` | Claude Code |
|---|---|
| `session add` | 폴더에 `CLAUDE.md`를 쓰고 `claude --bg -n "[컴퓨터] 이름" [--remote-control …] "<첫 지시>"` |
| `session list` | `claude agents --json` + 허브 상태 |
| `session wake` | `claude --bg --resume <세션 id> "<한 줄>"` (같은 대화를 이어서) |
| `session stop` | `claude stop <id>` |
| (직접 보기) | `claude attach <id>` |

처음 쓰는 폴더는 Claude Code의 신뢰 확인을 사용자가 한 번 직접 받아야 합니다(`aihub`는 대신 답하거나 설정 파일을 고치지 않음). 권한 모드는 Claude Code 설정을 그대로 따릅니다. 백그라운드 세션이 권한 확인에서 멈추면 `claude attach`로 들어가 답하거나, `aihub.config.json`의 `claudeArgs`로 원하는 모드를 넘깁니다. **권한 확인을 끄는 옵션(`--dangerously-skip-permissions`)은 기본으로 넣지 않습니다.**

## Remote Control

`aihub session add … --rc`는 `--remote-control`을 함께 켜서 claude.ai·모바일 앱에서 그 세션을 보고 이어 쓸 수 있게 합니다. Remote Control 세션은 SendMessage 대상 이름으로도 쓰입니다. 허브는 Remote Control에 직접 접속하지 않습니다.

## 왜 MCP 서버가 아니라 훅인가

허브가 원격 MCP 서버라면 세션의 상태를 알려면 세션이 매번 도구를 불러야 하고, 쉬는 세션을 깨울 수 없습니다. 훅은 Claude Code가 일어나는 일마다 부르고, `asyncRewake` 훅은 쉬는 세션을 지시로 깨울 수 있습니다. 설치도 사용자가 직접 실행하는 스크립트(`aihub hook install`, `join.sh`)로만 합니다 — 허브가 다른 컴퓨터의 설정을 원격으로 바꾸지 않습니다.
