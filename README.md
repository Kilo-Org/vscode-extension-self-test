# VS Code Extension Self-Test

Shared harness for testing and profiling VS Code extensions from a real isolated VS Code window. It includes a Kilo skill, a JSON CLI for agents and humans, and an optional MCP adapter.

## Install With Kilo

The easiest setup is to point Kilo at this repository. Paste this into a Kilo session:

```text
Install the vscode-self-test skill from https://github.com/Kilo-Org/vscode-extension-self-test at user level. Clone or update the repository under my user directory. Back up the existing ~/.config/kilo/skills/vscode-self-test directory, ~/.config/kilo/scripts/vscode-self-test directory, and ~/.config/kilo/plugins/vscode-self-test.ts file if they exist. Copy skills/vscode-self-test to ~/.config/kilo/skills/vscode-self-test, copy scripts/vscode-self-test to ~/.config/kilo/scripts/vscode-self-test, and copy plugins/vscode-self-test.ts to ~/.config/kilo/plugins/vscode-self-test.ts. Run npm install --omit=dev, npm test, and npm run self-check inside the copied scripts directory. Do not modify unrelated Kilo configuration or project files. If this workspace is the Kilocode monorepo, install recipes/kilo/SKILL.md as the skill instead and copy recipes/kilo/vscode-self-test.config.json to the repository root when needed. Tell me what was installed, where any backup was stored, whether verification passed, and that the calling Kilo backend needs a restart to load the automatic session hook.
```

This is intentionally a file-copy installation. Another agent can inspect the repository, preserve an existing self-test installation, install the directories and session plugin, and verify the runtime without needing a platform-specific installer.

## Repository Layout

| Path | Purpose |
|---|---|
| `skills/vscode-self-test/` | Generic user-level Kilo skill. |
| `scripts/vscode-self-test/` | Runtime CLI, daemon, MCP adapter, profiler, dependencies, and self-check. |
| `plugins/vscode-self-test.ts` | Optional Kilo hook that supplies the calling agent's session ID to shell commands. |
| `recipes/kilo/` | Detailed Kilocode monorepo playbook and project configuration. |
| `examples/vscode-self-test.config.json` | Generic project configuration example. |

## Manual Installation

Install Node.js and npm first. Clone the repository anywhere under your user directory:

```bash
git clone git@github.com:Kilo-Org/vscode-extension-self-test.git ~/vscode-extension-self-test
cd ~/vscode-extension-self-test
```

### macOS and Linux

```bash
KILO_HOME="${KILO_HOME:-$HOME/.config/kilo}"
mkdir -p "$KILO_HOME/skills" "$KILO_HOME/scripts" "$KILO_HOME/plugins"
rm -rf "$KILO_HOME/skills/vscode-self-test" "$KILO_HOME/scripts/vscode-self-test"
cp -R skills/vscode-self-test "$KILO_HOME/skills/vscode-self-test"
cp -R scripts/vscode-self-test "$KILO_HOME/scripts/vscode-self-test"
cp plugins/vscode-self-test.ts "$KILO_HOME/plugins/vscode-self-test.ts"
npm install --omit=dev --prefix "$KILO_HOME/scripts/vscode-self-test"
npm test --prefix "$KILO_HOME/scripts/vscode-self-test"
npm run self-check --prefix "$KILO_HOME/scripts/vscode-self-test"
```

### Windows PowerShell

```powershell
$KiloHome = if ($env:KILO_HOME) { $env:KILO_HOME } else { Join-Path $HOME ".config\kilo" }
New-Item -ItemType Directory -Force -Path (Join-Path $KiloHome "skills"), (Join-Path $KiloHome "scripts"), (Join-Path $KiloHome "plugins") | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $KiloHome "skills\vscode-self-test"), (Join-Path $KiloHome "scripts\vscode-self-test")
Copy-Item -Recurse "skills\vscode-self-test" (Join-Path $KiloHome "skills\vscode-self-test")
Copy-Item -Recurse "scripts\vscode-self-test" (Join-Path $KiloHome "scripts\vscode-self-test")
Copy-Item "plugins\vscode-self-test.ts" (Join-Path $KiloHome "plugins\vscode-self-test.ts")
npm install --omit=dev --prefix (Join-Path $KiloHome "scripts\vscode-self-test")
npm test --prefix (Join-Path $KiloHome "scripts\vscode-self-test")
npm run self-check --prefix (Join-Path $KiloHome "scripts\vscode-self-test")
```

The manual commands replace an existing `vscode-self-test` installation. Back up those two target directories and the session plugin first when preserving local changes matters. They do not modify other user-level Kilo skills or configuration. Non-Kilo clients can omit the plugin and pass an explicit session selector.

Restart the calling Kilo backend after installation so it discovers the skill and session plugin. Existing sessions can use `--session` until then. Do not restart the backend that owns an active test without first cleaning up that test.

## Kilocode Recipe

