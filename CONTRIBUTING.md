# 기여하기 / Contributing

> **English** — Issues and pull requests are welcome. Run `npm ci`, `npm test` and `npm run lint` before you open a PR. Keep the server dependency-free beyond `ws`, keep hook scripts POSIX `sh` (they also run under macOS bash 3.2 and Windows Git Bash), never commit secrets or personal hosts/paths, and add a line to `CHANGELOG.md`.

## 개발 환경

```sh
npm ci
cp .env.example .env    # 또는 aihub init
npm start               # node --env-file-if-exists=.env server/index.mjs
npm test                # 서버 자체 검사 + 단위 테스트 + 끝에서 끝까지 테스트(가짜 claude, curl 필요)
npm run lint            # eslint + 훅 스크립트 문법 검사(sh, bash --posix, dash)
CHECK_BASH32=1 sh test/lint-shell.sh   # docker가 있으면 macOS bash 3.2 문법도
```

화면(`web/`)은 빌드가 없습니다. 고치고 새로 고침하면 됩니다.

## 규칙

- **의존성 늘리지 않기**: 서버 런타임 의존은 `ws` 하나. 몇 줄로 되는 일에 패키지를 넣지 않습니다.
- **훅 스크립트는 POSIX sh**: macOS 기본 bash 3.2, 리눅스 dash, 윈도우 Git Bash에서 다 돌아야 합니다. `$( … )` 안에 `case … ;;`를 쓰지 마세요(bash 3.2가 잘못 읽음). 훅은 실패해도 Claude Code를 막지 않게 늘 `exit 0`으로 끝냅니다(지시 전달용 `wait`의 `exit 2`만 예외).
- **비밀값·개인 정보 넣지 않기**: 토큰, 비밀번호, 개인 도메인, 이메일, 집·회사 경로, 사람·프로젝트 이름. 예시는 `example.com`, `alice`, `/srv/work` 같은 것으로. CI의 gitleaks가 막습니다.
- **보안 경계**: 파일 경로는 `safeRel`, 할 일 확인은 `validCheck`처럼 정해진 형태만 받습니다. 서버가 다른 컴퓨터에 실행할 글을 내려보내는 기능은 받지 않습니다.
- **테스트**: 새 로직(분기·파서·보안)에는 테스트 하나. `server/index.mjs selftest`(순수 함수) 또는 `test/*.test.mjs`.
- `CHANGELOG.md`에 한 줄.

## 번역

화면 글자는 지금 `web/app.js`, `web/index.html`에 한국어로 들어 있습니다. 영어 등 번역을 넣는 구조(문자열 표)를 제안하는 PR을 환영합니다.

## 역할 템플릿

`roles/`에 새 역할을 보낼 때: 첫 줄 `# {{name}} — 역할 이름`, 둘째 줄 `> 한 줄 설명`, `## 하는 일`, `## 하지 않는 일`. 공통 권한 원칙은 `_base.md`에 있으니 반복하지 마세요.
