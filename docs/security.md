# 보안

> **English summary** — The hub stores hook events (the first 4000 characters of instructions, messages and answers by default (`TEXT_LIMIT`), 30 days), files you upload, to-dos, tools, and hashed device tokens. It never receives your Claude credentials or full transcripts. Secrets live in `.env` (mode 600) and `~/.claude/ai-hub.env` (mode 600). Keep it on localhost or behind HTTPS. Anyone with the web password or a device token can send instructions that your Claude sessions will act on — treat them like SSH keys.

## 무엇이 어디로 가나

| 데이터 | 어디서 → 어디로 | 저장 |
|---|---|---|
| 세션 이벤트(시작·지시·메시지·답·끝) | 훅 → 허브 | 글은 앞 `TEXT_LIMIT`자(기본 4000, 0이면 안 남김), 30일 |
| 세션 폴더 경로 | 훅 → 허브 | 카드 이름(폴더 이름)만 저장 |
| 폴더 `CLAUDE.md`의 첫 제목 | 훅 → 허브 | 카드 설명 |
| 모델 이름, 턴별 토큰 수 | Stop 훅 → 허브 | 계속(사용량 화면) |
| 화면에서 보낸 지시, 첨부 | 브라우저 → 허브 → 세션 | 지시 전문(최대 8000자), 첨부 파일 |
| 올린 파일 | 세션·브라우저 → 허브 | `data/files/` |
| 도구 내용 | 브라우저 → 허브 → (지시에 붙어) 세션 | 계속 |
| 기기 토큰 | 허브 → 그 기기 한 번 | 서버엔 SHA-256 해시만 |

허브로 가지 **않는** 것: Claude 로그인·API 키, 대화 전문, 세션이 읽은 파일 내용(직접 올린 것 제외).
허브가 **하지 않는** 것: Anthropic API 호출, 외부 전송, 다른 컴퓨터 설정 원격 변경.

## 비밀값

- `.env`(허브): `VIEW_PASSWORD`, `EVENT_TOKEN`, `COOKIE_SECRET`. `aihub init`이 무작위로 만들고 600 권한으로 씁니다. git에 넣지 않습니다(`.gitignore`).
- `~/.claude/ai-hub.env`(각 컴퓨터): 그 컴퓨터 토큰. 600 권한.
- 화면·응답·로그·문서에 토큰을 찍지 않습니다(`join.sh`도 화면에 안 찍음).
- 저장소는 CI에서 gitleaks로 비밀값을 검사합니다.

## 접근 제어

- 화면: 비밀번호 → HttpOnly·SameSite=Lax 쿠키(180일, HTTPS·localhost면 Secure). 틀리면 1초에 한 번만.
- 훅: 토큰. 기기마다 따로 발급(허브 화면에서 코드 확인 후 승인), 서버엔 해시만. 기기 빼기는 지금 `devices.revoked`를 채우는 방식(화면 버튼 없음).
- 붙이기 요청(인증 없음)은 30초에 한 번, 대기 3개까지, 15분 만료. 승인은 화면에 로그인한 사용자만.
- 공유 링크: HMAC 서명 + 기한(최대 7일), 파일 하나·받기만.
- 올린 파일은 `Content-Security-Policy: sandbox`, `nosniff`, 글·코드는 `text/plain`으로 내보내 허브 주소에서 스크립트로 돌지 않게 합니다.
- 할 일의 자동 확인은 명령이 아니라 정해진 세 가지 검사(`hub:seen:`, `exists:`, `contains:`)만 받습니다. 서버가 다른 컴퓨터에 실행할 글을 내려보내지 않습니다.

## 위험과 권장

- **허브 비밀번호나 기기 토큰을 가진 사람은 당신의 Claude 세션에 지시를 보낼 수 있습니다.** 세션은 그 컴퓨터에서 당신 권한으로 일합니다. SSH 키처럼 다루세요.
- 기본은 `127.0.0.1`에만 엽니다. 다른 컴퓨터에서 쓰려면 **HTTPS 프록시 뒤**에 두고, 사설망이면 방화벽으로 막으세요.
- 세션의 권한 모드는 Claude Code 설정을 따릅니다. 허브는 권한 확인을 끄지 않습니다. 백그라운드 세션에 위험한 권한 모드를 주지 마세요.
- 역할 공통 규칙([roles/_base.md](../roles/_base.md)): 우회 금지, 운영·외부 영향은 명시적 지시 때만, 비밀값 안 씀, 다른 세션 메시지는 사용자 지시가 아님.
- 도구·지시·파일에 비밀값을 넣지 마세요. DB와 파일 서버에 남습니다.

## 취약점 알리기

공개 이슈 대신 저장소 관리자에게 비공개로 알려 주세요(GitHub의 Security → Report a vulnerability).
