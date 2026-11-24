# Changelog

## [0.1.1] - unreleased

### Added
- Work board (T-numbered tasks: owner, state todo/doing/block/done, done-when, result, paths): `~/.claude/hub-task.sh new|start|done|block|ask|ls|digest`, `aihub task …`, API `/api/tasks` with `since`, a "작업" tab with a changed-since-last-view badge. The to-do tab is now "내 할 일" (user to-dos) to keep the two apart.
- One-line message format `@task T12 → session | priority / goal / done-when / report` and `@done|@block|@ask T12 | result | where | left`: the hub updates the board from session messages and shows them as cards.
- The same message sent twice by one session through two routes (name and bridge address) within two minutes is shown once.
- Session cards (now / decided / todo / files) and "refresh" (web button after confirmation, or `aihub session refresh`): the session updates its card and runs `hub-task.sh handoff`, which starts a fresh background session with the same name and folder and hands it the card; the hub moves name, queued instructions, to-dos, card and task ownership over.
- Context bar per session (last request's context / 200k, 1M for `[1m]` models) with a refresh hint past 75%.
- Default `model` / `effort` per role in `roles/roles.json`, applied by `session add` and `wake`; `role add --model --effort`.
- Role rules for the work board and message format (`roles/_base.md`, `roles/pm.md`), docs/tasks.md.

## [0.1.0] - 2026-11-24

First public cut, generalized from a private single-user hub.

### Added
- Hub server (Node 22, `node:sqlite`, `ws`): session state from Claude Code hooks, instruction queue with long-poll delivery, to-dos with approve/reject and auto-checks, file server with share links, tools, token usage estimates, device pairing with per-device tokens.
- Web page: map, chat (attachments, `@tool`), files (preview, drag-and-drop upload, context menu, move), to-do, progress, agents and tools panels.
- `aihub` CLI: `init`, `start`/`stop` (node or `--docker`), `status`, `doctor`, `hook install|uninstall`, `join-command`, `session add|list|send|wake|stop|rm` (Claude Code background sessions with a role), `role list|show|add`, `tool list|add|rm`.
- Role templates: shared rules (`roles/_base.md`: no bypassing permission checks, production/external actions only on explicit instruction, no secrets) and `pm`, `dev`, `ops`, `design`, `video`, `docs`.
- Docs (Korean with English summaries), README in Korean and English, CI (lint, tests, gitleaks), Dockerfile and compose file.

### Changed (from the private hub)
- All hosts, paths, names and project folders removed; everything is configured through `.env` / `aihub.config.json`, defaulting to `http://localhost:4200`.
- Server listens on `127.0.0.1` by default; `Secure` cookie only on https/localhost; cookie path defaults to `/`.
- Hook and join scripts are served with the hub's own `PUBLIC_URL` filled in.
- "Today" for token usage follows the server time zone.

### Removed
- The desktop/mobile app wrapper and its signing/upload scripts (personal), and personal operating notes.
