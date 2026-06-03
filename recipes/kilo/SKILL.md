---
name: vscode-self-test
description: Test and profile extension flows end to end in VS Code
---

Use this skill when you need to verify a VS Code extension feature in `packages/kilo-vscode/` from the real UI.

**All interactions use one CLI command.** Do NOT call `mcp.mjs`, `daemon.mjs`, or `engine-mcp.mjs` directly — those are internal. Do NOT call the daemon HTTP API with `curl` — the CLI handles auth and routing internally.

Every command below is shorthand for:

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs <command> [options]
```

Run from any directory inside the kilocode repo or worktree. The scripts auto-detect the repo root. Before first use, copy `recipes/kilo/vscode-self-test.config.json` from the shared harness repository into the kilocode repo root as `vscode-self-test.config.json`.

Every command outputs JSON to stdout.

---

# Build first

Build the extension before testing when your changes affect the packaged extension, webview code, commands, or startup behavior.

| Changed area | Minimum reliable action |
|---|---|
| Webview SolidJS, CSS, commands, manifest, or extension host | Run `bun run compile` from `packages/kilo-vscode/`, then restart isolated VS Code |
| Packaged extension behavior | Launch with `--mode vsix` |
| No source changes, only exploration | Reuse the current isolated VS Code session |

Use the repo's normal build flow for `packages/kilo-vscode/`, then start or restart the self-test stack if needed.

---

# Start the stack

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs start
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs launch-vscode --mode dev --build true
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs status
```

To stop:

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop-vscode
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs stop
```

If VS Code is not in a standard macOS install location, pass `--app-path /path/to/Code` or set `VSCODE_EXEC_PATH`. The `code` shell command is only required for `vsix` mode.

---

# Test an arbitrary extension feature

Use this loop for sidebar chat, settings, editor webviews, commands, and Agent Manager:

1. Build when source changed, then launch isolated VS Code.
2. Open the relevant surface and capture its returned `frame.match` when available.
3. Run `observe --frame "$FRAME"`, read the screenshot, and inspect the text snapshot.
4. Interact through stable `--selector` or `--text` locators. Use `hover` for tooltip or hover-only UI and `click --button right` for context menus.
5. Verify the result with `wait`, `snapshot`, `observe`, or a focused `evaluate` DOM query.
6. Check `console --type error` and `logs` when behavior is unclear.
7. For persistence behavior, restart isolated VS Code and verify again.
8. Finish with `stop-vscode --cleanup true`, then `stop`.

| Surface | Open command | Frame to use |
|---|---|---|
| VS Code dialogs, notifications, command palette | None or `run-command` | Omit `--frame` |
| Kilo sidebar chat | `open-kilo` | Returned `structuredContent.frame.match` |
| Kilo settings editor | `open-kilo-settings` | Returned `structuredContent.frame.match` |
| Agent Manager editor | `open-agent-manager` | Returned `structuredContent.frame.match` |

If a feature has no opener, run the command or click the UI that opens it, then use `frames`, `snapshot`, and structural DOM queries to identify the correct webview.

---

# Command reference

## Lifecycle

```bash
start                                          # Start per-worktree daemon
stop                                           # Stop daemon and VS Code
status                                         # Check daemon and session status
launch-vscode [--mode dev|vsix] [--build true|false] [--workspace PATH]
stop-vscode [--cleanup true|false]
```

## Observe (screenshots saved to disk, path in JSON output at structuredContent.path)

```bash
screenshot [--path FILE] [--selector CSS] [--text TEXT] [--frame MATCH]
observe [--path FILE] [--selector CSS] [--text TEXT] [--frame MATCH]  # screenshot + text
snapshot [--frame MATCH]                       # text only
state                                          # session metadata + text
frames                                         # list Playwright frames
```

## Interact

**ALWAYS use `--selector` or `--text` for clicking.** These use Playwright's element matching, which is accurate regardless of window size or layout. NEVER guess pixel coordinates (`--x`/`--y`) — they break across machines and screen sizes. Coordinates are a last resort when no selector or text match exists.

```bash
click --text "Models"                          # Good: Playwright finds the element
click --selector '[aria-label="Send"]'         # Good: CSS selector
click --selector '.item' --button right        # Context menu
click --x 448 --y 145                          # BAD: fragile pixel guessing
hover --selector '[aria-label="Help"]'         # Tooltip or hover-only control

