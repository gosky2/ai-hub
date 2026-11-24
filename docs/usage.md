# 사용법

> **English summary** — The web page has a map, chat, files, to-do, progress, agents and tools. The `aihub` CLI covers setup (`init`, `start`, `stop`, `status`, `doctor`, `hook install|uninstall`, `join-command`), sessions (`session add|list|send|wake|stop|rm`), roles (`role list|show|add`) and tools (`tool list|add|rm`). Session names on the hub look like `[machine] name`.

## 화면

| 칸 | 하는 일 |
|---|---|
| **에이전트 ▾** | 허브에 붙은 세션 목록. 줄을 누르면 이 세션에 보내기·지도에서 보기·이름·설명·숨기기·깨우기 |
| **도구 ▾** | 도구 목록·찾기·추가·고치기·지우기. 대화에서 쓰기 |
| **지도** | 세션 카드(가운데 '나', 옆에 PM). 열린 일은 카드 사이의 별로. 카드를 끌어 자리 옮기기, 누르면 자세히 |
| **대화** | 고른 세션(기본 PM)과 나의 대화. 첨부(붙여넣기·끌어 놓기·📎), `도구 쓰기…` 또는 `@도구이름`, '다른 세션에 바로 보내기' |
| **파일** | 폴더 탐색, 아이콘·목록 보기, 미리보기, 끌어 놓기 올리기, 우클릭(폰은 길게 누르기) 메뉴: 받기·주소 복사·공유 링크·이름 바꾸기·옮기기·지우기, 끌어서 다른 폴더로 옮기기 |
| **할 일** | 세션이 맡긴 일. **했어요**(그 세션이 이어서 진행), **필요 없음**, 승인 항목은 **진행/거절** |
| **진행** | 일 한 줄씩(지시됨·진행 중·완료). 누르면 지시·답 전문, 추가 요청·재촉·멈춰. 맨 위 토큰 사용량(API 단가 기준 추정) |

세션 상태: **일하는 중** · **쉬는 중**(지시 받을 수 있음) · **대기 끊김**(세션은 있는데 지시를 못 받음 — 깨우기 필요) · **끊김**.

## `aihub` 명령

### 준비

```sh
aihub init [--machine NAME] [--url URL] [--port N] [--workspace DIR] [--force]
aihub start [--docker | --fg]
aihub stop [--docker]
aihub status
aihub doctor
aihub hook install [--machine NAME]
aihub hook uninstall
aihub join-command
```

### 세션

```sh
aihub session add <이름> --role <역할> [--dir <폴더>] [--rc] [--model <모델>] [--prompt "<첫 지시>"] [--trust] [--force]
aihub session list
aihub session send <이름> "<지시>"
aihub session wake <이름>
aihub session stop <이름>
aihub session rm <이름>
```

- `add`는 `<폴더>`(기본 `workspace/<이름>`)에 역할 템플릿으로 `CLAUDE.md`를 쓰고, 그 폴더에서 `claude --bg -n "[컴퓨터] 이름"`으로 백그라운드 세션을 띄웁니다. 폴더에 이미 `CLAUDE.md`가 있으면 건드리지 않고 `CLAUDE.aihub.md`에 씁니다(쓰려면 `CLAUDE.md`에 `@CLAUDE.aihub.md` 한 줄).
- **처음 쓰는 폴더**는 Claude Code가 "이 폴더를 믿나요?"를 한 번 묻습니다. 백그라운드로는 답할 수 없어서 `aihub`가 멈추고 방법을 알려 줍니다: `cd <폴더> && claude` → 믿음 선택 → `/exit` 뒤 `--force`로 다시. `--trust`를 붙이면 `aihub`가 그 폴더에서 Claude를 열어 줍니다(답은 직접). `aihub`는 Claude의 신뢰 설정을 대신 바꾸지 않습니다.
- `--rc`: Remote Control도 켭니다(claude.ai·모바일 앱에서 그 세션을 이어 볼 수 있음).
- 역할을 안 주면 이름이 `pm`이면 pm, 아니면 dev.
- `list`: 이 컴퓨터에서 `aihub`로 띄운 세션과 그 Claude 상태(`claude agents`), 허브 상태.
- `wake`: 멈췄거나 대기가 끊긴 세션을 같은 대화로 다시 백그라운드에 띄웁니다(`claude --bg --resume <세션 id>`).
- `send`: 허브를 거쳐 지시를 보냅니다(화면 대화창과 같음). 세션이 일하는 중이면 끝나고 받습니다.
- 세션을 직접 보고 싶으면 `claude attach <id>`.

### 역할

```sh
aihub role list
aihub role show <역할>          # 세션 CLAUDE.md로 들어갈 내용 미리 보기
aihub role add <이름> [--from <역할>]
```

역할 파일은 `roles/<이름>.md`입니다. 첫 줄 `# …`이 허브 카드 설명이 되고, `> …` 줄이 목록에 나오는 한 줄 설명입니다. `{{name}}`, `{{machine}}`, `{{role}}`, `{{hubUrl}}`은 세션을 띄울 때 채워집니다. 모든 역할 뒤에 `roles/_base.md`(공통 규칙·권한 원칙)가 붙습니다.

### 도구

```sh
aihub tool list
aihub tool add <이름> --desc "한 줄" --how "쓰는 법" [--example "명령"] [--links "경로·링크"] [--target <세션>]
aihub tool rm <이름>
```

같은 이름으로 다시 `add`하면 준 칸만 고칩니다. 화면의 '도구' 패널과 같은 데이터입니다.

## 세션 안에서 쓰는 명령 (훅을 넣은 컴퓨터)

```sh
sh ~/.claude/hub-todo.sh add "할 일" "자세히" [check]   # 사용자에게 할 일 맡기기
sh ~/.claude/hub-todo.sh ls
sh ~/.claude/hub-file.sh put <파일> <폴더/>             # 파일 서버에 올리기
sh ~/.claude/hub-file.sh get <경로> [저장할 곳]
sh ~/.claude/hub-file.sh ls [폴더/]
sh ~/.claude/hub-file.sh share <경로> [시간]            # 로그인 없이 받는 기한 있는 링크
sh ~/.claude/hub-hook.sh desc "이 세션이 하는 일"       # 허브 카드 설명
```
