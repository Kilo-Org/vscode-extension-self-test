import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const home = realpathSync(mkdtempSync(join(tmpdir(), "self-test-isolation-")));
const project = join(home, "project");
const config = join(home, "fixture.json");
mkdirSync(join(project, "extension"), { recursive: true });
writeFileSync(
  config,
  JSON.stringify({
    extensionRoot: "extension",
    build: { command: [process.execPath, "-e", "process.exit(1)"] },
    workspace: ".",
    profile: { markPrefix: "fixture." },
  }),
);
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  KILO_SELF_TEST_SESSION: "unit",
  SELF_TEST_SESSION: "generic",
  SELF_TEST_REPO: project,
  SELF_TEST_CONFIG: config,
  SELF_TEST_STATE_DIR: join(home, "state"),
});
const common = await import("./common.mjs");
const cli = join(import.meta.dirname, "cli.mjs");
const env = { ...process.env };
const run = async (...args) =>
  JSON.parse(
    (await exec(process.execPath, [cli, ...args], { env, timeout: 25000 }))
      .stdout,
  );
const slug = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);

test("required selector precedence is flag, Kilo, then generic environment", async () => {
  assert.throws(() => common.select([], {}), /Missing self-test session/);
  assert.throws(
    () =>
      common.select([], {
        KILO_SELF_TEST_SESSION: "",
        SELF_TEST_SESSION: "other",
      }),
    /Missing self-test session/,
  );
  assert.throws(() => common.select(["--session"], env), /requires/);
  assert.throws(() => common.select(["--session="], env), /requires/);
  assert.equal(common.select(["status"], env).session, "unit");
  assert.equal(
    common.select(["status"], { SELF_TEST_SESSION: "generic" }).session,
    "generic",
  );
  for (const args of [
    ["--session", "flag", "status"],
    ["status", "--session=flag"],
  ]) {
    assert.deepEqual(common.select(args, env), {
      args: ["status"],
      session: "flag",
    });
  }
  await assert.rejects(
    exec(process.execPath, [cli, "status"], {
      env: { ...env, KILO_SELF_TEST_SESSION: "", SELF_TEST_SESSION: "" },
    }),
    /Missing self-test session/,
  );
});

test("selector-shaped payloads fail before routing, in both orders and with an environment owner", async () => {
  const before = readdirSync(home, { recursive: true });
  for (const option of ["value", "script", "text", "selector"]) {
    for (const args of [
      ["type", "--session", "own", `--${option}`, "--session=other"],
      ["type", `--${option}`, "--session=other", "--session", "own"],
      ["type", `--${option}`, "--session=other"],
      ["type", `--${option}`, "--session", "other"],
    ]) {
      assert.throws(() => common.select(args, {}), /dash-leading content/);
      assert.throws(() => common.select(args, env), /dash-leading content/);
      await assert.rejects(
        exec(process.execPath, [cli, ...args], { env }),
        /dash-leading content/,
      );
    }
    for (const args of [
      ["--session", "unit", "type", `--${option}=--session=other`],
      ["type", `--${option}=--session=other`, "--session=unit"],
      ["type", `--${option}=--session=other`],
    ]) {
      assert.deepEqual(common.select(args, env), {
        session: "unit",
        args: ["type", `--${option}=--session=other`],
      });
    }
  }
  assert.deepEqual(readdirSync(home, { recursive: true }), before);
});

test("clean help and self-check need no operational selector", async () => {
  const isolated = {
    ...env,
    KILO_SELF_TEST_SESSION: "",
    SELF_TEST_SESSION: "",
  };
  for (const args of [[], ["help"], ["--help"]]) {
    const result = await exec(process.execPath, [cli, ...args], {
      cwd: home,
      env: isolated,
    });
    assert.match(result.stdout, /vscode-self-test commands/);
  }
  const before = readdirSync(home, { recursive: true });
  const result = await exec(
    process.execPath,
    [join(import.meta.dirname, "self-check.mjs")],
    { cwd: home, env: isolated },
  );
  assert.match(result.stdout, /launch-vscode/);
  assert.deepEqual(readdirSync(home, { recursive: true }), before);
});

