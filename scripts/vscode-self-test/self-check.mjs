#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const src = existsSync(join(root, "src")) ? join(root, "src") : root;
const session = `self-check-${randomUUID()}`;

for (const name of ["engine-mcp.mjs", "mcp.mjs"]) {
  const result = spawnSync(process.execPath, [join(src, name), "--self-check"], {
    env: { ...process.env, KILO_SELF_TEST_SESSION: session, SELF_TEST_SESSION: session },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