Developers working in the Kilocode monorepo can install the detailed playbook after copying the generic directories:

```bash
cp recipes/kilo/SKILL.md ~/.config/kilo/skills/vscode-self-test/SKILL.md
cp recipes/kilo/vscode-self-test.config.json /path/to/kilocode/vscode-self-test.config.json
```

Use the equivalent `Copy-Item` commands on Windows. The recipe documents Kilo sidebar, settings, Agent Manager, and performance-profiling workflows.

## Configure A Project

Create `vscode-self-test.config.json` in the extension repository:

```json
{
  "extensionRoot": ".",
  "workspace": ".",
  "extensionId": "publisher.extension-name",
  "build": { "command": ["npm", "run", "package"] },
  "vsix": { "command": ["npx", "vsce", "package", "--no-dependencies", "--skip-license", "-o", "{outDir}/"] }
}
```

For a monorepo, set `extensionRoot` to the extension package path. Commands run from that directory. The extension ID defaults to `<publisher>.<name>` from its `package.json`.

## Use

Every operational command requires a session selector. Kilo's plugin sets `KILO_SELF_TEST_SESSION` from the current shell tool call, including a separate identity for each Task child. For manual runs, choose a unique selector and use it for the complete test:

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs start --session example-run
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs launch-vscode --session example-run --mode dev --build true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs observe --session example-run
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop-vscode --session example-run --cleanup true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop --session example-run
```

Use `node ~/.config/kilo/scripts/vscode-self-test/cli.mjs help` for the complete CLI. Every operational command prints JSON. `--mode dev` loads the extension development directory. `--mode vsix` packages and installs a VSIX into the isolated profile. Pass `--headless true` to hide VS Code windows while keeping Playwright automation and screenshots available. Linux displayless CI environments still need Xvfb.

### Parallel Agents

Selection order is `--session`, then `KILO_SELF_TEST_SESSION`, then `SELF_TEST_SESSION`. A missing selector fails instead of controlling another agent's instance. The flag works before or after the command. Use attached values for payloads that begin with `--`, such as `type --value=--session=example`; a text payload must not change the selected session.

Each project/session pair has its own daemon, VS Code profile, XDG directories, Kilo backend home, and active profile capture. Generated runtime paths are short enough for macOS IPC sockets. Shutdown and cleanup affect only the owning session. Other extensions must respect these storage paths or provide their own backend isolation.

- Build once before parallel runs, then launch each agent with `--build false`. Source files and build outputs remain shared. Do not rebuild while other agents test that build.
- Keep generated profile directories, or use a different `--user-dir` for each agent. An explicit user directory is retained during cleanup.
- Use different explicit screenshot and profile output paths, or keep the generated defaults.
- Use separate fixture workspaces for tests that modify workspace files, Git state, or Agent Manager state. Separate VS Code instances do not isolate those files.
- Run performance comparisons one at a time. Concurrent captures can verify isolation, but do not provide controlled performance measurements.

### Recovery

Daemon discovery and ownership live under `~/.config/vscode-extension-self-test/state/<project-hash>/<session-hash>/`. `SELF_TEST_STATE_DIR` replaces the base directory; project and session hashes are still appended.

After a hard crash, inspect that session's `owner.json` and confirm its owned processes have exited before removing its stale lock and discovery state. Do not take over a lock merely because a status request times out. Old project-only state is not adopted. Confirm ownership before stopping old processes; never delete all harness state or use broad process-name kills.

## MCP

Point an MCP client at:

```bash
node ~/.config/kilo/scripts/vscode-self-test/mcp.mjs --session unique-mcp-run
```

The MCP adapter starts a project/session daemon automatically. Give each independent MCP client its own stable selector in its arguments or environment. The shell plugin does not supply identity to an already-running MCP server. Normal usage should prefer `cli.mjs`.

## Configuration

| Field | Purpose |
|---|---|
| `extensionRoot` | Extension package directory relative to the repository root. |
| `workspace` | Workspace opened in the isolated VS Code window. |
| `extensionId` | Installed extension identifier, defaulting to `<publisher>.<name>`. |
| `build.command` | Argument array used before launch when `--build true`. |
| `vsix.command` | Argument array used in VSIX mode. `{outDir}` is replaced automatically. |
| `vscode.executable` | Optional VS Code Electron executable override. |
| `vscode.cli` | Optional `code` CLI override for VSIX installation. |
| `vscode.settings` | Additional isolated-profile VS Code settings. |
| `profile.markPrefix` | Prefix for semantic performance marks, defaulting to `selftest.`. |
| `openers` | Optional Kilocode recipe shortcuts for sidebar, settings, and Agent Manager openers. |

Environment overrides: `SELF_TEST_REPO`, `SELF_TEST_CONFIG`, `SELF_TEST_STATE_DIR`, `KILO_SELF_TEST_SESSION`, `SELF_TEST_SESSION`, `VSCODE_EXEC_PATH`, and `VSCODE_CLI_PATH`.