test("configured state base always includes repository and session, and child config stays resolved", async () => {
  assert.equal(
    common.stateDir,
    join(env.SELF_TEST_STATE_DIR, slug(project), slug("unit")),
  );
  assert.equal(common.root, join(project, "extension"));
  assert.equal(common.inherited.SELF_TEST_CONFIG, config);
  assert.equal(common.inherited.KILO_SELF_TEST_SESSION, "unit");
  assert.equal(common.inherited.SELF_TEST_SESSION, "unit");
  const script = `import {stateDir} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "common.mjs")).href)}; console.log(stateDir)`;
  for (const override of [
    { SELF_TEST_REPO: join(home, "other") },
    { KILO_SELF_TEST_SESSION: "other" },
    { SELF_TEST_STATE_DIR: join(home, "other-state") },
  ]) {
    const result = await exec(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env: { ...env, ...override } },
    );
    assert.notEqual(result.stdout.trim(), common.stateDir);
  }
  const result = await exec(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: project,
      env: {
        ...env,
        SELF_TEST_STATE_DIR: "../relative-state",
        SELF_TEST_CONFIG: "../fixture.json",
      },
    },
  );
  assert.equal(
    result.stdout.trim(),
    join(home, "relative-state", slug(project), slug("unit")),
  );
});

test("exclusive ownership and atomic state reject another owner's writes and cleanup", () => {
  common.claim("owner");
  assert.equal(common.owned("owner"), true);
  assert.equal(common.owned("other"), false);
  common.writeState({ token: "owner", pid: process.pid });
  assert.throws(() => common.claim("other"), /already owned/);
  assert.throws(
    () => common.writeState({ token: "other" }),
    /without ownership/,
  );
  common.release("other");
  common.removeState("other");
  assert.equal(common.readState().token, "owner");
  assert.ok(existsSync(common.lockPath));
  assert.equal(
    readdirSync(common.stateDir).filter((name) => name.endsWith(".tmp")).length,
    0,
  );
  common.release("owner");
  assert.equal(common.owned("owner"), false);
  assert.equal(common.readState(), null);
  assert.equal(existsSync(common.lockPath), false);
});

test("settings initializes new profiles without replacing existing JSONC", () => {
  const dir = join(home, "settings-profile");
  const path = join(dir, "User", "settings.json");
  common.settings(dir, { "editor.fontSize": 14 });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    "editor.fontSize": 14,
  });
  const content =
    '// Keep this comment and trailing comma.\n{ "editor.fontSize": 17, }\n';
  writeFileSync(path, content);
  common.settings(dir, { "editor.fontSize": 20 });
  assert.equal(readFileSync(path, "utf8"), content);
});

test("backend environment isolates XDG, home, configuration, database and both selector aliases", () => {
  const source = {
    PATH: "/bin",
    KILO_DB: "/live.db",
    KILO_CONFIG: "/config",
    KILO_CONFIG_CONTENT: "secret",
    KILO_CONFIG_DIR: "/config",
    OPENCODE_CONFIG: "/config",
    KILO_TEST_MANAGED_CONFIG_DIR: "/config",
    KILO_TEST_HOME: "/home",
    KILO_SELF_TEST_SESSION: "kilo",
    SELF_TEST_SESSION: "generic",
    ELECTRON_RUN_AS_NODE: "1",
    XDG_DATA_HOME: "/data",
  };
  const a = common.environment(join(home, "a"), source);
  const b = common.environment(join(home, "b"), source);
  for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"]) {
    assert.notEqual(a[`XDG_${kind}_HOME`], b[`XDG_${kind}_HOME`]);
    assert.ok(existsSync(a[`XDG_${kind}_HOME`]));
  }
  for (const key of [
    "KILO_DB",
    "KILO_CONFIG",
    "KILO_CONFIG_CONTENT",
    "OPENCODE_CONFIG",
    "ELECTRON_RUN_AS_NODE",
    "KILO_SELF_TEST_SESSION",
    "SELF_TEST_SESSION",
  ])
    assert.equal(a[key], undefined);
  assert.ok(a.KILO_CONFIG_DIR.startsWith(join(home, "a")));
  assert.ok(a.KILO_TEST_HOME.startsWith(join(home, "a")));
  assert.equal(a.PATH, source.PATH);
  assert.equal(source.KILO_DB, "/live.db");
});