type --value TEXT [--selector CSS | --text TEXT] [--clear] [--submit]
press --keys SHORTCUT                          # e.g. Enter, Meta+Shift+P
wait [--selector CSS | --text TEXT] [--state visible|hidden|attached|detached]
scroll [--delta-x N] [--delta-y N]
move --x N --y N
```

When `--text` doesn't match (e.g. webview content in iframes), use `--frame MATCH` to target the right frame. Run `frames` first to discover available frames.

## Webview frame targeting (critical)

VS Code extension UI lives inside nested iframes. Clicks, text lookups, selectors, DOM queries, and CPU profiling on the outer VS Code page will NOT reliably reach webview content. You MUST target the correct frame.

The CLI resolves `--frame MATCH` with a first-match substring search over frame names and URLs. A broad match can silently select the wrong frame when multiple Kilo surfaces are open.

### Frame taxonomy

| Surface | Typical frame URL pattern | Safe match |
|---|---|---|
| VS Code outer workbench | VS Code page URL | Omit `--frame` only for workbench chrome |
| Kilo sidebar | URL contains `purpose=webviewView` | Returned `open-kilo` `frame.match` |
| Kilo settings editor | Inner URL contains `fake.html?id=<uuid>` | Returned `open-kilo-settings` `frame.match` |
| Agent Manager editor tab | Inner URL contains `fake.html?id=<uuid>` | Returned `open-agent-manager` `frame.match` |

Agent Manager is the important exception. When the sidebar and Agent Manager are both open, `--frame "kilocode.kilo-code"` often reaches the sidebar instead of Agent Manager. For Agent Manager interaction and profiling, use the exact `fake.html?id=<uuid>` match returned by `open-agent-manager`.

The `fake.html` frame is VS Code's generated inner webview frame, not a page you inject manually. `open-agent-manager` already disambiguates it structurally by finding a frame that contains `.am-layout [data-sidebar-id="local"]`. It returns `frame.match`, `frame.name`, and `frame.url` in JSON without depending on translated UI text. Use `frame.match`: multiple inner frames may share a non-unique name such as `pending-frame`.

### Recommended Agent Manager opener

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }

OPEN="$(st open-agent-manager --wait-ms 5000)"
printf '%s\n' "$OPEN"
AM="$(printf '%s' "$OPEN" | jq -r '.structuredContent.frame.match')"

# Confirm that this is Agent Manager, not the sidebar.
st observe --frame "$AM" --path /tmp/agent-manager.png --max-chars 3000
```

If `jq` is unavailable, run `st open-agent-manager`, copy `structuredContent.frame.match`, and pass it manually. Do not use `frame.name` when it is `pending-frame`.

### Manual frame discovery and debugging

```bash
# List every frame after opening Kilo or Agent Manager.
st frames

# Observe a candidate Agent Manager inner frame.
st observe --frame "fake.html?id=<unique-prefix>" --max-chars 3000

# Inspect candidate body text without a screenshot.
st snapshot --frame "fake.html?id=<unique-prefix>" --max-chars 3000
```

Use a short unique `fake.html?id=<prefix>` match only after checking `frames`. If multiple `fake.html` frames exist, do not use plain `--frame "fake.html"`; inspect candidates and select the one where `evaluate --script 'return !!document.querySelector(".am-layout [data-sidebar-id=local]")'` returns `true`.

**Rules:**

- After any quick opener (`open-kilo`, `open-agent-manager`, `open-kilo-settings`), run `frames` or use the exact `frame.match` returned by `open-agent-manager`
- Use `--frame "kilocode.kilo-code"` for sidebar/settings UI only when it cannot be confused with Agent Manager
- Use the exact Agent Manager `fake.html?id=<uuid>` match for all Agent Manager `click`, `type`, `wait`, `observe`, `snapshot`, `evaluate`, and `profile-start` commands
- Use `snapshot` instead of `observe` for lightweight polling when you do not need a screenshot
- NEVER use `--x`/`--y` coordinates to click webview elements; iframe offsets and window layout make them unreliable

## Quick openers

```bash
open-kilo                                      # Focus Kilo sidebar
open-agent-manager                             # Open Agent Manager tab
open-kilo-settings                             # Open Kilo settings panel
```

## Debug

```bash
console [--type error|warning|log]             # Browser/webview console messages
logs [--filter TEXT]                            # VS Code log files
evaluate --script JS [--frame MATCH]           # Run JS in VS Code page
run-command --command TEXT                      # Command palette command
```

## Performance profiling

Use profiling only after the relevant webview has loaded, so initialization noise does not dominate the capture. `profile-start` records a global Chrome trace from VS Code's top-level CDP session, plus JavaScript CPU and metrics data from the selected frame's nearest attachable Chromium renderer target. For VS Code webviews this is usually the frame's enclosing webview target; the requested inner frame is retained for semantic marks.

```bash
profile-start [--frame MATCH] [--trace true|false] [--cpu true|false] [--interval MICROSECONDS]
profile-stop [--dir DIR] [--trace-path FILE] [--cpu-path FILE] [--metadata-path FILE]
profile-analyze [--dir DIR | --metadata FILE | --trace FILE] [--cpu FILE] [--path REPORT] [--limit N]
```

