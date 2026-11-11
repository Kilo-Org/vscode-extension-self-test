#!/usr/bin/env node
import { _electron as electron } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { cleanup as remove, environment, inherited, root, scriptDir, settings, stateDir, temporary } from "./common.mjs";
import { cfg } from "./config.mjs";

const execFileP = promisify(execFile);
const pkg = JSON.parse(readFileSync(join(scriptDir, "package.json"), "utf8"));

const state = {
  console: [],
  profile: null,
  session: null,
};

const categories = [
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "loading",
  "toplevel",
  "v8",
].join(",");

function record(entry) {
  state.console = [...state.console.slice(-199), entry];
}

function textResult(text, structuredContent) {
  if (!structuredContent) {
    return {
      content: [{ type: "text", text }],
    };
  }

  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function imageResult(text, path, structuredContent) {
  const data = Buffer.from(readFileSync(path)).toString("base64");

  return {
    content: [
      { type: "text", text },
      { type: "image", data, mimeType: "image/png" },
    ],
    structuredContent: { path, ...(structuredContent ?? {}) },
  };
}

function fail(message) {
  throw new Error(message);
}

function clip(value, size) {
  if (value.length <= size) {
    return value;
  }

  return `${value.slice(0, size)}\n...<truncated ${value.length - size} chars>`;
}

function temp(prefix) {
  return temporary(prefix);
}

function activeSession() {
  return (
    state.session ??
    fail("No VS Code session is running. Call launch-vscode first.")
  );
}

function resolveOnPath(name) {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];

  const hit = paths
    .flatMap((dir) =>
      exts.map((ext) => join(dir, name.endsWith(ext) ? name : `${name}${ext}`)),
    )
    .find((item) => existsSync(item));

  return hit ?? null;
}

async function run(command, args, cwd, env = process.env) {
  await execFileP(command, args, {
    cwd,
    env,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
}

function detectAppPath(appPath) {
  const envPath = appPath ?? process.env["VSCODE_EXEC_PATH"] ?? cfg.vscodeExecutable;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  const local = process.env["LOCALAPPDATA"] ?? "";
  const program = process.env["PROGRAMFILES"] ?? "C:\\Program Files";
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
          "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
          "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code - Insiders",
          "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron",
        ]
      : process.platform === "linux"
        ? [
            "/usr/share/code/code",
            "/usr/bin/code",
            "/snap/code/current/usr/share/code/code",
            "/var/lib/flatpak/exports/bin/com.visualstudio.code",
            "/usr/share/code-insiders/code-insiders",
            "/usr/bin/code-insiders",
          ]
        : process.platform === "win32"
          ? [
              join(local, "Programs", "Microsoft VS Code", "Code.exe"),
              join(program, "Microsoft VS Code", "Code.exe"),
              join(local, "Programs", "Microsoft VS Code Insiders", "Code - Insiders.exe"),
              join(program, "Microsoft VS Code Insiders", "Code - Insiders.exe"),
            ]
          : [];
  const found = candidates.find((item) => existsSync(item)) ??
    (process.platform === "darwin" ? null : resolveOnPath("code") ?? resolveOnPath("code-insiders"));
  if (found) {
    return found;
  }

  return fail("VS Code executable not found. Set VSCODE_EXEC_PATH or pass --app-path explicitly.");
}

function detectCliPath(appPath) {
  const configured = process.env["VSCODE_CLI_PATH"] ?? cfg.vscodeCli;
  if (configured && existsSync(configured)) return configured;
  const preferred = appPath.toLowerCase().includes("insiders") ? "code-insiders" : "code";
  const direct = resolveOnPath(preferred);
  if (direct) {
    return direct;
  }

  if (process.platform === "darwin") {
    const bundled = appPath.includes("Visual Studio Code - Insiders.app")
      ? "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"
      : "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    if (existsSync(bundled)) {
      return bundled;
    }
  }

  return fail("VS Code CLI not found. Set VSCODE_CLI_PATH, install the `code` shell command, or use --mode dev.");
}

function writeSettings(userDir) {
  const value = {
    "editor.accessibilitySupport": "off",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "extensions.ignoreRecommendations": true,
    "security.workspace.trust.enabled": false,
    "task.allowAutomaticTasks": "off",
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "window.commandCenter": false,
  };
  settings(userDir, { ...value, ...cfg.settings });
}

async function buildExtension() {
  const [command, ...args] = cfg.build;
  await run(command, args, root);
}

