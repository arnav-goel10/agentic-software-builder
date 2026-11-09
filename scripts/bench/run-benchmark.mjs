#!/usr/bin/env node
// Benchmark: give the engine a set of briefs and count how many become apps
// that install, build and pass a smoke test.
//
//   npm run bench -- --provider mock --tasks scripts/bench/tasks-stub.json
//   npm run bench -- --provider google --limit 3
//   npm run bench -- --provider local --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:14b
//   npm run bench -- --provider openrouter            (paid, uses .env models)
//
// Each task runs the engine in its own process (scripts/bench/run-task.mjs)
// with every gate on, under a hard wall-clock limit. A run counts as a pass
// only if the engine reports completed AND this script, working from the
// files the engine saved, independently gets:
//   1. npm install  exit 0
//   2. npm run build  exit 0
//   3. smoke test: vite-spa serves the built index.html and every script and
//      stylesheet it references with HTTP 200; express-fullstack also passes
//      `npm run check:server` and answers GET / with a status below 500.
//
// Before any task runs, a preflight checks that the provider is configured
// and reachable and that every configured model exists. If it fails, the
// script stops with exit code 2 and writes no results, so a dead endpoint can
// never be recorded as N engine failures again (see docs/benchmark.md).
//
// Output: bench-results/<provider>-<timestamp>/
//   summary.json, summary.md
//   <task-id>/task.json, engine.log, engine.json, verify.log, result.json

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PROVIDERS = ["mock", "google", "openrouter", "local"];
const MODEL_PHASE_KEYS = [
  "SPEC",
  "ARCHITECT",
  "SCAFFOLD",
  "CODER",
  "CODER_LENGTH_FALLBACK",
  "REPAIR_PRIMARY",
  "REPAIR_ESCALATION",
  "QA",
  "FINALIZE",
];

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const args = {
    provider: "mock",
    tasks: null,
    only: null,
    limit: null,
    out: null,
    taskTimeoutMin: null,
    baseUrl: "http://127.0.0.1:11434/v1",
    model: null,
    priceIn: null,
    priceOut: null,
    skipVerify: false,
    preflightOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const take = () => {
      i += 1;
      return value;
    };
    if (flag === "--provider") args.provider = take();
    else if (flag === "--tasks") args.tasks = take();
    else if (flag === "--only") args.only = take().split(",").map((s) => s.trim());
    else if (flag === "--limit") args.limit = Number.parseInt(take(), 10);
    else if (flag === "--out") args.out = take();
    else if (flag === "--task-timeout-min") args.taskTimeoutMin = Number(take());
    else if (flag === "--base-url") args.baseUrl = take();
    else if (flag === "--model") args.model = take();
    else if (flag === "--price-in") args.priceIn = Number(take());
    else if (flag === "--price-out") args.priceOut = Number(take());
    else if (flag === "--skip-verify") args.skipVerify = true;
    else if (flag === "--preflight-only") args.preflightOnly = true;
    else if (flag === "--help" || flag === "-h") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 28).join("\n"));
      process.exit(0);
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!PROVIDERS.includes(args.provider)) {
    throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}`);
  }
  args.tasks ??= args.provider === "mock" ? "scripts/bench/tasks-stub.json" : "scripts/bench/tasks.json";
  args.taskTimeoutMin ??= args.provider === "mock" ? 5 : 30;
  return args;
}

// ------------------------------------------------------------- environment

function readDotEnv() {
  const values = {};
  for (const name of [".env", ".env.local"]) {
    const file = path.join(REPO_ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return values;
}

function setting(key, dotEnv) {
  return process.env[key]?.trim() || dotEnv[key]?.trim() || "";
}

// Environment for the engine process. Every gate is on, starter templates
// are off, and the build cache is off so each run installs from scratch.
function engineEnv(args, task) {
  const env = {
    ...process.env,
    DEXTER_ENABLE_STARTER_TEMPLATES: "false",
    DEXTER_ENABLE_SKELETON_VALIDATION: "true",
    DEXTER_ENABLE_FINAL_VALIDATION: "true",
    DEXTER_ENABLE_QA: "true",
    DEXTER_ENABLE_FIX_DAG: "true",
    DEXTER_SKIP_TERMINAL_BUILD: "false",
    DEXTER_BUILD_CACHE_ENABLED: "false",
  };
  if (args.provider === "mock") {
    if (!task.mockFixtures) {
      throw new Error(`task ${task.id} has no mockFixtures; the stub model can only replay fixtures`);
    }
    env.DEXTER_MODEL_PROVIDER = "mock";
    env.DEXTER_MOCK_FIXTURES = path.resolve(REPO_ROOT, task.mockFixtures);
  } else if (args.provider === "local") {
    // Any OpenAI-compatible server (Ollama, llama.cpp, LM Studio, vLLM)
    // through the engine's OpenAI-style client, one model for every phase.
    env.DEXTER_MODEL_PROVIDER = "openrouter";
    env.OPENROUTER_BASE_URL = args.baseUrl;
    env.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY_LOCAL || "local";
    env.OPENROUTER_REASONING_PHASES = "";
    env.OPENROUTER_PROMPT_CACHE_STRATEGY = "auto";
    for (const key of MODEL_PHASE_KEYS) env[`OPENROUTER_MODELS_${key}`] = args.model;
  } else {
    env.DEXTER_MODEL_PROVIDER = args.provider;
  }
  return env;
}

// --------------------------------------------------------------- preflight

async function getJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

function configuredModels(prefix, dotEnv, defaults = []) {
  const models = new Set(defaults);
  for (const key of MODEL_PHASE_KEYS) {
    for (const model of setting(`${prefix}${key}`, dotEnv).split(",")) {
      if (model.trim()) models.add(model.trim());
    }
  }
  return [...models];
}

async function preflight(args, tasks) {
  const dotEnv = readDotEnv();
  if (!fs.existsSync(TSX_BIN)) throw new Error("node_modules missing: run npm ci first");

  if (args.provider === "mock") {
    for (const task of tasks) {
      const dir = task.mockFixtures && path.resolve(REPO_ROOT, task.mockFixtures);
      if (!dir || !fs.existsSync(dir)) throw new Error(`task ${task.id}: mock fixtures not found (${task.mockFixtures})`);
    }
    return "stub model replays recorded fixtures";
  }

  if (args.provider === "local") {
    if (!args.model) throw new Error("--provider local needs --model <name>");
    let listing;
    try {
      listing = await getJson(`${args.baseUrl.replace(/\/+$/, "")}/models`);
    } catch (error) {
      throw new Error(`local server not reachable at ${args.baseUrl} (${error.message})`);
    }
    const ids = (listing.data ?? []).map((m) => m.id);
    if (!ids.includes(args.model)) {
      throw new Error(`model ${args.model} not served at ${args.baseUrl}; available: ${ids.join(", ") || "none"}`);
    }
    return `local ${args.model} at ${args.baseUrl}`;
  }

  if (args.provider === "google") {
    const key = setting("GEMINI_API_KEY", dotEnv);
    if (!key) throw new Error("GEMINI_API_KEY is not set (env or .env)");
    const base = setting("GEMINI_BASE_URL", dotEnv) || "https://generativelanguage.googleapis.com/v1beta";
    const listing = await getJson(`${base}/models?pageSize=1000`, { "x-goog-api-key": key });
    const ids = new Set((listing.models ?? []).map((m) => String(m.name).replace(/^models\//, "")));
    const wanted = configuredModels("GEMINI_MODELS_", dotEnv, setting("GEMINI_MODELS_DEFAULT", dotEnv).split(",").filter(Boolean));
    const missing = wanted.filter((m) => !ids.has(m));
    if (missing.length) throw new Error(`Gemini models not available to this key: ${missing.join(", ")}`);
    return `google ${wanted.join(", ")}`;
  }

  // openrouter
  if (!setting("OPENROUTER_API_KEY", dotEnv)) throw new Error("OPENROUTER_API_KEY is not set (env or .env)");
  const base = setting("OPENROUTER_BASE_URL", dotEnv) || "https://openrouter.ai/api/v1";
  const listing = await getJson(`${base}/models`);
  const ids = new Set((listing.data ?? []).map((m) => m.id));
  const wanted = configuredModels("OPENROUTER_MODELS_", dotEnv);
  if (wanted.length === 0) throw new Error("no OPENROUTER_MODELS_* configured");
  const missing = wanted.filter((m) => !ids.has(m.replace(/:(nitro|floor|online)$/, "")));
  if (missing.length) throw new Error(`OpenRouter no longer lists: ${missing.join(", ")}`);
  return `openrouter ${wanted.join(", ")}`;
}

// ---------------------------------------------------------------- processes

// Command lines are logged relative to the repo so committed logs carry no
// machine-specific paths.
const shown = (parts) => parts.join(" ").split(`${REPO_ROOT}${path.sep}`).join("");

function runLogged({ command, args, cwd, env, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const log = fs.createWriteStream(logFile, { flags: "a" });
    log.write(`\n$ ${shown([command, ...args])}   (cwd ${path.relative(REPO_ROOT, cwd) || "."})\n`);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      log.end(`\n[exit ${code}${timedOut ? ", killed at timeout" : ""}, ${Math.round(durationMs / 1000)}s]\n`, () =>
        resolve({ code, timedOut, durationMs })
      );
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      log.end(`\n[spawn error ${error.message}]\n`, () => resolve({ code: null, timedOut, durationMs: Date.now() - startedAt }));
    });
  });
}

function killGroup(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }, 2000).unref();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Start a long-running server, wait until it answers, run checks, stop it.
async function withServer({ command, args, cwd, env, logFile, port }, check) {
  const log = fs.createWriteStream(logFile, { flags: "a" });
  log.write(`\n$ ${shown([command, ...args])}   (port ${port})\n`);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let exited = false;
  child.on("close", () => {
    exited = true;
  });
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !exited) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (exited) return { ok: false, reason: "server exited before answering" };
    return await check(`http://127.0.0.1:${port}`);
  } finally {
    killGroup(child);
    await new Promise((r) => (exited ? r() : child.once("close", r)));
    log.end();
  }
}