Artifacts created by `profile-stop --dir DIR`:

- `DIR/trace.json` - Chrome performance trace importable into DevTools or Perfetto
- `DIR/profile.cpuprofile` - JavaScript CPU profile importable into DevTools
- `DIR/metadata.json` - target frame, trace-loss status, and Chromium metric deltas

`profile-analyze` reads `metadata.json` as the artifact manifest when `--dir` is used, or accepts a custom manifest with `--metadata FILE`. It prints a compact JSON report containing capture metadata, trace-loss warnings, long tasks, dominant trace event slices, Kilo performance marks, and the top JavaScript self-time locations. Incomplete or missing declared artifacts fail analysis instead of mixing prior output. Custom `--trace-path`, `--cpu-path`, and `--metadata-path` output files must be distinct; analyze custom metadata captures with `--metadata FILE`. Add semantic marks during a scenario with `evaluate --frame MATCH --script 'performance.mark("kilo.<name>")'`; marks beginning with `kilo.` are included in the report.

---

# Follow the loop

Use a tight observe -> act -> verify loop.

1. Open the right surface with a quick opener
2. For sidebar/settings, use `frames` and a `kilocode.kilo-code` match; for Agent Manager, capture the exact `fake.html?id=<uuid>` `frame.match` returned by `open-agent-manager`
3. Run `observe --frame "$FRAME"` to capture a screenshot path and text snapshot
4. **Read the screenshot file** with your Read tool to visually see what's on screen
5. Use the text snapshot and screenshot to identify the right `--text` or `--selector` for your click
6. Run `click --text "Label" --frame "$FRAME"`; always use text/selector, never coordinates
7. Take a screenshot after the change and read it to verify
8. Use `console` or `logs` if behavior is unclear

The screenshot path is in the JSON output at `structuredContent.path`. You MUST read the PNG file to see it — just having the path is not enough.

If a click doesn't work, check:

- Did you pass `--frame`? Without it, Playwright searches the outer VS Code chrome, not the webview.
- For sidebar/settings, run `observe --frame "kilocode.kilo-code"`; for Agent Manager, use its exact returned `frame.match`.
- If multiple Kilo frames exist, try `observe --frame <name>` on each one and use structural DOM checks to identify Agent Manager.

---

# Reuse proven selectors

## Shared surfaces

- Kilo activity bar icon: `a[aria-label="Kilo Code (NEW)"]`
- Agent Manager opener: `a[aria-label*="Agent Manager"]`
- Agent Manager textarea: `textarea[placeholder*="Type a message"]`
- Send button: `[aria-label="Send"]`

## Settings

| Selector | Purpose |
|---|---|
| `[data-component="tabs"][data-variant="settings"]` | Settings root |
| `[data-slot="tabs-list"]` | Settings navigation |
| `[data-slot="tabs-trigger-wrapper"][data-value="providers"]` | Providers tab |
| `[data-slot="tabs-trigger-wrapper"][data-value="models"]` | Models tab |
| `[data-slot="tabs-trigger"][aria-selected="true"]` | Active settings tab |
| `[data-slot="settings-row"]` | Settings row |
| `.settings-save-bar` | Unsaved-changes save bar |

Prefer locale-independent `data-value` selectors for settings navigation. Other tab keys include `agentBehaviour`, `autoApprove`, `browser`, `checkpoints`, `display`, `autocomplete`, `notifications`, `context`, `indexing`, `experimental`, `language`, and `aboutKiloCode`.

## Agent Manager

| Selector | Purpose |
|---|---|
| `[data-sidebar-id="local"]` | Local workspace card |
| `[data-sidebar-id="wt-..."]` | Managed worktree card |
| `[data-sidebar-id="ses_..."]` | Unassigned session card in the sidebar |
| `[data-tab-id="ses_..."]` | Managed session transcript tab inside the selected worktree |
| `.am-worktree-item` | Any managed worktree card |
| `.am-worktree-item-active` | Selected worktree card |
| `.am-section-group-header` | Collapsible sidebar group header |
| `.am-diff-toggle-btn` | Inline diff-panel toggle |
| `.am-diff-toggle-btn.am-tab-diff-btn-active` | Inline diff panel is open |
| `.am-diff-panel-wrapper` | Inline diff side-panel wrapper |
| `.am-diff-panel` | Inline diff side-panel content |
| `.am-review-layout` | Dedicated full-screen review surface |
| `.am-terminal-layer-active` | A terminal tab is active and visually covers chat |
| `.am-main-pane-terminal-active` | Main pane is currently showing a terminal |
| `.tool-collapsible` | Tool-card shell in the chat transcript |
| `[data-component="edit-tool"]` | Inline edit-tool card |
| `[data-component="bash-output"]` | Mounted bash-output details body |
| `.task-timeline-bar` | Task timeline bar |

