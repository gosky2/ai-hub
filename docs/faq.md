# FAQ

> **English summary** — Common questions: sessions not showing up (restart them after installing hooks, check `aihub doctor`), "asleep" sessions (wake them), Windows (Git Bash), cost (the hub itself is free; sessions use your Claude plan), multiple users (not supported yet), and the Korean-only UI.

**세션이 허브에 안 떠요.**
`aihub doctor`로 확인하세요. 훅을 넣기 전에 켠 세션은 다시 시작해야 합니다. 허브 주소가 그 컴퓨터에서 닿는지(`curl <허브>/api/me`가 401이면 닿음), `~/.claude/ai-hub.env`가 있는지 보세요. 세션 id가 `test`로 끝나는 세션은 일부러 무시합니다.

**`session add`가 "has not been allowed to work in …"으로 멈춰요.**
Claude Code는 처음 쓰는 폴더마다 믿을지 한 번 묻습니다. 그 폴더에서 `claude`를 한 번 열어 허락하고 `/exit` 한 뒤 같은 명령에 `--force`를 붙여 다시 하세요(`--trust`를 붙이면 `aihub`가 열어 줌). 보안 확인이라 `aihub`가 대신 답하지 않습니다.

**'대기 끊김'은 뭔가요?**
세션은 살아 있는데 허브 지시를 기다리는 훅(`wait`)이 끊긴 상태입니다(최대 하루, 또는 네트워크 끊김). 카드의 **깨우기**나 `aihub session wake <이름>`으로 깨웁니다. 지시를 보내 두면 쌓여 있다가 깨어날 때 받습니다.

**PM이 꼭 있어야 하나요?**
아니요. 대화창 '다른 세션에 바로 보내기'로 원하는 세션에 바로 지시할 수 있습니다. PM이 있으면 기본 받는 곳이 되고, 깨우기 요청도 PM이 처리합니다.

**허브가 세션끼리 메시지를 나르나요?**
아니요. 세션끼리는 Claude Code의 SendMessage가 직접 주고받고, 허브는 훅 신호로 흐름을 보여 줍니다. 허브가 나르는 것은 화면(또는 `aihub session send`)에서 보낸 지시뿐입니다.

**윈도우에서 되나요?**
훅은 Git Bash로 돕니다(Claude Code가 훅을 Git Bash로 실행). `join.sh`도 Git Bash에서 실행하세요. 한글 경로·이름은 처리해 두었습니다.

**돈이 드나요?**
허브 자체는 무료입니다. 세션은 각자의 Claude 요금제(또는 API)를 씁니다. '진행' 탭의 금액은 API 단가로 계산한 **추정**이라 구독 청구와 다릅니다.

**여러 사람이 같이 쓸 수 있나요?**
아직 비밀번호 하나를 나눠 쓰는 구조라 한 사람(또는 서로 믿는 작은 팀)용입니다. 사용자 계정·권한은 없습니다.

**화면을 영어로 볼 수 있나요?**
아직 한국어만 있습니다. 번역 기여를 환영합니다([CONTRIBUTING](../CONTRIBUTING.md)).

**데스크톱·모바일 앱은요?**
아직 없습니다. 브라우저에서 쓰고, 폰은 '홈 화면에 추가'로 앱처럼 씁니다.

**데이터를 옮기거나 백업하려면?**
`data/` 폴더(sqlite DB와 파일)를 복사하면 됩니다. 허브를 멈춘 뒤 복사하는 것이 안전합니다.
