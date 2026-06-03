---
name: vscode-self-test
description: Test and profile VS Code extension flows end to end in an isolated VS Code window
---

Use this skill to verify a VS Code extension through the real UI. Every command is shorthand for:

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs <command> [options]
```

Run commands from the extension repository or a worktree containing `vscode-self-test.config.json`. Every command emits JSON.

# Lifecycle

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }
st start
st launch-vscode --mode dev --build true
st status
st stop-vscode --cleanup true
st stop
```

Use `--mode vsix` when packaged-extension behavior matters. Set `VSCODE_EXEC_PATH` if VS Code is not installed in a standard location.

# Observe, act, verify

1. Launch isolated VS Code and open the surface with `run-command` or normal UI clicks.
2. Run `frames` when the extension UI uses a webview.
3. Capture `observe --frame "$FRAME"` and read the returned screenshot path.
4. Interact with stable `--selector` or `--text` locators. Avoid pixel coordinates.
5. Verify with `wait`, `snapshot`, `observe`, or focused `evaluate` DOM queries.
6. Check `console --type error` and `logs` if behavior is unclear.
7. Restart isolated VS Code for persistence tests.
8. Finish with `stop-vscode --cleanup true`, then `stop`.

# Commands

```bash
state
frames
observe [--path FILE] [--selector CSS] [--text TEXT] [--frame MATCH]
screenshot [--path FILE] [--selector CSS] [--text TEXT] [--frame MATCH]
snapshot [--frame MATCH]
click [--selector CSS | --text TEXT] [--frame MATCH]
hover [--selector CSS | --text TEXT] [--frame MATCH]
type --value TEXT [--selector CSS | --text TEXT] [--clear] [--submit]
press --keys SHORTCUT
wait [--selector CSS | --text TEXT] [--frame MATCH]
run-command --command TEXT
console [--type error|warning|log]
logs [--filter TEXT]
evaluate --script JS [--frame MATCH]
profile-start [--frame MATCH]
profile-stop [--dir DIR]
profile-analyze --dir DIR [--path REPORT]
```

Webview content lives inside nested iframes. Use `frames`, select a unique frame URL substring, and pass it consistently to `observe`, interaction, DOM query, and profiling commands.

Screenshots are evidence only after reading the returned PNG file. Keep a tight observe, act, verify loop and do not guess selectors when the DOM can be inspected.
