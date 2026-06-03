#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
KILO_HOME=${KILO_HOME:-"$HOME/.config/kilo"}
SKILLS="$KILO_HOME/skills/vscode-self-test"
SCRIPTS="$KILO_HOME/scripts/vscode-self-test"

mkdir -p "$KILO_HOME/skills" "$KILO_HOME/scripts"
rm -rf "$SKILLS" "$SCRIPTS"
cp -R "$ROOT/skills/vscode-self-test" "$SKILLS"
cp -R "$ROOT/src" "$SCRIPTS"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$SCRIPTS/"
(
  cd "$SCRIPTS"
  npm install --omit=dev
)

printf 'Installed Kilo skill: %s\n' "$SKILLS"
printf 'Installed self-test CLI: %s/cli.mjs\n' "$SCRIPTS"