The local workspace ID is always the literal string `local`. Managed worktree IDs usually start with `wt-`. Discover actual IDs from the live DOM rather than guessing:

```bash
st evaluate --frame "$AM" --max-chars 30000 --script '
  return [...document.querySelectorAll("[data-sidebar-id]")].map((el) => ({
    id: el.getAttribute("data-sidebar-id"),
    text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 260),
  }))
'
```

Use selectors and discovered IDs rather than title text when replaying a performance scenario. Titles can change; `data-sidebar-id` is stable for the current Agent Manager state.

Worktree switching and transcript-tab switching are different scenarios:

- Use `[data-sidebar-id="wt-..."]` to select a managed worktree card.
- Use `[data-tab-id="ses_..."]` to switch transcript tabs inside the already selected worktree.
- Use `[data-sidebar-id="ses_..."]` only for unassigned session cards shown directly in the sidebar.

---

# VS Code dialogs and notifications

VS Code workspace-trust dialogs, onboarding, command palette, and notification toasts live in the outer workbench, not inside a Kilo webview. Omit `--frame` for these controls.

```bash
# Inspect outer workbench text and screenshot.
st observe --path /tmp/vscode-outer.png --max-chars 3000

# Examples: use visible text or inspect DOM before clicking.
st click --text "Trust" --exact
st click --selector '.notification-toast button' --nth 0
```

`open-kilo`, `open-kilo-settings`, and `open-agent-manager` automatically close the VS Code welcome overlay. For unfamiliar dialogs, observe first; do not guess coordinates.

---

# Debug deliberately

If the UI does not react as expected, do not guess.

```bash
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs console
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs logs
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs evaluate --script "document.title"
node ~/.config/kilo/scripts/vscode-self-test/cli.mjs frames
```

When behavior is flaky, take screenshots before and after each step.

---

# Exercise Kilo sidebar chat

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }
OPEN="$(st open-kilo --wait-ms 3000)"
SIDEBAR="$(printf '%s' "$OPEN" | jq -r '.structuredContent.frame.match')"

st observe --frame "$SIDEBAR" --path /tmp/kilo-sidebar.png --max-chars 3000
st type --frame "$SIDEBAR" --selector 'textarea[placeholder*="Type a message"]' --value "hello world"
st click --frame "$SIDEBAR" --selector '[aria-label="Send"]'
st wait --frame "$SIDEBAR" --text "response" --state visible --timeout-ms 30000
st observe --frame "$SIDEBAR" --path /tmp/kilo-sidebar-response.png --max-chars 5000
st console --type error
```

Use a deterministic prompt only when explicitly testing message submission. For non-mutating UI checks, stop after `observe` and inspect existing UI.

---

# Exercise Agent Manager

Proven recipe:

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }
OPEN="$(st open-agent-manager --wait-ms 5000)"
AM="$(printf '%s' "$OPEN" | jq -r '.structuredContent.frame.match')"

st observe --frame "$AM" --path /tmp/agent-manager.png --max-chars 3000
st click --frame "$AM" --selector 'textarea[placeholder*="Type a message"]'
st type --frame "$AM" --selector 'textarea[placeholder*="Type a message"]' --value "hello world"
st click --frame "$AM" --selector '[aria-label="Send"]'
st wait --frame "$AM" --text "response" --state visible
st screenshot --frame "$AM" --path /tmp/agent-manager-response.png
```

Do not send prompts during read-only profiling runs. This recipe is for explicit interactive E2E tests only.

# Agent Manager performance profiling playbook

Use this workflow when profiling Agent Manager switching, transcript rendering, inline review, full-screen review, or tool-card rendering. Do not automate the visible Webview Developer Tools UI. The CLI records the same Chromium profiling data directly through CDP and preserves the raw artifacts for later DevTools or Perfetto inspection.

## Profiling architecture

`profile-start --frame "$AM"` records two complementary sources:

| Artifact source | Scope | Purpose |
|---|---|---|
| Chrome trace | Top-level VS Code CDP page (`traceTarget: "page-global"`) | Long tasks, postMessage handling, style recalculation, layout, paint, and semantic marks across the VS Code renderer tree |
| CPU profile and Chromium metrics | Selected frame's nearest attachable renderer target | JavaScript hot paths and metric deltas for the Agent Manager webview renderer |

The requested Agent Manager `fake.html?id=<uuid>` inner frame is often not directly attachable. The profiler automatically climbs to its nearest attachable ancestor renderer. `metadata.json` records this as `target.scope: "ancestor-frame"`, which is expected for Agent Manager.

Every profile automatically includes:

- `kilo.profile.start`
- `kilo.profile.stop`

Add scenario-specific marks between them:

| Scenario | Recommended marks |
|---|---|
| Session or worktree activation | `kilo.switch.begin`, `kilo.switch.settled` |
| Inline diff panel | `kilo.diff.open`, `kilo.diff.settled` |
| Full-screen review | `kilo.review.open`, `kilo.review.settled` |
| Tool-card expansion | `kilo.tool.open`, `kilo.tool.settled` |

## Standard setup

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }
WORKSPACE="/path/to/workspace"
OUT="/tmp/kilo-agent-manager-profile"

st start
st launch-vscode --mode dev --build false --workspace "$WORKSPACE" --wait-ms 5000
OPEN="$(st open-agent-manager --wait-ms 5000)"
AM="$(printf '%s' "$OPEN" | jq -r '.structuredContent.frame.match')"
st observe --frame "$AM" --path /tmp/agent-manager.png --max-chars 3000
```

Build first with `bun run compile` from `packages/kilo-vscode/` if source changed. Use `--build false` only when the current `dist/` bundle is already correct.

## Discover stable worktree/session IDs

Do not guess selectors or use card title text for replay. Query the live Agent Manager DOM:

```bash
st evaluate --frame "$AM" --max-chars 30000 --script '
  return [...document.querySelectorAll("[data-sidebar-id]")].map((el) => ({
    id: el.getAttribute("data-sidebar-id"),
    text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 260),
  }))
'
```

If historical sidebar groups are collapsed, expand them in the current test state:

```bash
st evaluate --frame "$AM" --script '
  for (const el of document.querySelectorAll(".am-section-group-header")) {
    if (el.querySelector(".am-section-group-chevron-collapsed")) el.click()
  }
  return true
'
```

Use a light source ID and one or more heavy target IDs. Always replay the same source-target pair for before/after comparisons.

## Warm-up before measuring

Separate cold and warm scenarios:

- **Cold activation** includes extension/webview initialization, first message hydration, initial `postMessage` handling, and first DOM creation.
- **Warm activation** measures repeated session switching after the panel and target session have loaded once. This is usually the best regression benchmark for user-visible switching.

Warm-up sequence:

```bash
SOURCE='wt-<light-source-id>'
TARGET='wt-<heavy-target-id>'

st click --frame "$AM" --selector "[data-sidebar-id=\"$TARGET\"]" --wait-ms 1000
sleep 2
st click --frame "$AM" --selector "[data-sidebar-id=\"$SOURCE\"]" --wait-ms 1000
sleep 2
```

Discard warm-up output. Start profiling only after the target was visited once.

## Capture transcript-only session switching

Keep inline diff closed unless diff opening is explicitly part of the scenario:

```bash
SOURCE='wt-<light-source-id>'
TARGET='wt-<heavy-target-id>'
OUT="$(mktemp -d "${TMPDIR%/}/kilo-switch-heavy-warm.XXXXXX")"

# Require the visible chat transcript surface and close inline diff if it is open.
st evaluate --frame "$AM" --script '
  if (document.querySelector(".am-review-layout")) throw new Error("Full-screen review is active; return to a transcript tab before profiling")
  if (document.querySelector(".am-terminal-layer-active")) throw new Error("Terminal tab is active; return to a transcript tab before profiling")
  if (!document.querySelector(".message-list")) throw new Error("Transcript pane not found")
  const btn = document.querySelector(".am-diff-toggle-btn.am-tab-diff-btn-active")
  if (btn) btn.click()
  return true
'

st click --frame "$AM" --selector "[data-sidebar-id=\"$SOURCE\"]" --wait-ms 1000
sleep 2
st evaluate --frame "$AM" --script "
  if (document.querySelector('.am-review-layout')) throw new Error('Full-screen review restored for source; return to a transcript tab')
  if (document.querySelector('.am-terminal-layer-active')) throw new Error('Terminal restored for source; return to a transcript tab')
  if (!document.querySelector('[data-sidebar-id=\"$SOURCE\"].am-worktree-item-active')) throw new Error('Expected source worktree is not active')
  const btn = document.querySelector('.am-diff-toggle-btn.am-tab-diff-btn-active')
  if (btn) btn.click()
  return true
"
st profile-start --frame "$AM" --interval 100
st evaluate --frame "$AM" --script "
  performance.clearMarks()
  performance.mark('kilo.switch.begin')
  const target = document.querySelector('[data-sidebar-id=\"$TARGET\"]')
  if (!target) throw new Error('Target worktree card not found')
  target.click()
  return performance.now()
"
sleep 3
st evaluate --frame "$AM" --script "
  if (document.querySelector('.am-review-layout')) throw new Error('Full-screen review restored for target; transcript-only capture is invalid')
  if (document.querySelector('.am-terminal-layer-active')) throw new Error('Terminal restored for target; transcript-only capture is invalid')
  if (document.querySelector('.am-diff-panel-wrapper')) throw new Error('Inline diff panel opened during transcript-only capture')
  if (!document.querySelector('[data-sidebar-id=\"$TARGET\"].am-worktree-item-active')) throw new Error('Expected target worktree is not active')
  performance.mark('kilo.switch.settled')
  return performance.now()