function newest(paths) {
  return [...paths].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

async function packageVsix(outDir) {
  const [command, ...args] = cfg.vsix.map((item) => item.replaceAll("{outDir}", outDir));
  await run(command, args, root);
  const files = newest(
    readdirSync(outDir)
      .filter((item) => item.endsWith(".vsix"))
      .map((item) => join(outDir, item)),
  );
  const vsix = files.at(0);
  if (!vsix) {
    return fail(`No VSIX package was created in ${outDir}`);
  }
  return vsix;
}

async function installVsix(cliPath, userDir, extDir, vsix, env) {
  await run(
    cliPath,
    [
      "--extensions-dir",
      extDir,
      "--user-data-dir",
      userDir,
      "--install-extension",
      vsix,
      "--force",
    ],
    root,
    env,
  );
}

async function closeSession(cleanup) {
  const active = state.session;
  if (!active) {
    return { failed: [], removed: [] };
  }

  await discardProfile();
  try {
    await active.app.close();
  } catch (error) {
    // The app may already be gone after an external close or kill. Cleanup
    // below still removes what it can, so a stale session never blocks launch.
    console.error("VS Code close failed:", error);
  }
  state.session = null;
  state.console = [];

  const result = cleanup
    ? remove([active.keepUserDir ? null : active.userDir, active.extDir, active.outDir])
    : { failed: [], removed: [] };
  if (result.failed.length) {
    console.error("Cleanup left directories:", result.failed.join(", "));
  }

  return {
    extDir: active.extDir,
    mode: active.mode,
    removed: result.removed,
    ...(result.failed.length ? { remaining: result.failed } : {}),
    userDir: active.userDir,
    vsix: active.vsix,
    workspace: active.workspace,
  };
}

// A launch-time model selection: `--model provider/model` (both ids may contain
// `/`), `--provider` for a bare model id, and `--variant` for the reasoning
// effort. It is written to the isolated v2 config, so the first draft starts on
// it without anyone opening the pickers.
function modelSelection(input) {
  const requested = input.model?.trim();
  if (!requested) {
    if (input.provider?.trim()) fail("--provider needs --model.");
    if (input.variant?.trim()) fail("--variant needs --model.");
    return null;
  }
  if (requested.includes("#")) {
    fail(`--model takes provider/model; pass the reasoning effort with --variant: ${JSON.stringify(requested)}.`);
  }
  const explicit = input.provider?.trim();
  const slash = requested.indexOf("/");
  if (!explicit && slash <= 0) {
    fail(`--model must be provider/model, or pair --provider with a bare model: ${JSON.stringify(requested)}.`);
  }
  const variant = input.variant?.trim();
  return {
    providerID: explicit || requested.slice(0, slash),
    model: explicit ? requested : requested.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

// Seed the isolated v2 global config with the selection. v2 reads `kilo2.json`
// and `kilo2.jsonc` (the `.jsonc` wins), not v1's `kilo.json`. A reused
// --user-dir can already hold a document, so merge into it instead of replacing it.
function seedModelSelection(dir, selection) {
  const jsonc = join(dir, "kilo2.jsonc");
  const path = existsSync(jsonc) ? jsonc : join(dir, "kilo2.json");
  const document = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  writeFileSync(path, JSON.stringify({ ...document, model: selection }, null, 2) + "\n");
  return path;
}

// Reads the labels of the composer that accepts a prompt. Agent Manager shows an
// intro composer before a session is selected, so its labels are read only from
// a visible transcript wrapper.
function composerLabels() {
  const visible = (element) =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const chat = [...document.querySelectorAll(".am-chat-wrapper:not(.am-chat-wrapper-hidden)")].filter(visible);
  const root = document.querySelector(".am-layout") ? chat[0] : document;
  if (!root) {
    return { agent: null, model: null, ready: false, variant: null };
  }
  const label = (selector) =>
    [...root.querySelectorAll(selector)]
      .filter(visible)
      .map((element) => (element.textContent ?? "").trim())
      .find(Boolean) ?? null;
  return {
    agent: label(".mode-switcher-trigger-label"),
    model: label(".model-selector-trigger-label"),
    ready: [...root.querySelectorAll("textarea.prompt-input")].some(visible),
    variant: label(".thinking-selector-trigger-label"),
  };
}

const triggers = 'button[data-slot="popover-trigger"]:has(.model-selector-trigger-label):visible';
const effortTrigger = 'button[data-slot="popover-trigger"]:has(.thinking-selector-trigger-label):visible';

// The part of a surface that holds a composer. A surface can open before its
// composer mounts (Agent Manager shows its intro first), so wait for a scope that
// has the model trigger. Agent Manager keeps one wrapper per visible transcript;
// the sidebar keeps its selectors in the prompt container.
async function composerScope(frame, timeoutMs = 8000) {
  const started = Date.now();
  const scope = async () => {
    const chat = frame.locator(".am-chat-wrapper:not(.am-chat-wrapper-hidden)");
    return (await chat.count().catch(() => 0))
      ? chat.first()
      : frame.locator(".prompt-input-container:visible").first();
  };
  for (;;) {
    const current = await scope();
    if (await current.locator(triggers).count().catch(() => 0)) return current;
    if (Date.now() - started >= timeoutMs) return current;
    await frame.page().waitForTimeout(250);
  }
}

function modelKey(selection) {
  return `model:${selection.providerID}/${selection.model}`;
}

// Pickers are portals that open on the trigger and close on Escape. A row click
// can leave the expanded picker open on its preview, so close by state and let the
// closing animation finish instead of assuming where focus is.
async function closePopover() {
  const page = activeSession().page;
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = page.locator(".model-selector-popover:visible, .thinking-selector-list:visible");
    if (!(await open.count().catch(() => 0))) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    await open.first().waitFor({ state: "hidden", timeout: 1000 }).catch(() => undefined);
  }
}

// Opens a composer picker and reports whether it opened. The trigger toggles, so a
// picker still closing from a previous step would eat the click: retry once.
async function openPicker(trigger, ready) {
  for (let attempt = 0; attempt < 2; attempt++) {
    await closePopover();
    const clicked = await trigger.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (clicked && (await ready())) return true;
  }
  return false;
}

// The row of a model in the open picker. The filtered list renders asynchronously
// and is virtualized, so wait for the row instead of counting right after a fill.
async function modelRow(frame, selection) {
  const row = frame.locator(`.model-selector-item[role="treeitem"][data-key="${modelKey(selection)}"]`).first();
  const present = await row
    .waitFor({ state: "attached", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  return present ? row : null;
}

async function filterModels(frame, selection) {
  return frame
    .locator(".model-selector-search")
    .fill(`${selection.providerID}/${selection.model}`, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
}

// What the model picker says about the requested model: "true" when its row is
// selected, "false" when another model is, "absent" when the catalog has no such
// row, or null when the picker does not open.
async function modelRowState(frame, selection) {
  const root = await composerScope(frame);
  const trigger = root.locator(triggers).first();
  if (!(await trigger.count())) return null;
  const search = frame.locator(".model-selector-search");
  const opened = await openPicker(trigger, () =>
    search.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false),
  );
  if (!opened) return null;
  await filterModels(frame, selection);
  const row = await modelRow(frame, selection);
  const state = row ? await row.getAttribute("aria-selected") : "absent";
  await closePopover();
  return state;
}

const efforts = 'thinking-selector-item[role="option"]';

// The displayed effort names are the ids with their first letter capitalized.
async function effortIndex(frame, variant) {
  const items = frame.locator(`.${efforts}`);
  const names = await items.evaluateAll((nodes) =>
    nodes.map((node) => (node.querySelector(".thinking-selector-item-name")?.textContent ?? "").trim().toLowerCase()),
  );
  return names.indexOf(variant.toLowerCase());
}

// What the effort picker says about the requested effort: "true", "false",
// "absent" when the model has no such effort, or null when it does not open.
async function variantRowState(frame, variant) {
  const root = await composerScope(frame);
  const trigger = root.locator(effortTrigger).first();
  if (!(await trigger.count())) return "absent";
  const items = frame.locator(`.${efforts}`);
  const opened = await openPicker(trigger, () =>
    items.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false),
  );
  if (!opened) return null;
  const index = await effortIndex(frame, variant);
  const state = index < 0 ? "absent" : (await items.nth(index).getAttribute("aria-selected")) === "true" ? "true" : "false";
  await closePopover();
  return state;
}

// Commits the model through the picker. The config seed only reaches new drafts,
// so this is what gives a composer that is already on another model (a restored
// session, or a failed seed) the requested one, and it proves the outcome instead
// of reading a label.
async function applyModel(frame, selection) {
  const state = await modelRowState(frame, selection);
  if (state === "true") return "already";
  if (state === "absent") return "missing";
  if (state === null) return "not-opened";
  const root = await composerScope(frame);
  const trigger = root.locator(triggers).first();
  const search = frame.locator(".model-selector-search");
  const opened = await openPicker(trigger, () =>
    search.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false),
  );
  if (!opened || !(await filterModels(frame, selection))) return "unconfirmed";
  const row = await modelRow(frame, selection);
  if (!row) {
    await closePopover();
    return "missing";
  }
  await row.click({ timeout: 3000 }).catch(() => undefined);
  // The expanded picker previews a row; its Select button commits. The collapsed
  // picker commits on the row and shows no button.
  const commit = frame.locator(".model-selector-popover .model-selector-item-select-btn").first();
  const expanded = await commit
    .waitFor({ state: "visible", timeout: 1500 })
    .then(() => true)
    .catch(() => false);
  if (expanded) await commit.click({ timeout: 2000 }).catch(() => undefined);
  await closePopover();
  return (await modelRowState(frame, selection)) === "true" ? "applied" : "unconfirmed";
}

async function applyVariant(frame, variant) {
  const state = await variantRowState(frame, variant);
  if (state === "true") return "already";
  if (state === "absent") return "missing";
  if (state === null) return "not-opened";
  const root = await composerScope(frame);
  const trigger = root.locator(effortTrigger).first();
  const items = frame.locator(`.${efforts}`);
  const opened = await openPicker(trigger, () =>
    items.first().waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false),
  );
  if (!opened) return "unconfirmed";
  const index = await effortIndex(frame, variant);
  if (index >= 0) await items.nth(index).click({ timeout: 3000 }).catch(() => undefined);
  await closePopover();
  return (await variantRowState(frame, variant)) === "true" ? "applied" : "unconfirmed";
}

// The outcome sentence the launch reports when the composer did not end on the
// requested selection.
function selectionNote(requested, applied, shown) {
  const label = shown?.model ? `the composer shows ${shown.model}` : "the composer is not showing a model";
  const model = `${requested.providerID}/${requested.model}`;
  if (applied?.model === "missing") return `Requested model ${model} is not in the catalog; ${label}.`;
  if (applied?.model === "not-opened") return `Could not open the model picker to confirm ${model}; ${label}.`;
  if (applied?.model === "unconfirmed") return `Could not confirm model ${model}; ${label}.`;
  if (applied?.variant === "missing") return `Model ${model} has no ${requested.variant} effort; ${label} with ${shown?.variant ?? "its effort"}.`;
  if (applied?.variant === "not-opened") return `Could not open the effort picker; ${label}.`;
  if (applied?.variant === "unconfirmed") return `Could not confirm effort ${requested.variant}; ${label}.`;
  return null;
}

// The frame a selection applies to: an explicit match, the surface the launch
// opened, or the sidebar.
async function selectionFrame(input) {
  if (input.frame) return view(input.frame);
  const opened = activeSession().surface?.frame?.match;
  return opened ? view(opened) : kiloFrame("sidebar", 3000);
}

// Applies the launch selection in an opened composer and reads the labels it
// ends on.
async function applySelection(frame, selection) {
  const applied = selection
    ? {
        model: await applyModel(frame, selection).catch(() => "unconfirmed"),
        variant: selection.variant ? await applyVariant(frame, selection.variant).catch(() => "unconfirmed") : null,
      }
    : null;
  const shown = await frame.evaluate(composerLabels).catch(() => null);
  return { applied, shown };
}

// The surface a launch ends on, so a test starts where it acts instead of
// driving the activity bar, editors, and terminal itself. The launch tool's
// `surface` enum is the only validation; callers open only a real surface.
async function openLaunchSurface(input, selection) {
  const surface = input.surface;
  const waitMs = input.waitMs ?? 3000;
  if (surface === "terminal") {
    await runCommand("Terminal: Create New Terminal", waitMs);
    if (input.terminalCommand) {
      await activeSession().page.keyboard.type(input.terminalCommand);
      await activeSession().page.keyboard.press("Enter");
      await activeSession().page.waitForTimeout(waitMs);
    }
    return { surface };
  }
  if (surface === "settings") {
    return { frame: (await openKiloSettings(waitMs)).frame, surface };
  }
  if (surface === "agent-manager") {
    await openAgentManager(waitMs);
    const frame = await kiloFrame("agentManager", waitMs);
    return { frame: frameInfo(frame), ...(await applySelection(frame, selection)), surface };
  }
  await openKiloSidebar(waitMs);
  const frame = await kiloFrame("sidebar", waitMs);
  return { frame: frameInfo(frame), ...(await applySelection(frame, selection)), surface };
}

async function launchVsCode(input) {
  const selection = modelSelection(input);
  await closeSession(true);

  const mode = input.mode ?? "vsix";
  const appPath = detectAppPath(input.appPath);
  const cliPath = mode === "vsix" ? detectCliPath(appPath) : null;
  const workspace = resolve(input.workspace ?? cfg.workspace);
  const paths = [];
  let app;
  try {
    const userDir = input.userDir ? resolve(input.userDir) : temp("vscode-self-test-user-");
    const keepUserDir = Boolean(input.userDir);
    if (!keepUserDir) paths.push(userDir);
    const extDir = temp("vscode-self-test-ext-");
    paths.push(extDir);
    const outDir = mode === "vsix" ? temp("vscode-self-test-vsix-") : null;
    if (outDir) paths.push(outDir);
    const headless = input.headless ?? false;
    const waitMs = input.waitMs ?? 5000;
    const backend = keepUserDir
      ? join(userDir, "vscode-self-test", basename(dirname(stateDir)), basename(stateDir))
      : join(userDir, "backend");
    const env = environment(backend);
    // Seed before launch: the extension host and its server read this directory
    // when the first draft resolves its model.
    const configFile = selection ? seedModelSelection(env.KILO2_CONFIG_DIR, selection) : null;

    writeSettings(userDir);

    if (input.build ?? true) {
      await buildExtension();
    }

    const vsix = mode === "vsix" && outDir ? await packageVsix(outDir) : null;

    if (vsix) {
      await installVsix(cliPath, userDir, extDir, vsix, env);
    }

    const args = [
      workspace,
      `--extensions-dir=${extDir}`,
      `--user-data-dir=${userDir}`,
      // Disposable tests must not initialize the host's native secret storage.
      "--use-inmemory-secretstorage",
      "--skip-release-notes",
    ];
    if (process.platform === "darwin") args.push("--use-mock-keychain");
    if (mode === "dev") {
      args.push(`--extensionDevelopmentPath=${root}`);
      if (cfg.extensionId) {
        args.push(`--disable-extension=${cfg.extensionId}`);
      }
    }

    app = await electron.launch({
      args,
      env,
      executablePath: appPath,
    });
    state.session = { app, userDir, keepUserDir, extDir, outDir, mode, workspace };
    if (headless) {
      await hide(app);
    }

    const page = await app.firstWindow();
    state.console = [];
    page.on("console", (message) => {
      const location = message.location();
      record({
        source: location.url || page.url(),
        text: message.text(),
        time: new Date().toISOString(),
        type: message.type(),
      });
    });
    page.on("pageerror", (error) => {
      record({
        source: page.url(),
        text: error.stack || error.message,
        time: new Date().toISOString(),
        type: "pageerror",
      });
    });
    await page.waitForTimeout(waitMs);

    const active = {
      app,
      appPath,
      backend,
      cliPath,
      configFile,
      extDir,
      headless,
      keepUserDir,
      mode,
      outDir,
      page,
      userDir,
      vsix,
      workspace,
    };

    state.session = active;
    if (selection) active.selection = { applied: null, configFile, requested: selection, shown: null };
    if (input.surface && input.surface !== "none") {
      const opened = await openLaunchSurface(input, selection);
      active.surface = { frame: opened.frame ?? null, name: opened.surface, shown: opened.shown ?? null };
      if (selection) {
        active.selection.applied = opened.applied;
        active.selection.shown = opened.shown;
        active.selection.verified =
          Boolean(opened.applied) &&
          ["already", "applied"].includes(opened.applied.model) &&
          [null, "already", "applied"].includes(opened.applied.variant);
        active.selection.note = opened.applied ? selectionNote(selection, opened.applied, opened.shown) : null;
      }
    }
    return active;
  } catch (err) {
    console.error("VS Code launch failed:", err);
    if (app) await app.close();
    state.session = null;
    remove(paths);
    throw err;
  }
}

// Electron can drop Playwright's evaluate promise while the window is still
// starting ("Resulting promise was garbage collected"). Hiding is cosmetic for
// automation, so retry and never fail the launch on it.
async function hide(app) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const hidden = await app
      .evaluate(hideWindows)
      .then(() => true)
      .catch(() => false);
    if (hidden) return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function hideWindows({ app: main, BrowserWindow }) {
  const hide = (window) => {
    if (window.isDestroyed()) {
      return;
    }

    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        window.hide();
      }
    });
    window.hide();
  };

  for (const window of BrowserWindow.getAllWindows()) {
    hide(window);
  }

  main.on("browser-window-created", (_event, window) => hide(window));
  // The evaluate result is serialized back to Playwright; hand it nothing.
  return undefined;
}

