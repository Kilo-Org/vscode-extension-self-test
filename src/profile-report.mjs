import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function fail(message) {
  throw new Error(message);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function load(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function required(path, name) {
  if (!path || !existsSync(path)) {
    return fail(`${name} artifact not found: ${path ?? "not provided"}`);
  }

  return path;
}

function add(map, name, value) {
  map.set(name, (map.get(name) ?? 0) + value);
}

function top(map, limit) {
  return [...map.entries()]
    .map(([name, value]) => ({ durationMs: round(value), name }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit);
}

function label(frame) {
  const fn = frame.functionName || "(anonymous)";
  const url = frame.url || "(internal)";
  const line = (frame.lineNumber ?? -1) + 1;
  return `${fn} (${url}:${line})`;
}

function cpuSummary(path, limit) {
  const value = load(path);
  const nodes = new Map(value.nodes.map((node) => [node.id, node]));
  const totals = new Map();
  const samples = value.samples ?? [];
  const deltas = value.timeDeltas ?? [];

  for (let index = 0; index < samples.length; index++) {
    const node = nodes.get(samples[index]);
    if (!node) {
      continue;
    }

    add(totals, label(node.callFrame), (deltas[index] ?? 0) / 1000);
  }

  const busy = new Map(
    [...totals].filter(
      ([name]) =>
        !name.startsWith("(idle)") &&
        !name.startsWith("(program)") &&
        !name.startsWith("(garbage collector)"),
    ),
  );

  return {
    durationMs: round((value.endTime - value.startTime) / 1000),
    nodeCount: value.nodes.length,
    path,
    sampleCount: samples.length,
    topBusySelfTime: top(busy, limit),
    topSelfTime: top(totals, limit),
  };
}

function traceSummary(path, limit, prefix) {
  const value = load(path);
  const events = Array.isArray(value) ? value : value.traceEvents ?? [];
  const spans = events.filter(
    (event) => event.ph === "X" && typeof event.dur === "number",
  );
  const names = new Map();
  const groups = new Map();
  const patterns = [
    ["layout", /Layout|UpdateLayoutTree|RecalculateStyles/i],
    ["paint", /Paint|Composite|Raster/i],
    ["parse", /ParseHTML|ParseAuthorStyleSheet|ParseScript/i],
    ["script", /FunctionCall|EvaluateScript|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|V8/i],
  ];

  for (const event of spans) {
    const duration = event.dur / 1000;
    const name = event.name || "(unnamed)";
    add(names, name, duration);
    for (const [group, pattern] of patterns) {
      if (pattern.test(name)) {
        add(groups, group, duration);
      }
    }
  }

  const tasks = spans
    .filter((event) => event.name === "RunTask" && event.dur >= 50_000)
    .map((event) => ({
      durationMs: round(event.dur / 1000),
      name: event.name,
      timestampMs: round(event.ts / 1000),
    }))
    .sort((a, b) => b.durationMs - a.durationMs);
  const timed = events.filter((event) => typeof event.ts === "number");
  const bounds = timed.reduce(
    (result, event) => ({
      first: Math.min(result.first, event.ts),
      last: Math.max(result.last, event.ts + (event.dur ?? 0)),
    }),
    { first: Number.POSITIVE_INFINITY, last: 0 },
  );
  const first = timed.length ? bounds.first : 0;
  const last = timed.length ? bounds.last : 0;
  const marks = events
    .filter((event) => String(event.name ?? "").startsWith(prefix))
    .map((event) => ({
      name: event.name,
      phase: event.ph,
      timestampMs: round(event.ts / 1000),
    }));
  const begin = marks.find((mark) => mark.name === `${prefix}profile.start`)?.timestampMs;
  const end = marks.find((mark) => mark.name === `${prefix}profile.stop`)?.timestampMs;
  const duration = begin !== undefined && end !== undefined ? end - begin : (last - first) / 1000;

  return {
    durationMs: round(duration),
    eventCount: events.length,
    semanticMarks: marks,
    longTaskCount: tasks.length,
    longTaskTotalMs: round(tasks.reduce((total, task) => total + task.durationMs, 0)),
    longestTasks: tasks.slice(0, limit),
    namedEventTotals: top(names, limit),
    path,
    selectedGroupTotals: top(groups, limit),
    spanCount: spans.length,
  };
}

export function analyzeProfile(input) {
  const dir = input.dir ? resolve(input.dir) : null;
  const metadataPath = input.metadata
    ? resolve(input.metadata)
    : dir
      ? join(dir, "metadata.json")
      : null;
  const metadata = metadataPath && existsSync(metadataPath) ? load(metadataPath) : null;
  if (metadata?.incomplete) {
    return fail(`Capture metadata indicates incomplete output: ${metadataPath}`);
  }

  const trace = input.trace
    ? resolve(input.trace)
    : metadata
      ? metadata.trace
      : dir
        ? join(dir, "trace.json")
        : null;
  const cpu = input.cpu
    ? resolve(input.cpu)
    : metadata
      ? metadata.cpu
      : dir
        ? join(dir, "profile.cpuprofile")
        : null;
  if (metadata?.trace && !existsSync(metadata.trace)) {
    return fail(`Trace artifact declared in metadata not found: ${metadata.trace}`);
  }
  if (metadata?.cpu && !existsSync(metadata.cpu)) {
    return fail(`CPU profile artifact declared in metadata not found: ${metadata.cpu}`);
  }

  const hasTrace = trace && existsSync(trace);
  const hasCpu = cpu && existsSync(cpu);
  if (!hasTrace && !hasCpu) {
    return fail("Provide an artifact directory or an existing trace/CPU profile file.");
  }

  const limit = input.limit ?? 15;
  const warnings = metadata?.traceDataLoss
    ? ["Chromium reported trace data loss; treat trace timing totals as incomplete."]
    : [];
  const capture = metadata
    ? {
        cpu: metadata.cpu,
        endedAt: metadata.endedAt,
        frame: metadata.frame,
        incomplete: metadata.incomplete ?? false,
        mark: metadata.mark,
        markPrefix: metadata.markPrefix ?? "selftest.",
        metricsDelta: metadata.metrics?.delta ?? null,
        startedAt: metadata.startedAt,
        target: metadata.target,
        trace: metadata.trace,
        traceDataLoss: metadata.traceDataLoss,
        traceTarget: metadata.traceTarget,
      }
    : null;
  const report = {
    capture,
    cpu: hasCpu ? cpuSummary(required(cpu, "CPU profile"), limit) : null,
    generatedAt: new Date().toISOString(),
    trace: hasTrace ? traceSummary(required(trace, "Trace"), limit, metadata?.markPrefix ?? "selftest.") : null,
    warnings,
  };

  if (input.path) {
    const path = resolve(input.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
    return { ...report, path };
  }

  return report;
}