test("generated profiles fit UNIX sockets and cleanup removes only owned directories", () => {
  const a = common.temporary("vscode-self-test-user-");
  const b = common.temporary("vscode-self-test-user-");
  try {
    assert.notEqual(a, b);
    assert.ok(basename(a).includes(slug(project)));
    assert.ok(basename(a).includes(slug("unit")));
    if (process.platform !== "win32")
      assert.ok(Buffer.byteLength(join(a, "1.113-main.sock")) <= 103);
    assert.throws(() => common.cleanup([home]), /unowned/);
    assert.ok(existsSync(home));
    common.cleanup([a]);
    assert.equal(existsSync(a), false);
    assert.ok(existsSync(b));
  } finally {
    if (existsSync(a)) common.cleanup([a]);
    common.cleanup([b]);
  }
});

test(
  "real daemon routing, concurrent startup, failed initialization, stop and restart stay isolated",
  { timeout: 60000 },
  async () => {
    try {
      const [a, again, b] = await Promise.all([
        run("start", "--session", "a"),
        run("--session=a", "start"),
        run("start", "--session", "b"),
      ]);
      assert.equal(a.pid, again.pid);
      assert.notEqual(a.pid, b.pid);
      assert.notEqual(a.port, b.port);
      assert.notEqual(a.statePath, b.statePath);
      assert.equal(a.selector, "a");
      assert.equal(b.selector, "b");
      assert.ok(a.tools.includes("launch-vscode"));
      const generic = { ...env, SELF_TEST_SESSION: "a" };
      delete generic.KILO_SELF_TEST_SESSION;
      assert.equal(
        JSON.parse(
          (await exec(process.execPath, [cli, "status"], { env: generic }))
            .stdout,
        ).pid,
        a.pid,
      );
      assert.equal(
        JSON.parse(
          (
            await exec(process.execPath, [cli, "status"], {
              env: { ...generic, KILO_SELF_TEST_SESSION: "b" },
            })
          ).stdout,
        ).pid,
        b.pid,
      );
      const prefix = `vst-${slug(project)}-${slug("a")}-`;
      const base = process.platform === "win32" ? tmpdir() : "/tmp";
      const before = readdirSync(base).filter((name) =>
        name.startsWith(prefix),
      );
      // An explicit file cannot be a profile directory. This fails before Electron starts.
      const failed = await run(
        "launch-vscode",
        "--session",
        "a",
        "--mode",
        "dev",
        "--build",
        "false",
        "--app-path",
        process.execPath,
        "--user-dir",
        process.execPath,
      );
      assert.equal(failed.isError, true);
      const relative = JSON.parse(
        (
          await exec(
            process.execPath,
            [
              cli,
              "launch-vscode",
              "--session",
              "a",
              "--mode",
              "dev",
              "--build",
              "true",
              "--app-path",
              process.execPath,
              "--user-dir",
              "fixture.json",
            ],
            { cwd: home, env },
          )
        ).stdout,
      );
      assert.equal(relative.isError, true);
      assert.match(relative.text, /ENOTDIR/);
      assert.ok(relative.text.includes(config));
      assert.ok(existsSync(process.execPath));
      assert.deepEqual(
        readdirSync(base).filter((name) => name.startsWith(prefix)),
        before,
      );
      const stored = JSON.parse(readFileSync(b.statePath, "utf8"));
      assert.equal(await common.ping(stored), null);
      await assert.rejects(
        common.request(stored, "/stop", {}),
        /identity mismatch/,
      );
      assert.equal(
        (await run("status", "--session", "missing")).running,
        false,
      );
      await run("stop", "--session", "a");
      assert.equal((await run("status", "--session", "b")).pid, b.pid);
      assert.equal((await run("status", "--session", "a")).running, false);
      assert.equal(existsSync(a.statePath), false);
      assert.equal(existsSync(join(dirname(a.statePath), "owner.json")), false);
      assert.notEqual((await run("start", "--session", "a")).pid, a.pid);
    } finally {
      await Promise.all([
        run("stop", "--session", "a"),
        run("stop", "--session", "b"),
      ]);
    }
  },
);

test.after(() => rmSync(home, { recursive: true, force: true }));
