# Third-party licenses / 의존 라이선스

## Runtime (shipped, `npm ci --omit=dev`)

| Package | Version | License | Use |
|---|---|---|---|
| [ws](https://github.com/websockets/ws) | 8.18.0 | MIT | WebSocket server for live page updates |

Node.js built-ins only otherwise (`node:sqlite`, `node:http`, `node:crypto`, …). Node.js is MIT-licensed with bundled third-party components under their own licenses.

The web page loads no third-party scripts, fonts or styles from the network.

## Development only (not shipped)

| Package | Version | License |
|---|---|---|
| eslint | 9.17.0 | MIT |
| @eslint/js | 9.17.0 | MIT |
| globals | 15.14.0 | MIT |

Their transitive dependencies are listed in `package-lock.json`; regenerate a full list with `npx license-checker --summary` when they change.

## CI only

| Tool | License |
|---|---|
| [gitleaks](https://github.com/gitleaks/gitleaks) (via `gitleaks/gitleaks-action`) | MIT |
| GitHub Actions `actions/checkout`, `actions/setup-node` | MIT |

## External programs the hub expects on each machine (not bundled)

Claude Code (Anthropic, under its own terms), `curl`, `sh`, optionally `python3` and Docker.