async function windows() {
  return activeSession().app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      title: window.getTitle(),
      visible: window.isVisible(),
    })),
  );
}

function frames() {
  return activeSession()
    .page.frames()
    .map((item, index) => ({
      index,
      name: item.name(),
      url: item.url(),
    }));
}

function view(match) {
  if (!match) {
    return activeSession().page;
  }

  const hit = activeSession()
    .page.frames()
    .find((item) => item.name().includes(match) || item.url().includes(match));

  if (hit) {
    return hit;
  }

  return fail(
    `Frame matching \`${match}\` not found. Known frames: ${JSON.stringify(frames())}`,
  );
}

function locator(input) {
  const target = view(input.frame);
  const nth = input.nth ?? 0;

  if (input.selector) {
    return target.locator(input.selector).nth(nth);
  }

  if (input.text) {
    return target
      .getByText(input.text, { exact: input.exact ?? false })
      .nth(nth);
  }

  return fail("Provide either selector or text.");
}

async function bodyText(match) {
  return view(match)
    .locator("body")
    .innerText()
    .catch(() => "");
}

async function frameText(frame) {
  return frame
    .locator("body")
    .innerText()
    .catch(() => "");
}

async function kiloFrames() {
  const items = await Promise.all(
    activeSession()
      .page.frames()
      .map(async (frame, index) => ({
        frame,
        index,
        name: frame.name(),
        text: await frameText(frame),
        url: frame.url(),
      })),
  );

  return items.filter(
    (item) =>
      (cfg.extensionId && item.url.includes(`extensionId=${cfg.extensionId}`)) ||
      item.url.includes("fake.html"),
  );
}

