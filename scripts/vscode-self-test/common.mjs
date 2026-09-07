import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cfg } from "./config.mjs";

export const scriptDir = import.meta.dirname;

const values = new Set(
  "app-path mode user-dir wait-ms workspace categories frame interval cpu-path dir metadata-path trace-path limit metadata path max-chars title selector text name surface alt width button nth x y steps delta-x delta-y value keys state timeout-ms command filter type script".split(" "),
);

export function select(argv, env = process.env) {
  const args = [];
  let session = env.KILO_SELF_TEST_SESSION ?? env.SELF_TEST_SESSION;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg !== "--session" && !arg.startsWith("--session=")) {
      args.push(arg);
      if (arg.startsWith("--") && (values.has(arg.slice(2)) || (args[0] === "profile-analyze" && ["--cpu", "--trace"].includes(arg)))) {
        const next = argv[++index];
        // Reject ambiguous payloads before any session state can be contacted.
        if (next == null || next.startsWith("--")) {
          throw new Error(`${arg} requires a value; use ${arg}=VALUE for dash-leading content`);
        }
        args.push(next);
      }
      continue;
    }
    session = arg === "--session" ? argv[++index] : arg.slice(10);
    if (!session || session.startsWith("--") || !session.trim()) {
      throw new Error("--session requires a non-empty session ID");
    }
  }
  if (!session?.trim()) {
    throw new Error("Missing self-test session: pass --session ID or set KILO_SELF_TEST_SESSION or SELF_TEST_SESSION. Legacy repo-only state is never used.");
  }
  return { args, session };
}

const selection = select(process.argv.slice(2));
export const session = selection.session;
export const args = selection.args;

function slug(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export const repo = cfg.project;
export const root = cfg.extensionRoot;
const base = resolve(process.env["SELF_TEST_STATE_DIR"] ?? join(homedir(), ".config", "vscode-extension-self-test", "state"));
export const stateDir = join(base, slug(repo), slug(session));
export const lockPath = join(stateDir, "owner.json");
export const statePath = join(stateDir, "state.json");
export const logPath = join(stateDir, "daemon.log");

export const inherited = {
  ...process.env,
  SELF_TEST_REPO: repo,
  SELF_TEST_CONFIG: cfg.path ?? "",
  SELF_TEST_STATE_DIR: base,
  KILO_SELF_TEST_SESSION: session,
  SELF_TEST_SESSION: session,
};

const directories = new Set();
export function temporary(prefix) {
  // macOS AF_UNIX paths, including VS Code's socket suffix, must fit 103 bytes.
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  const dir = mkdtempSync(join(base, `vst-${slug(repo)}-${slug(session)}-${prefix.replace("vscode-self-test-", "")}`));
  directories.add(dir);
  return dir;
}

export function cleanup(paths) {
  return paths.filter(Boolean).map((dir) => {
    if (!directories.has(dir)) throw new Error(`Refusing cleanup of unowned directory: ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    directories.delete(dir);
    return dir;
  });
}

export function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

export function readState() {
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    if (state.repo !== repo || state.selector !== session) throw new Error(`Self-test state identity mismatch: ${statePath}`);
    return state;
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function writeState(value) {
  ensureStateDir();
  const owner = JSON.parse(readFileSync(lockPath, "utf8"));
  if (owner.token !== value.token || owner.pid !== process.pid) throw new Error("Refusing to write self-test state without ownership");
  const path = `${statePath}.${token()}.tmp`;
  try {
    writeFileSync(path, JSON.stringify({ ...value, repo, selector: session }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(path, statePath);
  } finally {
    rmSync(path, { force: true });
  }
}

export function removeState(owner) {
  if (owner && readState()?.token === owner) rmSync(statePath, { force: true });
}

export function claim(owner) {
  ensureStateDir();
  try {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: owner, repo, selector: session }), { flag: "wx", mode: 0o600 });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    throw new Error(`Session already owned or stale lock: ${lockPath}. Inspect its PID and remove only after confirming all owned processes have exited.`);
  }
}

export function release(owner) {
  if (!existsSync(lockPath)) return;
  if (JSON.parse(readFileSync(lockPath, "utf8")).token !== owner) return;
  removeState(owner);
  rmSync(lockPath);
}

export function owned(owner) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")).token === owner;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

export function environment(dir, source = process.env) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (/^(KILO|OPENCODE)_.*(CONFIG|DB|DATABASE)/.test(key)) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KILO_SELF_TEST_SESSION;
  delete env.SELF_TEST_SESSION;
  env.KILO_TEST_HOME = join(dir, "home");
  mkdirSync(env.KILO_TEST_HOME, { recursive: true });
  for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"]) {
    env[`XDG_${kind}_HOME`] = join(dir, kind.toLowerCase());
    mkdirSync(env[`XDG_${kind}_HOME`], { recursive: true });
  }
  env.KILO_CONFIG_DIR = join(env.XDG_CONFIG_HOME, "kilo");
  env.KILO_TEST_MANAGED_CONFIG_DIR = join(env.XDG_CONFIG_HOME, "managed");
  mkdirSync(env.KILO_CONFIG_DIR, { recursive: true });
  mkdirSync(env.KILO_TEST_MANAGED_CONFIG_DIR, { recursive: true });
  return env;
}

export function settings(dir, value) {
  const path = join(dir, "User");
  mkdirSync(path, { recursive: true });
  try {
    writeFileSync(join(path, "settings.json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  } catch (err) {
    // Keep existing JSONC byte-for-byte, including user changes and comments.
    if (err.code !== "EEXIST") throw err;
  }
}

export function token() {
  return randomUUID().replaceAll("-", "");
}

export function output(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

export function url(value) {
  return `http://127.0.0.1:${value.port}`;
}

function headers(state) {
  return { "content-type": "application/json", "x-vscode-self-test-token": state.token };
}

export async function ping(state) {
  if (!state) return null;
  const response = await fetch(`${url(state)}/status`, { headers: headers(state), signal: AbortSignal.timeout(1000) }).catch(() => null);
  if (!response?.ok) return null;
  const info = await response.json();
  return info.repo === repo && info.selector === session && info.pid === state.pid ? info : null;
}

export async function request(state, route, body) {
  if (state.repo !== repo || state.selector !== session) throw new Error("Self-test request identity mismatch");
  const response = await fetch(`${url(state)}${route}`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: headers(state),
    method: body ? "POST" : "GET",
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error ?? `${route} failed with ${response.status}`);
  return data;
}
