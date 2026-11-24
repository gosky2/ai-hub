# 설치

> **English summary** — Needs Node.js 22.13+, Claude Code (logged in), curl and sh. `npm ci && npm link`, then `aihub init`, `aihub start`, `aihub hook install`. Docker: `aihub start --docker`. To connect other machines, make the hub reachable (`PUBLIC_URL`, `HOST`, HTTPS proxy) and run `aihub join-command`'s one-liner there, then approve the code in the hub's to-do tab.

## 필요한 것

| | 버전 | 왜 |
|---|---|---|
| Node.js | 22.13 이상 | 허브 서버(`node:sqlite`)와 `aihub` 명령 |
| Claude Code | 최신 | 세션. `claude auth login`으로 로그인해 둠 |
| curl, sh | | 훅 스크립트. 윈도우는 Git Bash(Claude Code가 훅을 Git Bash로 돌림) |
| python3 | 선택 | 있으면 세션 답·토큰 사용량을 허브 대화창에 보여 줌(없으면 '쉬는 중'만) |
| Docker | 선택 | 허브를 컨테이너로 돌릴 때 |

## 1. 한 컴퓨터에 설치 (가장 흔한 경우)

```sh
git clone <this-repo> ai-hub && cd ai-hub
npm ci
npm link                # 전역 `aihub` 명령. 싫으면 `node cli/aihub.mjs …`로 써도 됨
aihub init              # .env, aihub.config.json 생성. 화면 비밀번호가 한 번 출력됨
aihub start             # 백그라운드로 허브 실행 → http://localhost:4200 (로그 .aihub/hub.log)
aihub hook install      # ~/.claude에 훅 스크립트·ai-hub.env, settings.json에 훅 5종 합치기
aihub doctor
```

`aihub init` 옵션: `--machine 이름`(허브에 보일 컴퓨터 이름, 기본 hostname), `--port 4300`, `--url https://hub.example.com`, `--workspace ~/aihub-sessions`(세션 폴더 기본 위치), `--force`(비밀값 다시 만들기).

이미 켜져 있던 Claude Code 세션은 다시 시작해야 훅이 붙습니다. 그 뒤 새로 여는 세션은 자동으로 허브에 `[컴퓨터] 폴더이름` 카드로 뜹니다.

### Docker

```sh
aihub init
aihub start --docker    # = docker compose up -d --build
aihub hook install      # 훅은 Docker 밖, Claude Code가 도는 컴퓨터에 넣음
```

데이터는 `./data`(sqlite DB와 올린 파일)에 남습니다. 컨테이너는 `127.0.0.1:${PORT}`에만 열립니다.

## 2. 설정

`.env`(비밀값, git에 안 들어감)와 `aihub.config.json`(CLI 설정). 예시는 [`.env.example`](../.env.example), [`aihub.config.example.json`](../aihub.config.example.json).

| 키 | 기본 | 뜻 |
|---|---|---|
| `VIEW_PASSWORD` | 무작위 | 화면 로그인 비밀번호 |
| `EVENT_TOKEN` | 무작위 | 이 컴퓨터 훅이 쓰는 관리자 토큰(다른 컴퓨터는 승인으로 따로 받음) |
| `COOKIE_SECRET` | 무작위 | 로그인 쿠키·공유 링크 서명 |
| `PORT` / `HOST` | 4200 / 127.0.0.1 | 듣는 곳. 다른 컴퓨터에서 붙으려면 `0.0.0.0` 또는 프록시 |
| `PUBLIC_URL` | http://localhost:4200 | 다른 컴퓨터·공유 링크가 쓰는 주소 |
| `SHORT_URL` | (없음) | 짧은 공유 주소용 도메인(그 도메인의 `/s/`를 허브로 프록시) |
| `COOKIE_PATH` | `/` | 프록시 아래 `/ai-hub/`에 둘 때 |
| `TEXT_LIMIT` | 4000 | 지시·메시지·답을 기록에 남길 글자 수. 대화창 답도 이 길이까지(0이면 내용 안 남김) |
| `DB_PATH` / `FILES_DIR` | data/hub.db / data/files | 저장 위치 |
| `TZ` | 시스템 | 토큰 사용량의 '오늘' 기준 |

`aihub.config.json`: `hubUrl`(CLI가 부를 허브 주소), `machine`, `workspace`, `rolesDir`, `claudeArgs`(세션을 띄울 때 `claude`에 더 넘길 인자, 예: `["--permission-mode", "plan"]`).

## 3. 다른 컴퓨터 붙이기

1. 허브를 그 컴퓨터에서 닿게 합니다. 인터넷에 열 땐 **HTTPS 리버스 프록시 뒤**에 둡니다(아래).
   `.env`: `PUBLIC_URL=https://hub.example.com`, 프록시 없이 같은 네트워크면 `HOST=0.0.0.0`, `PUBLIC_URL=http://<허브 IP>:4200`.
2. 허브 컴퓨터에서 `aihub join-command` → 나온 한 줄을 그 컴퓨터 터미널(윈도우는 Git Bash)에서 실행:
   ```sh
   curl -fsSL https://hub.example.com/join.sh | sh -s -- "laptop"
   ```
3. 터미널에 승인 코드가 뜨고, 허브 **할 일**에 `새 기기 붙이기 승인`이 올라옵니다. 코드가 같으면 **했어요**.
4. 그 컴퓨터 전용 토큰이 `~/.claude/ai-hub.env`(600)에 저장되고, 훅이 `~/.claude/settings.json`에 합쳐집니다(백업 `settings.json.bak-ai-hub`).

그 컴퓨터에서 `aihub` 명령도 쓰려면 저장소를 받아 `npm ci && npm link` 후 `aihub.config.json`의 `hubUrl`을 허브 주소로, 환경 변수 `AIHUB_PASSWORD`에 화면 비밀번호를 넣습니다(세션 띄우기·목록은 로컬 `claude`로 하고, 허브 조회만 비밀번호를 씀).

## 4. HTTPS 리버스 프록시 예 (nginx)

```nginx
location / {
  proxy_pass http://127.0.0.1:4200;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;      # 화면 실시간 갱신(웹소켓)
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 120s;                     # 훅의 지시 기다리기(롱폴 50초)
  client_max_body_size 0;                      # 큰 파일 올리기
}
```

하위 경로(`/ai-hub/`)에 둘 땐 `location /ai-hub/ { proxy_pass http://127.0.0.1:4200/; … }`, `.env`에 `COOKIE_PATH=/ai-hub/`, `PUBLIC_URL=https://example.com/ai-hub`.

## 지우기

```sh
aihub hook uninstall     # 이 컴퓨터 ~/.claude에서 허브 훅·스크립트·토큰 파일 제거 (settings.json 백업 후)
aihub stop               # 또는 aihub stop --docker
rm -rf data .env aihub.config.json .aihub
```