function opener(name) {
  return cfg.openers[name] ?? fail(`Missing openers.${name} in vscode-self-test.config.json.`);
}

async function kiloFrame(kind, timeoutMs = 0) {
  const started = Date.now();
  for (;;) {
    const items = await kiloFrames();
    const find = async (selector) =>
      Promise.all(
        items.map(async (item) => ({
          item,
          match: await item.frame
            .locator(selector)
            .count()
            .then((count) => count > 0)
            .catch(() => false),
        })),
      ).then((matches) => matches.find((item) => item.match)?.item);
    const sidebar = items.find((item) => item.url.includes("purpose=webviewView"));
    const sidebarID = sidebar ? new URL(sidebar.url).searchParams.get("id") : null;
    const hit =
      kind === "agentManager"
        ? await find(opener("agentManagerFrameSelector"))
        : kind === "settings"
          ? await find(opener("settingsFrameSelector"))
          : items.find((item) => sidebarID && item.url.includes(`fake.html?id=${sidebarID}`)) ?? sidebar;

    if (hit) {
      return hit.frame;
    }

    if (Date.now() - started >= timeoutMs) {
      return fail(
        `Kilo ${kind} frame not found. Known frames: ${JSON.stringify(items.map((item) => ({ index: item.index, name: item.name, url: item.url, text: clip(item.text, 200) })))}`,
      );
    }

    await activeSession().page.waitForTimeout(250);
  }
}

async function saveScreenshot(input, path) {
  if (activeSession().headless && !input.selector && !input.text && !input.frame) {
    const client = await activeSession().page.context().newCDPSession(activeSession().page);
    const result = await client.send("Page.captureScreenshot", {
      captureBeyondViewport: input.fullPage ?? true,
      format: "png",
      fromSurface: true,
    });
    writeFileSync(path, Buffer.from(result.data, "base64"));
    await client.detach();
    return;
  }

  if (input.selector || input.text) {
    await locator(input).screenshot({ animations: "disabled", path });
    return;
  }

  if (input.frame) {
    await view(input.frame).locator("body").screenshot({ animations: "disabled", path });
    return;
  }

  await activeSession().page.screenshot({
    animations: "disabled",
    fullPage: input.fullPage ?? true,
    path,
  });
}

