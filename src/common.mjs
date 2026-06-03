import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cfg } from "./config.mjs";

export const scriptDir = import.meta.dirname;

function slug(path) {
  return createHash("sha256").update(path).digest("hex").slice(0, 12);
}

export const repo = cfg.project;
export const root = cfg.extensionRoot;
export const stateDir = resolve(process.env["SELF_TEST_STATE_DIR"] ?? join(homedir(), ".config", "vscode-extension-self-test", "state", slug(repo)));
export const statePath = join(stateDir, "state.json");
export const logPath = join(stateDir, "daemon.log");

export function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true });
}

export function readState() {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

export function writeState(value) {
  ensureStateDir();
  writeFileSync(statePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(statePath, 0o600);
}

export function removeState() {
  rmSync(statePath, { force: true });
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
  } catch {
    return false;
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
  const response = await fetch(`${url(state)}/status`, { headers: headers(state) }).catch(() => null);
  if (!response?.ok) return null;
  return response.json();
}

export async function request(state, route, body) {
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
