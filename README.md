# VS Code Extension Self-Test

Shared harness for testing and profiling VS Code extensions from a real isolated VS Code window. It includes a Kilo skill, a JSON CLI for agents and humans, and an optional MCP adapter.

## Install With Kilo

The easiest setup is to point Kilo at this repository. Paste this into a Kilo session:

```text
Install the vscode-self-test skill from https://github.com/Kilo-Org/vscode-extension-self-test at user level. Clone or update the repository under my user directory. Back up only an existing ~/.config/kilo/skills/vscode-self-test directory and ~/.config/kilo/scripts/vscode-self-test directory if they exist. Copy skills/vscode-self-test to ~/.config/kilo/skills/vscode-self-test and copy scripts/vscode-self-test to ~/.config/kilo/scripts/vscode-self-test. Run npm install --omit=dev and npm run self-check inside the copied scripts directory. Do not modify unrelated Kilo configuration or project files. If this workspace is the Kilocode monorepo, install recipes/kilo/SKILL.md as the skill instead and copy recipes/kilo/vscode-self-test.config.json to the repository root when needed. Tell me what was installed, where any backup was stored, and whether verification passed.
```

This is intentionally a file-copy installation. Another agent can inspect the repository, preserve an existing self-test installation, install the two directories, and verify the runtime without needing a platform-specific installer.

## Repository Layout

| Path | Purpose |
|---|---|
| `skills/vscode-self-test/` | Generic user-level Kilo skill. |
| `scripts/vscode-self-test/` | Runtime CLI, daemon, MCP adapter, profiler, dependencies, and self-check. |
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
mkdir -p "$KILO_HOME/skills" "$KILO_HOME/scripts"
rm -rf "$KILO_HOME/skills/vscode-self-test" "$KILO_HOME/scripts/vscode-self-test"
cp -R skills/vscode-self-test "$KILO_HOME/skills/vscode-self-test"
cp -R scripts/vscode-self-test "$KILO_HOME/scripts/vscode-self-test"
npm install --omit=dev --prefix "$KILO_HOME/scripts/vscode-self-test"
npm run self-check --prefix "$KILO_HOME/scripts/vscode-self-test"
```

### Windows PowerShell

```powershell
$KiloHome = if ($env:KILO_HOME) { $env:KILO_HOME } else { Join-Path $HOME ".config\kilo" }
New-Item -ItemType Directory -Force -Path (Join-Path $KiloHome "skills"), (Join-Path $KiloHome "scripts") | Out-Null
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $KiloHome "skills\vscode-self-test"), (Join-Path $KiloHome "scripts\vscode-self-test")
Copy-Item -Recurse "skills\vscode-self-test" (Join-Path $KiloHome "skills\vscode-self-test")
Copy-Item -Recurse "scripts\vscode-self-test" (Join-Path $KiloHome "scripts\vscode-self-test")
npm install --omit=dev --prefix (Join-Path $KiloHome "scripts\vscode-self-test")
npm run self-check --prefix (Join-Path $KiloHome "scripts\vscode-self-test")
```

The manual commands replace an existing `vscode-self-test` installation. Back up those two target directories first when preserving local changes matters. They do not modify other user-level Kilo skills or configuration.

Restart Kilo after installation so it discovers the skill.

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

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs start
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs launch-vscode --mode dev --build true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs observe --path /tmp/vscode.png
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop-vscode --cleanup true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop
```

Use `node ~/.config/kilo/scripts/vscode-self-test/cli.mjs help` for the complete CLI. Every operational command prints JSON. `--mode dev` loads the extension development directory. `--mode vsix` packages and installs a VSIX into the isolated profile. Pass `--headless true` to hide VS Code windows while keeping Playwright automation and screenshots available. Linux displayless CI environments still need Xvfb.

## MCP

Point an MCP client at:

```bash
node ~/.config/kilo/scripts/vscode-self-test/mcp.mjs
```

The MCP adapter starts a per-project daemon automatically. Normal usage should prefer `cli.mjs`.

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

Environment overrides: `SELF_TEST_REPO`, `SELF_TEST_CONFIG`, `SELF_TEST_STATE_DIR`, `VSCODE_EXEC_PATH`, and `VSCODE_CLI_PATH`.