async function runCommand(command, waitMs) {
  const page = activeSession().page;
  const target = page.locator(".quick-input-widget input").last();
  for (let attempt = 0; ; attempt++) {
    // The palette opens from a renderer keybinding, which needs the window's
    // keyboard focus. A window that just replaced another one can miss it, so
    // focus the page and retry instead of failing the run.
    await page.bringToFront().catch(() => undefined);
    await page.evaluate(() => window.focus()).catch(() => undefined);
    await page.keyboard.press("F1");
    const open = await target
      .waitFor({ state: "visible", timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (open) break;
    if (attempt >= 2) {
      fail("The command palette did not open. Focus the VS Code window and retry, or launch with --headless false.");
    }
  }
  await target.fill(`>${command}`);
  await page.waitForTimeout(500);
  await target.press("Enter");
  await page.waitForTimeout(waitMs ?? 1000);
}

async function dismissWelcome() {
  const page = activeSession().page;
  const welcome = page.getByLabel("Welcome to Visual Studio Code").first();
  const visible = await welcome.isVisible().catch(() => false);
  if (!visible) {
    return false;
  }

  const close = welcome.getByLabel("Close").first();
  await close.click();
  await page.waitForTimeout(500);
  return true;
}

async function activityBarIndex(page, source) {
  return page
    .locator(".activitybar a.action-label")
    .evaluateAll((elements, pattern) => {
      const test = new RegExp(pattern);
      return elements
        .map((element, index) => ({ index, label: element.getAttribute("aria-label") ?? "" }))
        .filter((item) => test.test(item.label));
    }, source)
    .then((matches) => matches[0]?.index ?? -1)
    .catch(() => -1);
}

// Prefer the activity bar over the command palette. Palette keys require OS
// keyboard focus, which a headless (hidden) window does not have, and the view
// container title differs between v1 ("Kilo Code (NEW)") and v2 ("Kilo Code (v2)").
// The label is a regex source so one config covers both titles.
async function openKiloSidebar(waitMs) {
  await dismissWelcome();
  const page = activeSession().page;
  const label = cfg.openers.sidebarActivityLabel;
  if (!label) {
    await runCommand(opener("sidebarCommand"), waitMs ?? 1500);
    return;
  }

  const deadline = Date.now() + 10000;
  let index = -1;
  while (index < 0 && Date.now() < deadline) {
    index = await activityBarIndex(page, label);
    if (index < 0) await page.waitForTimeout(200);
  }
  if (index < 0) {
    return fail(
      `No activity bar item matches openers.sidebarActivityLabel ${JSON.stringify(label)}. Confirm the extension is installed and activated, or configure openers.sidebarCommand instead.`,
    );
  }

  const icon = page.locator(".activitybar a.action-label").nth(index);
  const shown = await icon.evaluate((element) => {
    const item = element.closest(".action-item");
    const sidebar = document.querySelector(".part.sidebar");
    return item?.classList.contains("checked") === true && sidebar?.classList.contains("hidden") !== true;
  });
  if (!shown) await icon.click();
  await page.waitForTimeout(waitMs ?? 1500);
}

function frameInfo(frame) {
  const url = frame.url();
  const match = url.match(/fake\.html\?id=[^&]+/)?.[0] || frame.name() || url;
  return { match, name: frame.name(), url };
}

async function openAgentManager(waitMs) {
  await openKiloSidebar(1200);
  const page = activeSession().page;
  const target = page
    .getByLabel(new RegExp(opener("agentManagerLabel")))
    .filter({ visible: true })
    .first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.click();
  const frame = await kiloFrame("agentManager", waitMs ?? 2500);

  return {
    frame: frameInfo(frame),
    title: await page.title(),
  };
}

async function openKiloSettings(waitMs) {
  await openKiloSidebar(1200);
  const page = activeSession().page;
  // Both v1 and v2 contribute a Settings title action for the Kilo view. v1
  // swaps the sidebar to Settings in place; v2 opens the Settings editor panel.
  const target = page
    .locator(opener("settingsSelector"))
    .filter({ visible: true })
    .first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.click();
  const frame = await kiloFrame("settings", waitMs ?? 2500);

  return {
    frame: frameInfo(frame),
    title: await page.title(),
  };
}

function walk(dir) {
  if (!existsSync(dir)) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(path);
    }

    return [path];
  });
}

function tail(path, lines) {
  const value = readFileSync(path, "utf8").trimEnd();
  if (!value) {
    return "";
  }

  return value.split("\n").slice(-lines).join("\n");
}

function metrics(result) {
  return Object.fromEntries(result.metrics.map((item) => [item.name, item.value]));
}

function delta(start, end) {
  return Object.fromEntries(
    Object.keys(end).map((name) => [name, end[name] - (start[name] ?? 0)]),
  );
}

async function saveStream(client, handle, path) {
  mkdirSync(dirname(path), { recursive: true });
  const file = openSync(path, "w");

  try {
    for (;;) {
      const chunk = await client.send("IO.read", { handle });
      const value = chunk.base64Encoded
        ? Buffer.from(chunk.data, "base64")
        : chunk.data;
      writeSync(file, value);
      if (chunk.eof) {
        break;
      }
    }
  } finally {
    closeSync(file);
    await client.send("IO.close", { handle }).catch(() => undefined);
  }
}

async function endTrace(profile) {
  const ended = await profile.traceClient
    .send("Tracing.end")
    .then(() => true)
    .catch(() => false);
  profile.traceRunning = false;
  if (!ended) {
    return null;
  }

  return Promise.race([
    profile.done.catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
  ]);
}

async function teardownProfile(profile) {
  if (profile.cpuRunning) {
    await profile.cpuClient.send("Profiler.stop").catch(() => undefined);
    profile.cpuRunning = false;
  }

  if (profile.traceRunning) {
    const result = await endTrace(profile);
    if (result?.stream) {
      await profile.traceClient
        .send("IO.close", { handle: result.stream })
        .catch(() => undefined);
    }
  }

  await profile.perfClient.send("Performance.disable").catch(() => undefined);
  const clients = [
    ...new Set([profile.traceClient, profile.cpuClient, profile.perfClient].filter(Boolean)),
  ];
  await Promise.all(clients.map((client) => client.detach().catch(() => undefined)));
}

async function discardProfile() {
  const profile = state.profile;
  if (!profile) {
    return;
  }

  state.profile = null;
  await teardownProfile(profile);
}

async function attachFrame(frame, scope) {
  const active = activeSession();
  const main = active.page.mainFrame();
  const target = frame === main ? active.page : frame;
  return active.page.context()
    .newCDPSession(target)
    .then((client) => ({ client, scope, url: frame.url() }))
    .catch((error) => {
      const parent = frame.parentFrame();
      if (!parent) {
        throw error;
      }

      return attachFrame(parent, "ancestor-frame");
    });
}

async function attachProfile(frame) {
  const active = activeSession();
  if (!frame) {
    return attachFrame(active.page.mainFrame(), "page");
  }

  return attachFrame(view(frame), "frame");
}