"
st profile-stop --dir "$OUT"
st profile-analyze --dir "$OUT" --path "$OUT/report.json" --limit 20
```

Use shell `sleep` between CLI calls for deterministic waits. Do not return a Promise from `evaluate`: scripts execute in a synchronous function wrapper, so asynchronous return values are not awaited.

## Capture inline diff opening separately

Do not mix transcript activation and inline diff rendering unless you add distinct marks and intentionally analyze both segments.

```bash
OUT="$(mktemp -d "${TMPDIR%/}/kilo-inline-diff-heavy.XXXXXX")"

st evaluate --frame "$AM" --script '
  const btn = document.querySelector(".am-diff-toggle-btn.am-tab-diff-btn-active")
  if (btn) btn.click()
  return true
'
st click --frame "$AM" --selector "[data-sidebar-id=\"$TARGET\"]" --wait-ms 1000
sleep 2
st evaluate --frame "$AM" --script "
  if (document.querySelector('.am-review-layout')) throw new Error('Full-screen review restored for target; inline-diff capture is invalid')
  if (document.querySelector('.am-terminal-layer-active')) throw new Error('Terminal restored for target; return to a transcript tab')
  if (!document.querySelector('[data-sidebar-id=\"$TARGET\"].am-worktree-item-active')) throw new Error('Expected target worktree is not active')
  return true
"
st profile-start --frame "$AM" --interval 100
st evaluate --frame "$AM" --script '
  performance.clearMarks()
  performance.mark("kilo.diff.open")
  const btn = document.querySelector(".am-diff-toggle-btn:not(.am-tab-diff-btn-active)")
  if (!btn) throw new Error("Closed inline diff toggle not found")
  btn.click()
  return performance.now()
'
sleep 4
st evaluate --frame "$AM" --script '
  performance.mark("kilo.diff.settled")
  const open = document.querySelectorAll(".am-diff-panel-wrapper").length
  if (open !== 1) throw new Error(`Expected one inline diff panel, found ${open}`)
  return {
    open,
    elements: document.querySelectorAll("*").length,
  }
'
st profile-stop --dir "$OUT"
st profile-analyze --dir "$OUT" --path "$OUT/report.json" --limit 20
```

Inline diff state selectors:

- Closed: `.am-diff-toggle-btn:not(.am-tab-diff-btn-active)`
- Open toggle: `.am-diff-toggle-btn.am-tab-diff-btn-active`
- Open panel wrapper: `.am-diff-panel-wrapper`
- Open panel body: `.am-diff-panel`

## Inventory settled transcript DOM

CPU traces explain where time is spent. DOM inventory explains why. Run this after selecting a target session:

```bash
st evaluate --frame "$AM" --max-chars 12000 --script '
  return {
    elements: document.querySelectorAll("*").length,
    wrappers: document.querySelectorAll("[data-component=tool-part-wrapper]").length,
    collapsibles: document.querySelectorAll(".tool-collapsible").length,
    bashBodies: document.querySelectorAll("[data-component=bash-output]").length,
    collapsedBashBodies: [...document.querySelectorAll("[data-component=bash-output]")].filter((body) =>
      body.closest(".tool-collapsible")?.querySelector("[data-slot=collapsible-trigger]")?.getAttribute("aria-expanded") === "false"
    ).length,
    openTools: document.querySelectorAll("[data-slot=collapsible-trigger][aria-expanded=true]").length,
    closedTools: document.querySelectorAll("[data-slot=collapsible-trigger][aria-expanded=false]").length,
    editTools: document.querySelectorAll("[data-component=edit-tool]").length,
    writeTools: document.querySelectorAll("[data-component=write-tool]").length,
    patchTools: document.querySelectorAll("[data-component=apply-patch-tool]").length,
    timelineBars: document.querySelectorAll(".task-timeline-bar").length,
    inlineEditBodies: document.querySelectorAll("[data-component=edit-content]").length,
  }
