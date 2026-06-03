import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function gitRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function find(start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const path = join(dir, "vscode-self-test.config.json");
    if (existsSync(path)) return path;
    if (dirname(dir) === dir) return null;
  }
}

function command(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  throw new Error("Commands in vscode-self-test.config.json must be arrays.");
}

const project = resolve(process.env["SELF_TEST_REPO"] ?? gitRoot());
const path = process.env["SELF_TEST_CONFIG"] ? resolve(process.env["SELF_TEST_CONFIG"]) : find(process.cwd());
const value = path ? JSON.parse(readFileSync(path, "utf8")) : {};
const extensionRoot = resolve(project, value.extensionRoot ?? ".");
const manifestPath = join(extensionRoot, "package.json");
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
const extensionId = manifest.publisher && manifest.name ? `${manifest.publisher}.${manifest.name}` : null;

export const cfg = {
  build: command(value.build?.command, ["npm", "run", "package"]),
  extensionId: value.extensionId ?? extensionId,
  extensionRoot,
  markPrefix: value.profile?.markPrefix ?? "selftest.",
  openers: value.openers ?? {},
  path,
  project,
  settings: value.vscode?.settings ?? {},
  vscodeCli: value.vscode?.cli,
  vscodeExecutable: value.vscode?.executable,
  vsix: command(value.vsix?.command, ["npx", "vsce", "package", "--no-dependencies", "--skip-license", "-o", "{outDir}/"]),
  workspace: resolve(project, value.workspace ?? "."),
};
