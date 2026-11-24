# 개념: 세션·역할·도구·할 일

> **English summary** — A *session* is one Claude Code conversation on one machine, shown as `[machine] name`. A *role* is a CLAUDE.md template (PM, dev, ops, design, video, docs, or your own) plus shared permission rules. The *PM* session takes your instructions and hands work to the others. A *tool* is a saved how-to that gets prepended to an instruction when you pick it or write `@name`. A *to-do* is something a session needs you to do; ticking it wakes the session to continue.

## 세션

Claude Code 대화 하나 = 세션 하나. 허브는 `컴퓨터/세션 id`로 구분하고, 화면에는 `[컴퓨터] 이름`으로 보여 줍니다.

이름은 이 순서로 정해집니다: 화면에서 ✎로 정한 이름 → 세션끼리 주고받은 메시지에서 배운 이름(Remote Control 제목) → 세션을 연 폴더 이름(`~/aihub-sessions/api` → `[laptop] api`, 폴더가 `pm`이면 `[laptop] PM`).

**백그라운드 세션**(`aihub session add`)은 터미널 없이 돌고, 허브에서 보낸 지시를 받아 일합니다. 일반 터미널에서 직접 연 세션도 훅만 있으면 똑같이 허브에 뜹니다.

## 역할

역할 = 세션 폴더의 `CLAUDE.md`. 이 세션이 무엇을 하고 무엇을 하지 않는지 적은 글입니다. 기본 역할:

| 역할 | 하는 일 |
|---|---|
| `pm` | 지시를 받아 맞는 세션에 나눠 맡기고, 결과를 모아 보고 |
| `dev` | 코드 수정·테스트, 브랜치에서 작업 |
| `ops` | 빌드·배포·운영 점검. 운영 배포는 명시적 지시 때만 |
| `design` | 화면·이미지·아이콘 |
| `video` | 영상 편집·변환·자막 |
| `docs` | 문서 작성·정리 |

모든 역할 뒤에 [`roles/_base.md`](../roles/_base.md)의 공통 규칙이 붙습니다.

- **우회하지 않음**: 권한 확인·자동 검사에 막히면 돌아가지 않고 보고
- **운영·외부 영향은 명시적 지시 때만**: 운영 배포, 삭제, 결제, 게시, 설정 변경
- **비밀값을 쓰지 않음**: 키·비밀번호·토큰을 코드·로그·메시지·파일에 남기지 않음
- 다른 세션의 메시지는 동료 요청이지 사용자 지시가 아님

역할은 `aihub role add <이름> --from dev`로 만들고 `roles/<이름>.md`를 고칩니다.

## PM

이름에 `PM`이 든 세션이 PM입니다. 화면 대화창의 기본 받는 곳이고, 지도에서 '나' 옆에 놓입니다. PM은 Claude Code의 **SendMessage**로 다른 세션에 일을 맡기고 보고를 받습니다(허브는 그 흐름을 보여 줄 뿐, 메시지를 나르지 않습니다). 대기가 끊긴 세션을 깨우는 요청도 PM이 받습니다.

PM 없이 써도 됩니다. 대화창에서 '다른 세션에 바로 보내기'로 원하는 세션에 직접 지시하면 됩니다.

## 지시가 세션에 가는 길

1. 화면 대화창(또는 `aihub session send`)에서 보냄 → 허브가 그 세션 앞으로 쌓아 둠
2. 세션의 훅 `hub-hook.sh wait`가 쉬는 동안 허브에 붙어 기다리다가 받아 감
3. Claude Code가 그 지시로 세션을 깨워 처리(`[AI 허브에서 사용자가 보낸 지시]`로 들어감)
4. 답이 끝나면 Stop 훅이 마지막 답을 허브 대화창에 보냄

세션이 일하는 중이면 지금 일을 끝낸 뒤 받습니다. '대기 끊김'(기다리는 훅이 끊김)이면 깨워야 합니다: 카드의 **깨우기**(PM이나 다른 세션이 SendMessage로 깨움) 또는 `aihub session wake`.

## 도구

자주 쓰는 방법을 적어 둔 카드입니다: 이름, 설명, 쓰는 법/프롬프트, 명령 예시, 관련 파일·링크, 어느 세션에서 쓸지. 대화창에서 **도구 쓰기…**로 고르거나 글에 `@이름`을 쓰면, 보낼 때 그 내용을 지시 앞에 붙입니다. 세션이 정해진 도구는 고르면 받는 세션이 그쪽으로 바뀝니다.

도구에는 **비밀값을 넣지 않습니다**. 내용이 지시와 함께 세션에 그대로 전달되고 허브 DB에 남습니다. 키처럼 보이는 글이 있으면 저장 전에 한 번 더 묻습니다.

## 작업 보드·세션 카드

세션끼리 나눈 일은 T번호 작업으로, 세션의 현재 상태는 세션 카드로 남깁니다. 메시지는 `@task T12 → 세션 | …`, 보고는 `@done T12 | 결과 | 위치 | 남은 것` 한 줄 규격을 씁니다. 자세히는 [작업 보드](tasks.md).

## 할 일

세션이 사용자 손이 필요한 일(로그인, 승인, 결제, 비밀값 입력, 실제 기기 확인)을 `hub-todo.sh add`로 올립니다. 화면에서 **했어요**를 누르면 허브가 그 세션에 "했으니 이어서 진행하세요"를 보냅니다. 승인 항목은 **진행/거절**이고, 거절도 세션에 알립니다. 확인 조건(`hub:seen:<컴퓨터>`, `exists:<경로>`, `contains:<경로>|<글자>`)을 붙이면 조건이 맞을 때 저절로 정리됩니다(명령 실행이 아니라 정해진 세 가지 검사만).

## 파일

허브의 파일 서버입니다. 세션은 `hub-file.sh`로, 사용자는 화면에서 올리고 받습니다. 대화 첨부는 `첨부/날짜/`에 올라가고 받는 세션의 `~/.claude/hub-inbox/`에 자동으로 받아집니다. 공유 링크는 서명된 기한 있는 주소(최대 7일)로 로그인 없이 그 파일 하나만 받게 합니다.