'
```

Interpret transient `capture.metricsDelta.Nodes` separately from settled `elements`:

- High `Nodes` with modest settled `elements` means mount-then-discard work.
- High settled `elements` means retained DOM remains expensive after the interaction.
- High `.task-timeline-bar` counts point to timeline overhead.
- High `collapsedBashBodies` counts point to retained hidden bash-output DOM.
- Pierre/Shiki hot paths such as `applyHunksToDOM` or `findNextMatchSync` point to inline diff rendering.

## Metadata-guarded profiling of a real checkout

Opening Agent Manager can normalize its ignored `.kilo/agent-manager.json`. Initialization can also touch `.git/info/exclude` and legacy `.git/worktrees/*/gitdir` refs. When the main checkout metadata must remain byte-identical, launch against a disposable shadow workspace and compare an automatic before/after snapshot.

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }
REAL="${KILO_REPO_PATH:-$HOME/Documents/git/kilocode}"
TMP="${TMPDIR%/}/kilo"
mkdir -p "$TMP"
SHADOW="$(mktemp -d "$TMP/kilocode-main-profile-shadow.XXXXXX")"
BEFORE="$(mktemp "$TMP/kilocode-real-state.before.XXXXXX")"
AFTER="$(mktemp "$TMP/kilocode-real-state.after.XXXXXX")"

snapshot_real() {
  shasum -a 256 "$REAL/.kilo/agent-manager.json" "$REAL/.git/info/exclude"
  if test -d "$REAL/.git/worktrees"; then
    for file in "$REAL"/.git/worktrees/*/gitdir; do
      test -f "$file" && shasum -a 256 "$file"
    done
  fi
  git -C "$REAL" status --short --branch
  git -C "$REAL" worktree list --porcelain
  while IFS= read -r dir; do
    test -n "$dir" || continue
    printf '### worktree %s\n' "$dir"
    git -C "$dir" status --porcelain=v1 --untracked-files=all
  done <<EOF
$(git -C "$REAL" worktree list --porcelain | awk '/^worktree / { sub(/^worktree /, ""); print }')
EOF
}

# Snapshot real metadata and worktree status before launch.
snapshot_real > "$BEFORE"

# Copy metadata instead of symlinking it. Agent Manager initialization may call
# ensureGitExclude() and legacy worktree-ref migration; these writes stay in temp.
mkdir "$SHADOW/.kilo"
cp -R "$REAL/.git" "$SHADOW/.git"
cp "$REAL/.kilo/agent-manager.json" "$SHADOW/.kilo/agent-manager.json"

