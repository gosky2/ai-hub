# 세션 작업 보드·메시지 규격·세션 카드

> **English summary** — The *work board* holds tasks sessions hand each other (T numbers: title, owner, state todo/doing/block/done, done-when, result, paths). Sessions update it with `~/.claude/hub-task.sh` or by writing `@task T12 → <session> | priority / goal / done-when / report` and `@done|@block|@ask T12 | result | where | left` lines in their messages; the hub reads those lines and shows them as cards. The PM reads only what changed with `digest`. Each session keeps a *card* (now / decided / todo / files); **Refresh** asks the session to update it and hand off to a fresh session with the same name, folder and role. A context bar suggests a refresh past 75%. Roles carry default `model`/`effort` in `roles/roles.json`. *User to-dos* (things a person must do) stay separate.

'내 할 일'(`hub-todo.sh`)은 **사람이** 할 일, '작업'(`hub-task.sh`)은 **세션끼리** 나눈 일입니다. 섞지 않습니다.

## 작업 보드 (T번호)

세션 안에서:

```sh
sh ~/.claude/hub-task.sh new "제목" [--to "<세션>"] [--when "완료 조건"] [--paths "경로"] [--start]   # → T12
sh ~/.claude/hub-task.sh start T12 ["한 줄"]
sh ~/.claude/hub-task.sh done  T12 "결과 한 줄" [--paths "docs/a.png"]
sh ~/.claude/hub-task.sh block T12 "막힌 이유"
sh ~/.claude/hub-task.sh ask   T12 "물을 것"
sh ~/.claude/hub-task.sh ls                 # 열린 작업(+7일 안에 끝난 것)
sh ~/.claude/hub-task.sh digest             # 지난 digest 뒤 바뀐 것만 (PM용)
```

밖에서(`aihub`): `aihub task ls | digest | new "제목" --to <세션> --when ".." | start|done|block|ask T12 "한 줄"`.

상태: `todo`(할 것) → `doing`(하는 중) → `done`(끝남). 막히거나 물을 게 있으면 `block`. 담당을 안 주면 부른 세션이 담당입니다. 화면 '작업' 탭은 막힘·하는 중·할 것·끝남 순으로 보여 주고, 마지막으로 본 뒤 바뀐 수를 배지로 표시합니다.

API: `GET /api/tasks[?since=<ms>][&txt=1]`, `POST /api/tasks {op: new|start|done|block|ask|todo|edit, id, title, owner, note, done_when, paths}` (토큰·로그인).

## 짧은 메시지 규격 (세션끼리 SendMessage)

```
@task T12 → <받는 세션> | 우선:높음 / 목표 / 완료조건 / 보고
@done T12 | 결과 | 위치 | 남은 것
@block T12 | 막힌 이유
@ask T12 | 물을 것
```

- 메시지나 답의 아무 줄에 있으면 허브가 읽어 보드를 고칩니다(`@task`는 담당·완료 조건, 나머지는 상태·결과·위치). 없는 T번호는 무시합니다.
- 화면은 이 줄을 카드(맡김·끝남·막힘·질문 + T번호 단추)로 풀어서 보여 줍니다. T번호를 누르면 보드로 갑니다.
- 같은 세션이 같은 글을 두 길(세션 이름·bridge 주소 등)로 보내면 2분 안에 한 번만 보여 줍니다. 서로 다른 세션 여럿에 보낸 것은 그대로 둡니다.

## 세션 카드·정리하고 새로 시작

```sh
sh ~/.claude/hub-task.sh card --now "지금 하는 일" --decided "정한 것" --todo "남은 일" --files "중요 파일"   # 준 칸만 바꿈
sh ~/.claude/hub-task.sh card                # 보기  (밖에서: aihub card <세션>)
sh ~/.claude/hub-task.sh handoff [--model M] # 카드를 넘겨 같은 이름·폴더의 새 백그라운드 세션, 이 세션은 30초 뒤 멈춤
```

- 허브 카드와 에이전트 목록에 **대화 길이 막대**(마지막 요청의 컨텍스트 / 200k, 모델 이름에 `[1m]`이면 1M)가 보이고, 75%를 넘으면 "요약해서 새로 시작할까요?"가 뜹니다.
- **정리하고 새로 시작**(화면, 사용자 확인 뒤) 또는 `aihub session refresh <이름>`: 허브가 그 세션에 "카드 최신화 → handoff" 지시를 보냅니다. 같은 컴퓨터·같은 폴더에서 새 세션이 켜지면 허브가 이름·안 간 지시·열린 할 일·카드·작업 담당을 새 세션으로 옮기고 옛 카드는 숨깁니다.
- 백그라운드 세션이 아니면(터미널·Remote Control) 옛 세션은 자동으로 멈추지 않습니다. 새 세션이 뜬 걸 보고 직접 닫으세요.

## 역할별 모델·effort

`roles/roles.json`에 역할마다 기본값을 둡니다. `aihub session add`·`wake`가 `claude --model … --effort …`로 넘기고, 명령에 `--model`·`--effort`를 주면 그것이 먼저입니다.

```json
{ "pm": { "model": "opus", "effort": "high" }, "docs": { "model": "sonnet", "effort": "low" } }
```

`aihub role add <이름> --from dev --model sonnet --effort medium`으로 새 역할과 기본값을 함께 만들 수 있습니다. `aihub role list`가 역할별 모델·effort를 보여 줍니다.
