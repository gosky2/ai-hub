# 구조

> **English summary** — One Node.js process (`server/index.mjs`, sqlite via `node:sqlite`, WebSocket via `ws`) serves the static web page (`web/`), receives Claude Code hook events over HTTP, keeps session state in memory, queues instructions that hooks long-poll for, and stores files. `cli/aihub.mjs` sets things up and drives `claude --bg`. Nothing talks to Anthropic except Claude Code itself.

## 그림

```
 ┌──────────── 컴퓨터 A ─────────────┐          ┌──────────── 허브 ─────────────┐
 │ Claude Code 세션 ─ hooks ─────────┼─ HTTP ──▶│ server/index.mjs              │
 │   hub-hook.sh (이벤트 보내기)       │  POST    │  ├ /api/hook   이벤트 받기     │
 │   hub-hook.sh wait (지시 기다리기) ◀┼─ 롱폴 ───│  ├ /api/inbox  지시 내주기     │
 │   hub-todo.sh / hub-file.sh       │          │  ├ /api/files  파일 서버       │
 │ aihub CLI ─ claude --bg ─▶ 세션     │          │  ├ /api/todos  할 일           │
 └───────────────────────────────────┘          │  ├ /api/tools  도구            │
 ┌──────────── 컴퓨터 B ─────────────┐          │  ├ sqlite (data/hub.db)        │
 │ (join.sh로 붙인 기기, 같은 훅)      │── HTTP ─▶│  └ 웹소켓 /ws ──┐              │
 └───────────────────────────────────┘          └─────────────────┼──────────────┘
                                                                  ▼
                                                    브라우저 (web/index.html, app.js)
                                                    지도·대화·파일·할 일·진행·도구
```

세션끼리의 메시지는 Claude Code의 **SendMessage**가 직접 나릅니다. 허브는 훅이 알려 주는 "보냄/받음"으로 그 흐름을 그릴 뿐입니다.

## 구성 요소

| 경로 | 무엇 |
|---|---|
| `server/index.mjs` | 허브 서버 하나. 의존성은 `ws`뿐. `node server/index.mjs selftest`로 자체 검사 |
| `web/` | 화면(빌드 없음: `index.html`, `app.js`, `style.css`)과 훅 스크립트(`hub-hook.sh`, `hub-todo.sh`, `hub-file.sh`, `join.sh`) |
| `cli/aihub.mjs` | `aihub` 명령 |
| `roles/` | 역할 템플릿(`_base.md` + 역할별) |
| `test/` | 단위 테스트, 끝에서 끝까지 테스트(가짜 `claude`), 셸 문법 검사 |

## 데이터

sqlite 한 파일(`data/hub.db`)과 올린 파일(`data/files/`).

| 표 | 내용 | 보관 |
|---|---|---|
| `events` | 훅 이벤트(시각, 컴퓨터, 세션, 종류, 받는 이, 글 앞 `TEXT_LIMIT`자) | 30일 |
| `asks` | 화면에서 세션에 보낸 지시(전달 여부) | 계속 |
| `todos` | 할 일 | 끝난 것은 화면에서 7일 |
| `files`, `file_moves`, `shortlinks` | 파일 목록, 옮긴 옛 경로, 짧은 공유 주소 | 계속 / 만료 7일 뒤 지움 |
| `tools` | 도구 | 계속 |
| `devices`, `pairs` | 기기별 토큰(해시만), 붙이기 요청 | 계속 / 15분 |
| `names`, `aliases`, `autonames`, `descs`, `hidden`, `models`, `usage` | 카드 이름·설명·숨김, 모델, 토큰 사용량 | 계속 |

세션 상태(일하는 중·쉬는 중 등)는 메모리에 있고, 서버를 켤 때 최근 7일 이벤트로 다시 만듭니다.

## HTTP API

인증: **토큰**(`Authorization: Bearer …`, 훅·스크립트) 또는 **로그인 쿠키**(화면, `aihub`).

| 메서드·경로 | 인증 | 하는 일 |
|---|---|---|
| `POST /api/hook` | 토큰 | Claude Code 훅 입력(JSON 그대로) → 이벤트. 헤더 `X-Hub-Machine` |
| `POST /api/event` | 토큰 | 이벤트 직접 `{machine, session, type, to?, text?}` |
| `GET /api/inbox?session=` | 토큰 | 지시 롱폴(50초). 있으면 글, 없으면 204 |
| `POST /api/desc` | 토큰 | 세션 설명 등록 |
| `GET/PUT/DELETE /api/files/<경로>` · `GET /api/files?prefix=` · `POST /api/files {move}` · `POST /api/files/<경로>?share=시간` | 토큰·쿠키 (받기는 공유 서명도) | 파일 서버 |
| `GET/POST /api/todos` · `POST /api/todos/<id>/done\|undo\|drop\|check\|kind` | 토큰·쿠키 | 할 일 |
| `POST /api/pair` · `GET /api/pair/<id>?code=` | 없음(속도 제한) | 새 기기 붙이기 |
| `POST /api/login` · `/api/logout` | 비밀번호 | 화면 로그인(1초에 한 번) |
| `GET /api/state` · `/api/usage` · `/api/me` | 쿠키 | 세션·최근 이벤트, 토큰 사용량, 버전 |
| `POST /api/ask {to, text}` · `/api/wake` · `/api/session` · `/api/model` | 쿠키 | 지시 보내기, 깨우기, 이름·설명·숨기기, 모델 |
| `GET/POST /api/tools` · `DELETE /api/tools/<id>` | 쿠키 | 도구 |
| `GET /ws` | 쿠키 | 실시간 갱신 |
| `GET /s/<코드>` | 없음 | 짧은 공유 주소 → 서명된 받기 주소 |
