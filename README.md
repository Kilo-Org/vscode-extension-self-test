# VS Code Extension Self-Test

Private shared harness for testing and profiling VS Code extensions from a real isolated VS Code window. It exposes a JSON CLI for agents and humans, plus an optional MCP adapter.

## Install For Kilo

Install Node.js and npm first. Clone the repository anywhere under your user directory, then run the installer. The installer copies the generic `vscode-self-test` skill and its runtime scripts into the normal user-level Kilo config directory. It is safe to rerun after pulling updates.

### macOS and Linux

```bash
git clone git@github.com:Kilo-Org/vscode-extension-self-test.git ~/vscode-extension-self-test
cd ~/vscode-extension-self-test
./script/install-kilo.sh
```

### Windows PowerShell

```powershell
git clone git@github.com:Kilo-Org/vscode-extension-self-test.git "$HOME\vscode-extension-self-test"
Set-Location "$HOME\vscode-extension-self-test"
.\script\install-kilo.ps1
```

The default destination on every platform is `~/.config/kilo/`. Set `KILO_HOME` before running the installer only when your Kilo user config lives elsewhere. Restart Kilo after installation so it discovers the new skill.

Developers working on the Kilocode VS Code extension can install the detailed Kilo-specific playbook instead of the generic skill:

```bash
./script/install-kilo.sh --kilo-recipe
```

```powershell
.\script\install-kilo.ps1 -KiloRecipe
```

The installed CLI is available at:

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs help
```

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

For a monorepo, set `extensionRoot` to the extension package path. Commands run from that directory. The extension ID defaults to `<publisher>.<name>` from its `package.json`. A ready-to-copy generic example lives at `examples/vscode-self-test.config.json`.

Developers testing Kilocode itself can copy `recipes/kilo/vscode-self-test.config.json` into the Kilocode repository root. `recipes/kilo/SKILL.md` preserves the detailed Kilo sidebar, settings, Agent Manager, and performance-profiling playbook.

## Use

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs start
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs launch-vscode --mode dev --build true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs observe --path /tmp/vscode.png
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop-vscode --cleanup true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop
```

Use `node src/cli.mjs help` for the complete CLI. Every command prints JSON. `--mode dev` loads the extension development directory. `--mode vsix` packages and installs a VSIX into the isolated profile.

## Agent Skill

The installers copy `skills/vscode-self-test/` to `~/.config/kilo/skills/vscode-self-test/` by default. The generic skill documents the stable observe, act, verify workflow. Pass the Kilo recipe flag to install `recipes/kilo/` at the same destination when working in the Kilocode monorepo.

## MCP

Point an MCP client at:

```bash
node ~/.config/kilo/scripts/vscode-self-test/mcp.mjs
```

The MCP adapter starts a per-project daemon automatically. Normal usage should prefer `src/cli.mjs`.

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
| `openers` | Optional Kilo recipe shortcuts for sidebar, settings, and Agent Manager openers. |

Environment overrides: `SELF_TEST_REPO`, `SELF_TEST_CONFIG`, `SELF_TEST_STATE_DIR`, `VSCODE_EXEC_PATH`, and `VSCODE_CLI_PATH`.
