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
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { repo, root, scriptDir } from "./common.mjs";
import { cfg } from "./config.mjs";

const execFileP = promisify(execFile);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

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
  return mkdtempSync(join(tmpdir(), prefix));
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

async function run(command, args, cwd) {
  await execFileP(command, args, {
    cwd,
    env: process.env,
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
          "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
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
  const found = candidates.find((item) => existsSync(item)) ?? resolveOnPath("code") ?? resolveOnPath("code-insiders");
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
  const dir = join(userDir, "User");
  mkdirSync(dir, { recursive: true });
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
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ ...value, ...cfg.settings }, null, 2) + "\n",
  );
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

async function installVsix(cliPath, userDir, extDir, vsix) {
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
  );
}

async function closeSession(cleanup) {
  const active = state.session;
  if (!active) {
    return { removed: [] };
  }

  await discardProfile();
  state.session = null;
  state.console = [];
  await active.app.close().catch(() => undefined);

  const removed = cleanup
    ? [active.userDir, active.extDir, active.outDir]
        .filter(Boolean)
        .map((item) => {
          rmSync(item, { recursive: true, force: true });
          return item;
        })
    : [];

  return {
    extDir: active.extDir,
    mode: active.mode,
    removed,
    userDir: active.userDir,
    vsix: active.vsix,
    workspace: active.workspace,
  };
}

async function launchVsCode(input) {
  await closeSession(true);

  const mode = input.mode ?? "vsix";
  const appPath = detectAppPath(input.appPath);
  const cliPath = mode === "vsix" ? detectCliPath(appPath) : null;
  const workspace = resolve(input.workspace ?? cfg.workspace);
  const userDir = temp("vscode-self-test-user-");
  const extDir = temp("vscode-self-test-ext-");
  const outDir = mode === "vsix" ? temp("vscode-self-test-vsix-") : null;
  const waitMs = input.waitMs ?? 5000;

  writeSettings(userDir);

  if (input.build ?? true) {
    await buildExtension();
  }

  const vsix = mode === "vsix" && outDir ? await packageVsix(outDir) : null;

  if (vsix) {
    await installVsix(cliPath, userDir, extDir, vsix);
  }

  const args = [
    workspace,
    `--extensions-dir=${extDir}`,
    `--user-data-dir=${userDir}`,
    "--skip-release-notes",
  ];
  if (mode === "dev") {
    args.push(`--extensionDevelopmentPath=${root}`);
    if (cfg.extensionId) {
      args.push(`--disable-extension=${cfg.extensionId}`);
    }
  }

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args,
    env,
    executablePath: appPath,
  });

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
    cliPath,
    extDir,
    mode,
    outDir,
    page,
    userDir,
    vsix,
    workspace,
  };

  state.session = active;
  return active;
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

async function kiloFrame(kind) {
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

  return fail(
    `Kilo ${kind} frame not found. Known frames: ${JSON.stringify(items.map((item) => ({ index: item.index, name: item.name, url: item.url, text: clip(item.text, 200) })))}`,
  );
}

async function saveScreenshot(input, path) {
  if (input.selector || input.text) {
    await locator(input).screenshot({ path });
    return;
  }

  if (input.frame) {
    await view(input.frame).locator("body").screenshot({ path });
    return;
  }

  await activeSession().page.screenshot({
    fullPage: input.fullPage ?? true,
    path,
  });
}

async function runCommand(command, waitMs) {
  const page = activeSession().page;
  await page.keyboard.press("F1");
  const target = page.locator(".quick-input-widget input").last();
  await target.waitFor({ state: "visible", timeout: 5000 });
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

async function openKiloSidebar(waitMs) {
  await dismissWelcome();
  await runCommand(
    opener("sidebarCommand"),
    waitMs ?? 1500,
  );
}

function frameInfo(frame) {
  const url = frame.url();
  const match = url.match(/fake\.html\?id=[^&]+/)?.[0] || frame.name() || url;
  return { match, name: frame.name(), url };
}

async function openAgentManager(waitMs) {
  await openKiloSidebar(1200);
  const page = activeSession().page;
  const target = page.getByLabel(new RegExp(opener("agentManagerLabel"))).first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.click();
  await page.waitForTimeout(waitMs ?? 2500);
  const frame = await kiloFrame("agentManager");

  return {
    frame: frameInfo(frame),
    title: await page.title(),
  };
}

async function openKiloSettings(waitMs) {
  await openKiloSidebar(1200);
  const page = activeSession().page;
  const target = page.locator(opener("settingsSelector")).first();
  await target.waitFor({ state: "visible", timeout: 10000 });
  await target.click();
  await page.waitForTimeout(waitMs ?? 2500);
  const frame = await kiloFrame("settings");

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
      "Build the extension, install or load it into an isolated VS Code instance, and launch it for manual testing.",
    inputSchema: {
      appPath: z.string().optional(),
      build: z.boolean().optional(),
      mode: z.enum(["dev", "vsix"]).optional(),
      waitMs: z.number().int().positive().max(60000).optional(),
      workspace: z.string().optional(),
    },
  },
  async (input) => {
    const active = await launchVsCode(input);

    return textResult(
      `Launched VS Code in ${active.mode} mode for ${active.workspace}.`,
      {
        appPath: active.appPath,
        extDir: active.extDir,
        frames: frames(),
        mode: active.mode,
        title: await active.page.title(),
        userDir: active.userDir,
        vsix: active.vsix,
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
      extDir: active.extDir,
      frames: frames(),
      mode: active.mode,
      text,
      url: active.page.url(),
      userDir: active.userDir,
      vsix: active.vsix,
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
  "open-kilo",
  {
    description: "Focus the Kilo sidebar view in VS Code.",
    inputSchema: {
      waitMs: z.number().int().min(0).max(60000).optional(),
    },
  },
  async (input) => {
    await openKiloSidebar(input.waitMs);
    const frame = await kiloFrame("sidebar");

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
    env: { ...process.env, SELF_TEST_REPO: repo },
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