async function startProfile(input) {
  if (state.profile) {
    return fail("A VS Code performance profile is already recording. Call profile-stop first.");
  }

  const traceEnabled = input.trace ?? true;
  const cpuEnabled = input.cpu ?? true;
  if (!traceEnabled && !cpuEnabled) {
    return fail("Enable at least one of trace or cpu profiling.");
  }

  const active = activeSession();
  const target = await attachProfile(input.frame);
  const traceClient = traceEnabled
    ? target.scope === "page"
      ? target.client
      : await active.page.context()
          .newCDPSession(active.page)
          .catch(async (error) => {
            await target.client.detach().catch(() => undefined);
            throw error;
          })
    : null;
  const cpuClient = cpuEnabled ? target.client : null;
  const perfClient = target.client;
  const done = traceClient
    ? new Promise((resolve) => traceClient.once("Tracing.tracingComplete", resolve))
    : null;
  const profile = {
    categories: input.categories ?? categories,
    cpuClient,
    cpuEnabled,
    cpuRunning: false,
    done,
    frame: input.frame ?? null,
    interval: input.interval ?? 100,
    mark: null,
    perfClient,
    startedAt: new Date().toISOString(),
    startMetrics: null,
    target: {
      scope: target.scope,
      url: target.url,
    },
    traceClient,
    traceTarget: traceEnabled
      ? target.scope !== "page"
        ? "page-global"
        : target.scope
      : null,
    traceEnabled,
    traceRunning: false,
  };

  try {
    await perfClient.send("Performance.enable", { timeDomain: "timeTicks" });
    profile.startMetrics = metrics(await perfClient.send("Performance.getMetrics"));

    if (traceClient) {
      await traceClient.send("Tracing.start", {
        categories: profile.categories,
        options: "sampling-frequency=10000",
        streamFormat: "json",
        transferMode: "ReturnAsStream",
      });
      profile.traceRunning = true;
    }

    if (cpuClient) {
      await cpuClient.send("Profiler.enable");
      await cpuClient.send("Profiler.setSamplingInterval", {
        interval: profile.interval,
      });
      await cpuClient.send("Profiler.start");
      profile.cpuRunning = true;
    }

    profile.mark = await view(profile.frame)
      .evaluate((prefix) => {
        performance.mark(`${prefix}profile.start`);
        return performance.now();
      }, cfg.markPrefix)
      .catch(() => null);
    state.profile = profile;

    return {
      categories: profile.categories,
      cpu: profile.cpuEnabled,
      frame: profile.frame,
      target: profile.target,
      traceTarget: profile.traceTarget,
      interval: profile.interval,
      mark: profile.mark,
      startedAt: profile.startedAt,
      trace: profile.traceEnabled,
    };
  } catch (error) {
    await teardownProfile(profile);
    throw error;
  }
}

async function stopProfile(input) {
  const profile = state.profile ?? fail("No VS Code performance profile is recording. Call profile-start first.");
  state.profile = null;

  try {
    const dir = resolve(input.dir ?? join(temp("vscode-self-test-profile-"), "profile"));
    const tracePath = resolve(input.tracePath ?? join(dir, "trace.json"));
    const cpuPath = resolve(input.cpuPath ?? join(dir, "profile.cpuprofile"));
    const metadataPath = resolve(input.metadataPath ?? join(dir, "metadata.json"));
    const defaultMetadataPath = resolve(join(dir, "metadata.json"));
    const paths = [
      metadataPath,
      ...(profile.traceEnabled ? [tracePath] : []),
      ...(profile.cpuEnabled ? [cpuPath] : []),
    ];
    if (new Set(paths).size !== paths.length) {
      return fail("Profile artifact output paths must be distinct.");
    }
    if (
      metadataPath !== defaultMetadataPath &&
      paths.slice(1).includes(defaultMetadataPath)
    ) {
      return fail("Custom profile artifacts cannot overwrite the default metadata path.");
    }

    mkdirSync(dir, { recursive: true });
    mkdirSync(dirname(metadataPath), { recursive: true });
    if (metadataPath !== defaultMetadataPath) {
      rmSync(defaultMetadataPath, { force: true });
    }
    if (!profile.traceEnabled) {
      rmSync(tracePath, { force: true });
    }
    if (!profile.cpuEnabled) {
      rmSync(cpuPath, { force: true });
    }
    writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          frame: profile.frame,
          incomplete: true,
          markPrefix: cfg.markPrefix,
          startedAt: profile.startedAt,
          target: profile.target,
          traceTarget: profile.traceTarget,
        },
        null,
        2,
      ) + "\n",
    );

    const mark = await view(profile.frame)
      .evaluate((prefix) => {
        performance.mark(`${prefix}profile.stop`);
        return performance.now();
      }, cfg.markPrefix)
      .catch(() => null);
    const endedAt = new Date().toISOString();
    const endMetrics = metrics(await profile.perfClient.send("Performance.getMetrics"));
    let loss = null;

    if (profile.traceClient) {
      const result = await endTrace(profile);
      if (!result?.stream) {
        return fail("Chromium trace stopped without returning an artifact stream.");
      }
      loss = result.dataLossOccurred;
      await saveStream(profile.traceClient, result.stream, tracePath);
    }

    if (profile.cpuClient) {
      const result = await profile.cpuClient.send("Profiler.stop");
      profile.cpuRunning = false;
      mkdirSync(dirname(cpuPath), { recursive: true });
      writeFileSync(cpuPath, JSON.stringify(result.profile));
      await profile.cpuClient.send("Profiler.disable");
    }

    const metadata = {
      categories: profile.categories,
      cpu: profile.cpuEnabled ? cpuPath : null,
      endedAt,
      frame: profile.frame,
      incomplete: false,
      target: profile.target,
      traceTarget: profile.traceTarget,
      interval: profile.interval,
      mark: {
        start: profile.mark,
        stop: mark,
      },
      markPrefix: cfg.markPrefix,
      metrics: {
        delta: delta(profile.startMetrics, endMetrics),
        end: endMetrics,
        start: profile.startMetrics,
      },
      startedAt: profile.startedAt,
      trace: profile.traceEnabled ? tracePath : null,
      traceDataLoss: loss,
    };
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");

    return {
      cpuPath: profile.cpuEnabled ? cpuPath : null,
      dir,
      metadataPath,
      traceDataLoss: loss,
      tracePath: profile.traceEnabled ? tracePath : null,
    };
  } finally {
    await teardownProfile(profile);
  }
}

const server = new McpServer({
  name: "kilo-vscode-self-test",
  version: pkg.version,
});

server.registerTool(
  "launch-vscode",
  {
    description:
      "Build the extension, install or load it into an isolated VS Code instance, and launch it for manual testing. model/provider/variant preselect the first draft, then the opened composer confirms or commits it (a composer already on another model is switched). surface ends the launch on a named surface.",
    inputSchema: {
      appPath: z.string().optional(),
      userDir: z.string().optional(),
      build: z.boolean().optional(),
      headless: z.boolean().optional(),
      mode: z.enum(["dev", "vsix"]).optional(),
      model: z.string().optional(),
      provider: z.string().optional(),
      surface: z.enum(["none", "sidebar", "agent-manager", "settings", "terminal"]).optional(),
      terminalCommand: z.string().optional(),
      variant: z.string().optional(),
      waitMs: z.number().int().positive().max(60000).optional(),
      workspace: z.string().optional(),
    },
  },
  async (input) => {
    const active = await launchVsCode(input);

    return textResult(
      `Launched VS Code in ${active.mode} mode for ${active.workspace}.${active.selection?.note ? ` ${active.selection.note}` : ""}`,
      {
        appPath: active.appPath,
        backend: active.backend,
        configFile: active.configFile,
        extDir: active.extDir,
        frames: frames(),
        headless: active.headless,
        mode: active.mode,
        selection: active.selection ?? null,
        surface: active.surface ?? null,
        title: await active.page.title(),
        userDir: active.userDir,
        vsix: active.vsix,
        windows: await windows(),
        workspace: active.workspace,
      },
    );
  },
);