// ------------------------------------------------------------- verification

async function checkStaticSite(baseUrl) {
  const index = await fetch(`${baseUrl}/`);
  const html = await index.text();
  if (index.status !== 200) return { ok: false, reason: `GET / -> ${index.status}` };
  const assets = [...html.matchAll(/<(?:script[^>]+src|link[^>]+href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  if (!assets.some((a) => a.endsWith(".js"))) return { ok: false, reason: "index.html references no built script" };
  for (const asset of assets) {
    const url = asset.startsWith("http") ? asset : `${baseUrl}${asset.startsWith("/") ? "" : "/"}${asset}`;
    const response = await fetch(url);
    const body = await response.arrayBuffer();
    if (response.status !== 200 || body.byteLength === 0) {
      return { ok: false, reason: `GET ${asset} -> ${response.status} (${body.byteLength} bytes)` };
    }
  }
  return { ok: true, reason: `index.html and ${assets.length} asset(s) served` };
}

// Every literal, parameter-free /api path the server code mentions. A
// generated API passes when none of them returns 5xx and at least one GET
// returns 2xx, which means a route and its database module actually ran.
function apiPaths(appDir) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c|m)?js$/.test(entry.name)) {
        for (const m of fs.readFileSync(full, "utf8").matchAll(/["'`](\/api(?:\/[A-Za-z0-9_-]+)*)\/?["'`]/g)) found.add(m[1]);
      }
    }
  };
  walk(path.join(appDir, "server"));
  return [...found].sort();
}

async function checkApiRoutes(baseUrl, appDir) {
  const paths = apiPaths(appDir);
  if (paths.length === 0) return { ok: false, reason: "server code declares no /api routes" };
  const seen = [];
  for (const route of paths) {
    const response = await fetch(`${baseUrl}${route}`);
    await response.arrayBuffer();
    seen.push(`${route} ${response.status}`);
    if (response.status >= 500) return { ok: false, reason: `GET ${route} -> ${response.status}` };
  }
  const ok = seen.some((s) => / 2\d\d$/.test(s));
  return { ok, reason: ok ? `API answered: ${seen.join(", ")}` : `no /api GET returned 2xx: ${seen.join(", ")}` };
}

export async function verifyApp(appDir, logFile) {
  const env = { ...process.env, CI: "1", NODE_ENV: "development" };
  const stages = {};
  const pkgPath = path.join(appDir, "package.json");
  if (!fs.existsSync(pkgPath)) return { outcome: "install_failed", stages, reason: "no package.json in snapshot" };
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const fullstack = Boolean(pkg.scripts?.["check:server"]);

  const install = await runLogged({
    command: "npm",
    args: ["install", "--no-audit", "--no-fund", "--include=dev"],
    cwd: appDir,
    env,
    logFile,
    timeoutMs: 5 * 60_000,
  });
  stages.install = install;
  if (install.code !== 0) return { outcome: "install_failed", stages, reason: `npm install exit ${install.code}` };

  const build = await runLogged({ command: "npm", args: ["run", "build"], cwd: appDir, env, logFile, timeoutMs: 3 * 60_000 });
  stages.build = build;
  if (build.code !== 0) return { outcome: "build_failed", stages, reason: `npm run build exit ${build.code}` };

  if (fullstack) {
    const serverCheck = await runLogged({ command: "npm", args: ["run", "check:server"], cwd: appDir, env, logFile, timeoutMs: 60_000 });
    stages.checkServer = serverCheck;
    if (serverCheck.code !== 0) return { outcome: "smoke_failed", stages, reason: `check:server exit ${serverCheck.code}` };
    const port = await freePort();
    const smoke = await withServer(
      { command: "node", args: ["server/index.js"], cwd: appDir, env: { ...env, PORT: String(port) }, logFile, port },
      (baseUrl) => checkApiRoutes(baseUrl, appDir)
    );
    stages.smoke = smoke;
    if (!smoke.ok) return { outcome: "smoke_failed", stages, reason: smoke.reason };
  }

  const vite = path.join(appDir, "node_modules", ".bin", "vite");
  if (fs.existsSync(vite)) {
    const port = await freePort();
    const smoke = await withServer(
      { command: vite, args: ["preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], cwd: appDir, env, logFile, port },
      checkStaticSite
    );
    stages.preview = smoke;
    if (!smoke.ok) return { outcome: "smoke_failed", stages, reason: smoke.reason };
  } else if (!fullstack) {
    return { outcome: "smoke_failed", stages, reason: "no vite binary to serve the build" };
  }
  return { outcome: "pass", stages, reason: "installed, built and served" };
}

// ------------------------------------------------------------------- report

function summarize(results, meta) {
  const outcomes = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const categories = {};
  for (const r of results) {
    const c = (categories[r.category] ??= { total: 0, pass: 0 });
    c.total += 1;
    if (r.outcome === "pass") c.pass += 1;
  }
  const tokens = { calls: 0, failedCalls: 0, inputChars: 0, outputChars: 0, inputTokens: 0, outputTokens: 0, reportedUsageCalls: 0 };
  for (const r of results) {
    for (const call of r.modelCalls ?? []) {
      tokens.calls += 1;
      if (!call.ok) tokens.failedCalls += 1;
      tokens.inputChars += call.inputChars ?? 0;
      tokens.outputChars += call.outputChars ?? 0;
      if (call.usage) {
        tokens.reportedUsageCalls += 1;
        tokens.inputTokens += call.usage.inputTokens ?? 0;
        tokens.outputTokens += call.usage.outputTokens ?? 0;
      }
    }
  }
  const cost =
    meta.priceIn != null && meta.priceOut != null
      ? (tokens.inputTokens * meta.priceIn + tokens.outputTokens * meta.priceOut) / 1e6
      : null;
  const pass = outcomes.pass ?? 0;
  return { ...meta, total: results.length, pass, passRate: results.length ? pass / results.length : 0, outcomes, categories, tokens, costUsd: cost, results };
}

function toMarkdown(summary) {
  const lines = [
    `# Benchmark ${summary.startedAt}`,
    "",
    `- Provider: ${summary.provider} (${summary.preflight})`,
    `- Tasks: ${summary.tasksFile}, ${summary.total} run`,
    `- Pass (completed + npm install + npm run build + smoke test): **${summary.pass} / ${summary.total}**`,
    `- Outcomes: ${Object.entries(summary.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `- Model calls: ${summary.tokens.calls} (${summary.tokens.failedCalls} failed), prompt ${summary.tokens.inputChars} chars, response ${summary.tokens.outputChars} chars`,
    `- Provider-reported tokens: ${summary.tokens.inputTokens} in, ${summary.tokens.outputTokens} out (${summary.tokens.reportedUsageCalls} calls reported usage)`,
    summary.costUsd != null ? `- Cost at the given prices: $${summary.costUsd.toFixed(4)}` : "- Cost: not computed (pass --price-in and --price-out, USD per million tokens)",
    `- Wall time: ${Math.round(summary.wallMs / 1000)}s`,
    "",
    "| Task | Category | Outcome | Engine | Engine time | Files | Calls | Reason |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- |",
  ];
  for (const r of summary.results) {
    lines.push(
      `| ${r.id} | ${r.category} | ${r.outcome} | ${r.engineStatus} | ${Math.round(r.engineMs / 1000)}s | ${r.files} | ${r.modelCalls.length} | ${String(r.reason).replace(/\|/g, "/").slice(0, 120)} |`
    );
  }
  return `${lines.join("\n")}\n`;
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let tasks = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, args.tasks), "utf8"));
  if (args.only) tasks = tasks.filter((t) => args.only.includes(t.id));
  if (args.limit) tasks = tasks.slice(0, args.limit);
  if (tasks.length === 0) throw new Error("no tasks selected");

  let preflightNote;
  try {
    preflightNote = await preflight(args, tasks);
  } catch (error) {
    console.error(`[bench] preflight failed, nothing was run: ${error.message}`);
    process.exit(2);
  }
  if (args.preflightOnly) {
    console.log(`[bench] preflight ok: ${preflightNote}; ${tasks.length} task(s) selected`);
    return;
  }

  const startedAt = new Date().toISOString();
  const outDir = path.resolve(REPO_ROOT, args.out ?? path.join("bench-results", `${args.provider}-${startedAt.replace(/[:.]/g, "-")}`));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`[bench] ${tasks.length} task(s), provider ${args.provider} (${preflightNote})`);
  console.log(`[bench] results -> ${path.relative(REPO_ROOT, outDir)}`);

  const wallStart = Date.now();
  const results = [];
  for (const [index, task] of tasks.entries()) {
    const taskDir = path.join(outDir, task.id);
    fs.rmSync(taskDir, { recursive: true, force: true });
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.json"), `${JSON.stringify(task, null, 2)}\n`);
    console.log(`[bench] (${index + 1}/${tasks.length}) ${task.id}: ${task.brief.slice(0, 70)}`);

    const engineRun = await runLogged({
      command: TSX_BIN,
      args: [path.join(REPO_ROOT, "scripts", "bench", "run-task.mjs"), path.join(taskDir, "task.json"), taskDir],
      cwd: REPO_ROOT,
      env: engineEnv(args, task),
      logFile: path.join(taskDir, "engine.log"),
      timeoutMs: args.taskTimeoutMin * 60_000,
    });
    const enginePath = path.join(taskDir, "engine.json");
    const engine = fs.existsSync(enginePath) ? JSON.parse(fs.readFileSync(enginePath, "utf8")) : null;

    let outcome;
    let reason;
    let stages = {};
    if (engineRun.timedOut) {
      outcome = "timeout";
      reason = `engine exceeded ${args.taskTimeoutMin} min`;
    } else if (!engine || engine.status === "harness_error") {
      outcome = "harness_error";
      reason = engine?.error?.split("\n")[0] ?? `engine process exit ${engineRun.code}, no engine.json`;
    } else if (engine.status !== "completed") {
      outcome = "engine_failed";
      reason = engine.error ?? engine.status;
    } else if (args.skipVerify) {
      outcome = "unverified";
      reason = "verification skipped";
    } else {
      const verified = await verifyApp(path.join(taskDir, "app"), path.join(taskDir, "verify.log"));
      ({ outcome, reason, stages } = verified);
    }

    const result = {
      id: task.id,
      category: task.category,
      outcome,
      reason: String(reason ?? "").split("\n")[0].slice(0, 500),
      engineStatus: engine?.status ?? "none",
      engineMs: engine?.durationMs ?? engineRun.durationMs,
      files: engine?.files?.length ?? 0,
      stages,
      modelCalls: engine?.modelCalls ?? [],
    };
    fs.writeFileSync(path.join(taskDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    results.push(result);
    console.log(`[bench]   -> ${outcome}: ${result.reason}`);
  }

  const summary = summarize(results, {
    startedAt,
    provider: args.provider,
    preflight: preflightNote,
    tasksFile: args.tasks,
    wallMs: Date.now() - wallStart,
    priceIn: args.priceIn,
    priceOut: args.priceOut,
  });
  fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "summary.md"), toMarkdown(summary));
  console.log(`[bench] pass ${summary.pass}/${summary.total}  ${JSON.stringify(summary.outcomes)}`);
  console.log(`[bench] summary -> ${path.relative(REPO_ROOT, path.join(outDir, "summary.md"))}`);
  process.exit(summary.pass === summary.total ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[bench] ${error.stack || error.message}`);
    process.exit(2);
  });
}
