#!/bin/sh
# Syntax-check the hook scripts with every shell they run under: POSIX sh, bash --posix,
# and (when docker is around) macOS's bash 3.2. Claude Code runs hooks with sh on macOS/Linux and Git Bash on Windows.
set -e
cd "$(dirname "$0")/../web"
for f in *.sh; do
  sh -n "$f"
  if command -v bash >/dev/null 2>&1; then bash --posix -n "$f"; fi
  if command -v dash >/dev/null 2>&1; then dash -n "$f"; fi
done
if [ -n "$CHECK_BASH32" ] && command -v docker >/dev/null 2>&1; then
  for f in *.sh; do docker run --rm -v "$PWD:/w:ro" bash:3.2 bash -n "/w/$f"; done
fi
echo "shell scripts ok"