server.registerTool(
  "vscode-state",
  {
    description:
      "Show the current isolated VS Code session details and a text snapshot of the active window.",
    inputSchema: {
      maxChars: z.number().int().positive().max(20000).optional(),
    },
  },
  async (input) => {
    const active = activeSession();
    const text = clip(await bodyText(), input.maxChars ?? 4000);

    return textResult("Current VS Code session state.", {
      appPath: active.appPath,
      backend: active.backend,
      extDir: active.extDir,
      frames: frames(),
      headless: active.headless,
      mode: active.mode,
      text,
      url: active.page.url(),
      userDir: active.userDir,
      vsix: active.vsix,
      windows: await windows(),
      workspace: active.workspace,
    });
  },
);

server.registerTool(
  "vscode-frames",
  {
    description: "List the active Playwright frames in the VS Code window.",
    inputSchema: {},
  },
  async () => textResult("Active VS Code frames.", { frames: frames() }),
);

server.registerTool(
  "vscode-snapshot",
  {
    description:
      "Capture the visible text content from the VS Code window or a matching frame.",
    inputSchema: {
      frame: z.string().optional(),
      maxChars: z.number().int().positive().max(50000).optional(),
    },
  },
  async (input) => {
    const text = clip(await bodyText(input.frame), input.maxChars ?? 4000);

    return textResult("Captured VS Code text snapshot.", {
      frame: input.frame ?? null,
      frames: frames(),
      text,
      title: await activeSession().page.title(),
      url: activeSession().page.url(),
    });
  },
);

server.registerTool(
  "vscode-screenshot",
  {
    description:
      "Capture a screenshot of the VS Code window or a matching element.",
    inputSchema: {
      frame: z.string().optional(),
      fullPage: z.boolean().optional(),
      path: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
    },
  },
  async (input) => {
    const path = resolve(
      input.path ?? join(temp("vscode-self-test-shot-"), "capture.png"),
    );
    mkdirSync(dirname(path), { recursive: true });

    await saveScreenshot(input, path);

    return imageResult(`Saved screenshot to ${path}.`, path);
  },
);

server.registerTool(
  "vscode-observe",
  {
    description:
      "Capture a screenshot and text snapshot together for an observe-action loop.",
    inputSchema: {
      frame: z.string().optional(),
      fullPage: z.boolean().optional(),
      maxChars: z.number().int().positive().max(50000).optional(),
      path: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
    },
  },
  async (input) => {
    const path = resolve(
      input.path ?? join(temp("vscode-self-test-observe-"), "observe.png"),
    );
    mkdirSync(dirname(path), { recursive: true });
    await saveScreenshot(input, path);
    const snapshot = clip(await bodyText(input.frame), input.maxChars ?? 4000);

    return imageResult("Captured VS Code observation.", path, {
      frame: input.frame ?? null,
      frames: frames(),
      text: snapshot,
      title: await activeSession().page.title(),
      url: activeSession().page.url(),
    });
  },
);

server.registerTool(
  "vscode-profile-start",
  {
    description:
      "Start a Chromium performance trace and JavaScript CPU profile for the VS Code page or matching webview frame.",
    inputSchema: {
      categories: z.string().optional(),
      cpu: z.boolean().optional(),
      frame: z.string().optional(),
      interval: z.number().int().min(50).max(10000).optional(),
      trace: z.boolean().optional(),
    },
  },
  async (input) => {
    const result = await startProfile(input);
    return textResult("Started VS Code performance profiling.", result);
  },
);

server.registerTool(
  "vscode-profile-stop",
  {
    description:
      "Stop active VS Code performance profiling and write trace, CPU profile, and metadata artifacts.",
    inputSchema: {
      cpuPath: z.string().optional(),
      dir: z.string().optional(),
      metadataPath: z.string().optional(),
      tracePath: z.string().optional(),
    },
  },
  async (input) => {
    const result = await stopProfile(input);
    return textResult("Stopped VS Code performance profiling.", result);
  },
);

server.registerTool(
  "vscode-select",
  {
    description:
      "Select the model and effort of the composer in VS Code and report the picker-confirmed result. Use it after switching a transcript tab, where a launch-time selection no longer applies.",
    inputSchema: {
      frame: z.string().optional(),
      model: z.string(),
      provider: z.string().optional(),
      variant: z.string().optional(),
    },
  },
  async (input) => {
    const selection = modelSelection(input);
    const frame = await selectionFrame(input);
    const result = await applySelection(frame, selection);

    return textResult(
      `Selected ${selection.providerID}/${selection.model}${selection.variant ? ` at ${selection.variant}` : ""}: ${result.applied.model}${result.applied.variant ? `, effort ${result.applied.variant}` : ""}.`,
      { applied: result.applied, frame: frameInfo(frame), requested: selection, shown: result.shown },
    );
  },
);