# Disable GitHub auth noise for the isolated daemon, then launch against shadow state.
st stop || true
GH_TOKEN=invalid GITHUB_TOKEN=invalid st start
st launch-vscode --mode dev --build false --workspace "$SHADOW" --wait-ms 6000
OPEN="$(st open-agent-manager --wait-ms 6000)"
AM="$(printf '%s' "$OPEN" | jq -r '.structuredContent.frame.match')"
```

Important protection boundary:

- The shadow copy protects main-checkout Agent Manager metadata and Git metadata from initialization writes.
- The shadow recipe is for profiling existing managed worktree cards. The copied Agent Manager state still references their real absolute directories, so this is not a sandbox for managed worktree content.
- The shadow `local` card is not a faithful rendering of the real checkout because the shadow directory does not contain source files.
- Copy `.git`; do not symlink it when byte-identical main-checkout metadata is required. Agent Manager initialization can update `info/exclude`, and legacy migration can rewrite `.git/worktrees/*/gitdir` refs.
- During a metadata-guarded run, only select existing cards, inspect DOM, and record profiles. Do not send prompts, edit files, create worktrees, apply changes, run commands, or open mutating actions.
- For a fully sandboxed benchmark where worktree contents may be exercised freely, use a disposable fixture repository instead of a real checkout.

Cleanup and automatic verification:

```bash
st stop-vscode --cleanup true
st stop
case "$SHADOW" in
  "$TMP"/kilocode-main-profile-shadow.*) rm -rf -- "$SHADOW" ;;
  *) printf 'Refusing to remove unexpected shadow path: %s\n' "$SHADOW" >&2; exit 1 ;;
esac
snapshot_real > "$AFTER"
if ! cmp -s "$BEFORE" "$AFTER"; then
  diff -u "$BEFORE" "$AFTER" || true
  printf 'Real checkout changed during profiling; investigate before continuing.\n' >&2
  exit 1
fi
rm -f -- "$BEFORE" "$AFTER"
```

## Analyze artifacts

Each `profile-stop --dir "$OUT"` creates:

```text
trace.json
profile.cpuprofile
metadata.json
```

Each `profile-analyze --dir "$OUT" --path "$OUT/report.json"` adds:

```text
report.json
```

Use the report for first-pass analysis, then open raw artifacts manually only if deeper flame-chart inspection is useful.

| Signal | Meaning |
|---|---|
| `trace.longestTasks` | Main-thread blocks above 50 ms |
| `trace.selectedGroupTotals` | Aggregate layout, paint, parse, and script slices |
| `capture.metricsDelta.ScriptDuration` | Chromium script-time delta, in seconds |
| `capture.metricsDelta.RecalcStyleDuration` | Style recalculation delta, in seconds |
| `capture.metricsDelta.LayoutDuration` | Layout delta, in seconds |
| `capture.metricsDelta.Nodes` | Transient node-creation delta |
| `capture.metricsDelta.LayoutObjects` | Layout-object delta |
| `capture.metricsDelta.JSEventListeners` | Event-listener delta |
| `cpu.topBusySelfTime` | JavaScript self-time hot paths in the selected renderer |
| `capture.traceDataLoss` | If true, shorten the capture and run it again |

Keep raw artifacts and record the exact scenario, source ID, target ID, waits, panel state, and DOM inventory alongside before/after numbers.

## Common mistakes

| Mistake | Correct approach |
|---|---|
| Using `--frame "kilocode.kilo-code"` for Agent Manager | Use the exact returned `fake.html?id=<uuid>` Agent Manager frame |
| Using plain `--frame "fake.html"` with multiple Kilo frames | Run `frames`, then choose a unique `fake.html?id=<prefix>` match |
| Using returned `frame.name` when it is `pending-frame` | Use returned `frame.match`, which contains the unique `fake.html?id=<uuid>` fragment |
| Guessing card selectors from visible text | Query `[data-sidebar-id]`, then replay exact IDs |
| Using pixel coordinates | Use `--selector` or `--text`; iframe offsets make coordinates fragile |
| Returning a Promise from `evaluate` | Use shell `sleep` between CLI calls, or start background work in `window` and query it later |
| Profiling extension startup when investigating warm switching | Warm the target once, switch back to the same light source, then record |
| Mixing switch and diff-open costs | Keep inline diff closed for transcript profiles or add separate marks |
| Checking only for `.message-list` before transcript profiling | Also reject `.am-review-layout` and `.am-terminal-layer-active`; terminal DOM overlays chat without unmounting it |
| Using optional chaining for required scenario clicks | Throw when the target is missing and verify `.am-worktree-item-active[data-sidebar-id="..."]` after selection |
| Treating `Nodes` as settled DOM size | Query `document.querySelectorAll("*").length` after settling |
| Running against a real checkout without guarding metadata | Use the metadata-guarded shadow recipe with copied `.git` and automatic before/after comparison; use a disposable fixture for fully sandboxed worktree-content testing |
| Calling `stop` only | Call `stop-vscode --cleanup true` first, then `stop` |
| Using `--interval 100` as milliseconds | The interval is microseconds; `100` means `0.1 ms` |
| Analyzing an incomplete manifest | Re-capture; `profile-analyze` intentionally rejects `incomplete: true` |

## Cleanup and stale daemon recovery

Always close VS Code before stopping the daemon:

```bash
st stop-vscode --cleanup true
st stop
```

`stop-vscode --cleanup true` removes the isolated VS Code user-data, extension, and VSIX temp directories created by the harness. `stop` terminates the per-worktree daemon. If a daemon crash leaves stale state, inspect `~/.config/kilo/state/vscode-self-test/<repo-hash>/state.json`, stop any surviving harness process, then remove only that stale harness state file before restarting.

## Before/after optimization loop

1. Build the extension if needed.
2. Launch the same workspace and identify the exact Agent Manager frame.
3. Discover stable source and target IDs.
4. Warm the target once for warm-switch benchmarking.
5. Capture a short baseline with semantic marks.
6. Save raw artifacts and settled DOM inventory.
7. Make one minimal behavior-preserving optimization.
8. Rebuild the extension.
9. Replay the identical source, target, waits, and panel state.
10. Compare longest task, script duration, style recalculation, layout, transient nodes, settled DOM, and CPU hot paths.
11. Verify user-visible behavior manually, including explicit expansion or fast scrolling when relevant.

Do not claim an improvement from code inspection alone. Re-profile the exact scenario.

# Exercise Kilo settings

```bash
st() { node ~/.config/kilo/scripts/vscode-self-test/cli.mjs "$@"; }
OPEN="$(st open-kilo-settings --wait-ms 4000)"
SETTINGS="$(printf '%s' "$OPEN" | jq -r '.structuredContent.frame.match')"

st observe --frame "$SETTINGS" --path /tmp/kilo-settings.png --max-chars 4000
st click --frame "$SETTINGS" --selector '[data-slot="tabs-trigger-wrapper"][data-value="providers"]'
st wait --frame "$SETTINGS" --selector '[data-slot="tabs-trigger"][data-value="providers"][aria-selected="true"]' --state visible
st observe --frame "$SETTINGS" --path /tmp/kilo-settings-providers.png --max-chars 4000
st console --type error
```

For settings that persist, change the control, verify `.settings-save-bar` or the saved state as appropriate, restart isolated VS Code, reopen settings, and verify the value again. Never enter real API keys or credentials in automated tests.

---

# Keep scope practical

Open the surface, interact like a user, collect screenshot evidence, and use logs only when the UI stops being self-explanatory.
