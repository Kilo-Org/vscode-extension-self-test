---
name: vscode-self-test
description: Test and profile VS Code extension flows end to end in an isolated VS Code window
---

Use this skill to verify a VS Code extension through the real UI. Every command is shorthand for:

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs <command> [options]
```

Run commands from the extension repository or a worktree containing `vscode-self-test.config.json`. Every command emits JSON.

# Select a session

Every operational command requires a stable session selector. The optional Kilo plugin at `~/.config/kilo/plugins/vscode-self-test.ts` sets `KILO_SELF_TEST_SESSION` from the current shell call, including a separate ID for each Task child. Restart the calling Kilo backend after installing the plugin. Until then, or with other clients, pass a unique `--session ID` on every command for that test.

Selection order is `--session`, then `KILO_SELF_TEST_SESSION`, then `SELF_TEST_SESSION`. The flag works before or after the command. Missing selectors fail instead of controlling a worktree-wide instance. Do not reuse another agent's selector or generate a new ID for every command. Do not rely on a shell export from a previous tool call.

For a manual run, add the same unique selector to each command below, for example `st start --session my-unique-test`. To pass text beginning with `--`, use an attached value such as `st type --value=--session=example`; otherwise ambiguous payloads are rejected before routing.

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

Pass `--headless true` for automated runs. This hides VS Code windows while keeping the renderer available to Playwright. Electron still needs a display server on Linux, so use Xvfb in displayless CI environments.

# Parallel runs

Each project/session pair has a separate daemon, VS Code profile, XDG directories, Kilo backend home, and active profile capture. Other extensions must respect these storage paths or provide their own backend isolation. Runtime isolation does not isolate workspace files or build outputs.

- Build once before parallel tests and use `--build false` for every agent. Do not rebuild during those runs.
- Keep generated user directories, or give each agent a different `--user-dir`. Explicit user directories are not removed during cleanup.
- Keep generated artifact paths, or use different explicit screenshot and profile output paths.
- Give mutating tests separate fixture workspaces with `--workspace`. Agent Manager tests can write workspace and Git state even with separate profiles.
- Run performance comparisons separately, not concurrently with other tests.
- Clean up only your own session with `stop-vscode --cleanup true`, then `stop`.

For persistence tests, create a unique disposable `--user-dir` before the first launch and reuse it with the same session selector on every relaunch. Default generated profiles are fresh on each launch. Remove the explicit test directory only after its owning instance has stopped; the harness retains it even with `--cleanup true`.

After changing harness scripts, close your test instance and stop its daemon before restarting. Discovery state is at `~/.config/vscode-extension-self-test/state/<project-hash>/<session-hash>/`, or below `SELF_TEST_STATE_DIR` with both hashes appended. A hard crash retains `owner.json`; confirm the owning processes have exited before removing that session's stale lock and state. Do not remove another agent's state or use broad process-name kills. Old project-only state is not adopted automatically.

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