server.registerTool(
  "open-kilo",
  {
    description: "Focus the Kilo sidebar view in VS Code.",
    inputSchema: {
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    await openKiloSidebar(input.waitMs);
    const frame = await kiloFrame("sidebar", 5000);

    return textResult("Focused the Kilo sidebar.", {
      frame: frameInfo(frame),
      title: await activeSession().page.title(),
    });
  },
);

server.registerTool(
  "open-agent-manager",
  {
    description: "Open the Agent Manager from the Kilo sidebar toolbar button.",
    inputSchema: {
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    const result = await openAgentManager(input.waitMs);
    return textResult("Opened Agent Manager.", result);
  },
);

server.registerTool(
  "open-kilo-settings",
  {
    description:
      "Open the Kilo settings panel from the Kilo sidebar toolbar button.",
    inputSchema: {
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    const result = await openKiloSettings(input.waitMs);
    return textResult("Opened Kilo settings.", result);
  },
);

server.registerTool(
  "vscode-click",
  {
    description:
      "Click a VS Code element by selector or visible text, or click absolute window coordinates.",
    inputSchema: {
      button: z.enum(["left", "middle", "right"]).optional(),
      exact: z.boolean().optional(),
      frame: z.string().optional(),
      nth: z.number().int().min(0).optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      waitMs: z.number().int().min(0).max(60000).optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  async (input) => {
    const hasPoint = typeof input.x === "number" && typeof input.y === "number";

    if (hasPoint) {
      await activeSession().page.mouse.click(input.x, input.y, {
        button: input.button ?? "left",
      });
    }

    if (!hasPoint) {
      const target = locator(input);
      await target.click({ button: input.button ?? "left" });
    }

    await activeSession().page.waitForTimeout(input.waitMs ?? 500);

    return textResult("Clicked VS Code element.", {
      button: input.button ?? "left",
      frame: input.frame ?? null,
      selector: input.selector ?? null,
      text: input.text ?? null,
      x: hasPoint ? input.x : null,
      y: hasPoint ? input.y : null,
    });
  },
);

server.registerTool(
  "vscode-hover",
  {
    description: "Hover a VS Code element by selector or visible text.",
    inputSchema: {
      exact: z.boolean().optional(),
      frame: z.string().optional(),
      nth: z.number().int().min(0).optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    await locator(input).hover();
    await activeSession().page.waitForTimeout(input.waitMs ?? 500);

    return textResult("Hovered VS Code element.", {
      frame: input.frame ?? null,
      selector: input.selector ?? null,
      text: input.text ?? null,
    });
  },
);

server.registerTool(
  "vscode-move",
  {
    description: "Move the mouse to absolute window coordinates.",
    inputSchema: {
      steps: z.number().int().positive().max(200).optional(),
      waitMs: z.number().int().min(0).max(60000).optional(),
      x: z.number(),
      y: z.number(),
    },
  },
  async (input) => {
    await activeSession().page.mouse.move(input.x, input.y, {
      steps: input.steps ?? 1,
    });
    await activeSession().page.waitForTimeout(input.waitMs ?? 100);

    return textResult("Moved mouse in VS Code.", {
      steps: input.steps ?? 1,
      x: input.x,
      y: input.y,
    });
  },
);

server.registerTool(
  "vscode-scroll",
  {
    description: "Scroll the VS Code window using mouse wheel deltas.",
    inputSchema: {
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    await activeSession().page.mouse.wheel(
      input.deltaX ?? 0,
      input.deltaY ?? 0,
    );
    await activeSession().page.waitForTimeout(input.waitMs ?? 250);

    return textResult("Scrolled VS Code.", {
      deltaX: input.deltaX ?? 0,
      deltaY: input.deltaY ?? 0,
    });
  },
);

server.registerTool(
  "vscode-evaluate",
  {
    description:
      "Run JavaScript in the current VS Code page or a matching frame and return a JSON-serializable result.",
    inputSchema: {
      frame: z.string().optional(),
      maxChars: z.number().int().positive().max(50000).optional(),
      script: z.string(),
    },
  },
  async (input) => {
    const result = await view(input.frame).evaluate((script) => {
      const value = Function(`"use strict";\n${script}`)();
      if (value === undefined) {
        return null;
      }

      return JSON.parse(JSON.stringify(value));
    }, input.script);

    return textResult("Executed JavaScript in VS Code.", {
      frame: input.frame ?? null,
      result: clip(JSON.stringify(result, null, 2), input.maxChars ?? 4000),
    });
  },
);

server.registerTool(
  "vscode-type",
  {
    description:
      "Type text into the current VS Code focus target or an element selected by selector or text.",
    inputSchema: {
      clear: z.boolean().optional(),
      exact: z.boolean().optional(),
      frame: z.string().optional(),
      nth: z.number().int().min(0).optional(),
      selector: z.string().optional(),
      submit: z.boolean().optional(),
      text: z.string().optional(),
      value: z.string(),
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    if (input.selector || input.text) {
      const target = locator(input);
      await target.click();
      if (input.clear) {
        await target.fill("");
      }
    }

    await activeSession().page.keyboard.type(input.value);
    if (input.submit) {
      await activeSession().page.keyboard.press("Enter");
    }

    await activeSession().page.waitForTimeout(input.waitMs ?? 500);

    return textResult("Typed into VS Code.", {
      frame: input.frame ?? null,
      selector: input.selector ?? null,
      submitted: input.submit ?? false,
      text: input.text ?? null,
      value: input.value,
    });
  },
);

server.registerTool(
  "vscode-press",
  {
    description: "Send a keyboard shortcut to the VS Code window.",
    inputSchema: {
      keys: z.string(),
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    await activeSession().page.keyboard.press(input.keys);
    await activeSession().page.waitForTimeout(input.waitMs ?? 500);

    return textResult(`Pressed ${input.keys}.`, { keys: input.keys });
  },
);

server.registerTool(
  "vscode-run-command",
  {
    description:
      "Open the command palette, search for a command, and execute it.",
    inputSchema: {
      command: z.string(),
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    await runCommand(input.command, input.waitMs);

    return textResult(`Ran VS Code command: ${input.command}.`, {
      command: input.command,
    });
  },
);

server.registerTool(
  "vscode-wait",
  {
    description:
      "Wait for a VS Code element or visible text to reach a given state.",
    inputSchema: {
      exact: z.boolean().optional(),
      frame: z.string().optional(),
      nth: z.number().int().min(0).optional(),
      selector: z.string().optional(),
      state: z.enum(["attached", "detached", "hidden", "visible"]).optional(),
      text: z.string().optional(),
      timeoutMs: z.number().int().positive().max(60000).optional(),
    },
  },
  async (input) => {
    await locator(input).waitFor({
      state: input.state ?? "visible",
      timeout: input.timeoutMs ?? 10000,
    });

    return textResult("Wait condition satisfied.", {
      frame: input.frame ?? null,
      selector: input.selector ?? null,
      state: input.state ?? "visible",
      text: input.text ?? null,
      timeoutMs: input.timeoutMs ?? 10000,
    });
  },
);

server.registerTool(
  "vscode-logs",
  {
    description:
      "Read the newest VS Code log files from the isolated user-data directory.",
    inputSchema: {
      filter: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
      maxChars: z.number().int().positive().max(50000).optional(),
    },
  },
  async (input) => {
    const active = activeSession();
    const files = newest(
      walk(join(active.userDir, "logs")).filter(
        (item) =>
          item.endsWith(".log") &&
          (!input.filter || item.includes(input.filter)),
      ),
    ).slice(0, 5);

    const logs = files.map((item) => ({
      path: item,
      text: clip(tail(item, input.limit ?? 40), input.maxChars ?? 12000),
    }));

    return textResult("Collected recent VS Code logs.", {
      logs,
      userDir: active.userDir,
    });
  },
);

server.registerTool(
  "vscode-console",
  {
    description:
      "Read recent browser and webview console messages captured from the live VS Code window.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional(),
      maxChars: z.number().int().positive().max(50000).optional(),
      type: z.string().optional(),
    },
  },
  async (input) => {
    const items = state.console
      .filter((item) => !input.type || item.type === input.type)
      .slice(-(input.limit ?? 50))
      .map((item) => ({
        ...item,
        text: clip(item.text, input.maxChars ?? 4000),
      }));

    return textResult("Collected recent VS Code console messages.", { items });
  },
);

server.registerTool(
  "stop-vscode",
  {
    description:
      "Close the isolated VS Code session and optionally remove its temp directories.",
    inputSchema: {
      cleanup: z.boolean().optional(),
    },
  },
  async (input) => {
    const result = await closeSession(input.cleanup ?? true);
    return textResult("Stopped isolated VS Code session.", result);
  },
);

async function shutdown() {
  await closeSession(true);
  await server.close().catch(() => undefined);
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

if (process.argv.includes("--self-check")) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [import.meta.filename],
    cwd: root,
    env: inherited,
    stderr: "inherit",
  });
  const client = new Client({ name: "self-check", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(
    JSON.stringify(
      tools.tools.map((item) => item.name),
      null,
      2,
    ),
  );
  await client.close();
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
