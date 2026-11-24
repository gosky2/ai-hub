# Changelog

## [0.1.0] - unreleased

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
