#!/usr/bin/env -S npx tsx
// One benchmark task in its own process: run the engine on one brief, then
// write what it produced to disk. The parent (run-benchmark.mjs) owns the
// timeout and the independent install/build/smoke check.
//
// Usage (normally only called by run-benchmark.mjs):
//   tsx scripts/bench/run-task.mjs <task.json> <outDir>
//
// Writes into <outDir>:
//   engine.json  run status, error, duration, steps, model-call ledger
//   app/         the final snapshot's files, exactly as the engine stored them

import fs from "node:fs";
import path from "node:path";

const [taskPath, outDir] = process.argv.slice(2);
if (!taskPath || !outDir) {
  console.error("usage: run-task.mjs <task.json> <outDir>");
  process.exit(2);
}

const task = JSON.parse(fs.readFileSync(taskPath, "utf8"));
fs.mkdirSync(outDir, { recursive: true });

// Merge the project's .env first so the overrides the parent passed in the
// environment win (same pattern as scripts/test/mock-run.mjs).
const { syncRuntimeEnv } = await import("@/lib/server/runtime-env");
const parentEnv = { ...process.env };
syncRuntimeEnv();
for (const [key, value] of Object.entries(parentEnv)) {
  if (key.startsWith("DEXTER_") || key.startsWith("OPENROUTER_") || key.startsWith("GEMINI_")) {
    process.env[key] = value;
  }
}
process.env.DEXTER_DB_PATH = path.join(outDir, "engine.sqlite");
process.env.DEXTER_RUN_DISPATCH_ENABLED = "false";

const repositories = await import("@/lib/server/repositories");
const { executeRun } = await import("@/lib/server/agent/orchestrator");
const { getModelCallLedger, resetModelCallLedger } = await import(
  "@/lib/server/agent/model-provider"
);

function writeSnapshot(files, appDir) {
  const root = path.resolve(appDir);
  for (const file of files) {
    const name = file.name ?? file.path;
    if (typeof name !== "string" || typeof file.code !== "string") continue;
    const target = path.resolve(root, name);
    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`snapshot path escapes the app directory: ${name}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.code);
  }
}

const result = {
  taskId: task.id,
  provider: process.env.DEXTER_MODEL_PROVIDER,
  status: "harness_error",
  error: null,
  durationMs: 0,
  steps: [],
  files: [],
  modelCalls: [],
};

const startedAt = Date.now();
try {
  resetModelCallLedger();
  const project = repositories.createProject({ name: `bench ${task.id}` });
  const thread = repositories.createThread({ projectId: project.id, title: task.id });
  const message = repositories.createMessage({
    threadId: thread.id,
    role: "user",
    content: task.brief,
  });
  const run = repositories.createRun({
    projectId: project.id,
    threadId: thread.id,
    triggerMessageId: message.id,
    model: process.env.DEXTER_MODEL_PROVIDER ?? "unknown",
  });

  console.log(`[task ${task.id}] run=${run.id} provider=${process.env.DEXTER_MODEL_PROVIDER}`);
  await executeRun({ runId: run.id });

  const finished = repositories.getRunById(run.id);
  result.status = finished?.status ?? "harness_error";
  result.error = finished?.error ?? null;
  result.steps = repositories
    .listRunSteps(run.id)
    .map(repositories.toParsedRunStep)
    .map((step) => ({
      phase: step.phase,
      status: step.status,
      title: step.title,
      detail: String(step.detail ?? "").slice(0, 400),
    }));

  const snapshot = repositories.getCurrentSnapshotForProject(project.id);
  if (snapshot) {
    const files = JSON.parse(snapshot.files_json);
    writeSnapshot(files, path.join(outDir, "app"));
    result.files = files.map((file) => file.name ?? file.path).sort();
  }
} catch (error) {
  result.status = "harness_error";
  result.error = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[task ${task.id}] harness error: ${result.error}`);
} finally {
  result.durationMs = Date.now() - startedAt;
  result.modelCalls = getModelCallLedger();
  fs.writeFileSync(path.join(outDir, "engine.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `[task ${task.id}] engine status=${result.status} files=${result.files.length} calls=${result.modelCalls.length} ${Math.round(result.durationMs / 1000)}s`
  );
}

process.exit(0);
