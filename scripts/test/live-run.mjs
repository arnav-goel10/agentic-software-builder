#!/usr/bin/env -S npx tsx
// scripts/test/live-run.mjs — real end-to-end run against the configured
// live provider (DEXTER_MODEL_PROVIDER from .env, e.g. google/Gemini), with
// every validation gate enabled, including the terminal npm build check.
//
// This is the proof run: a fresh brief goes through spec -> plan -> skeleton
// DAG -> fill -> deterministic+LLM repair -> QA against a real model.

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dexter-live-run-"));
const dbPath = path.join(tempDir, "live-run.sqlite");

const { syncRuntimeEnv } = await import("@/lib/server/runtime-env");
syncRuntimeEnv();

process.env.DEXTER_DB_PATH = dbPath;
process.env.DEXTER_ENABLE_STARTER_TEMPLATES = "false";
process.env.DEXTER_ENABLE_SKELETON_VALIDATION = "true";
process.env.DEXTER_ENABLE_FINAL_VALIDATION = "true";
process.env.DEXTER_ENABLE_QA = "true";
process.env.DEXTER_RUN_DISPATCH_ENABLED = "false";

const {
  createProject,
  createThread,
  createMessage,
  createRun,
  getRunById,
  getCurrentSnapshotForProject,
  listRunSteps,
  toParsedRunStep,
} = await import("@/lib/server/repositories");
const { executeRun } = await import("@/lib/server/agent/orchestrator");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [pass] ${label}`);
    return;
  }
  failures += 1;
  console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
}

function printRunSteps(runId) {
  const steps = listRunSteps(runId).map(toParsedRunStep);
  console.log("[live-run] Run steps:");
  for (const step of steps) {
    console.log(`  - [${step.status}] ${step.phase} / ${step.title}: ${String(step.detail).slice(0, 160)}`);
  }
}

const BRIEF =
  "Build a notes app with folders: create and delete folders, add notes inside a folder, pin important notes to the top, and search across every note with live results.";

async function main() {
  console.log(`[live-run] Provider: ${process.env.DEXTER_MODEL_PROVIDER}`);
  console.log(`[live-run] Scratch DB: ${dbPath}`);
  const project = createProject({ name: "Live Notes Run" });
  const thread = createThread({ projectId: project.id, title: "Build a notes app" });
  const triggerMessage = createMessage({ threadId: thread.id, role: "user", content: BRIEF });
  const run = createRun({
    projectId: project.id,
    threadId: thread.id,
    triggerMessageId: triggerMessage.id,
    model: "google/gemini-2.5-flash",
  });
  console.log(`[live-run] run=${run.id} — executing against the live provider...`);
  const startedAt = Date.now();
  await executeRun({ runId: run.id });
  const seconds = Math.round((Date.now() - startedAt) / 1000);

  const finishedRun = getRunById(run.id);
  console.log(`[live-run] Finished in ${seconds}s with status: ${finishedRun?.status}`);
  printRunSteps(run.id);

  console.log("\n[live-run] Assertions:");
  check("run status is completed", finishedRun?.status === "completed", `actual=${finishedRun?.status} error=${finishedRun?.error ?? "(none)"}`);

  const snapshot = getCurrentSnapshotForProject(project.id);
  const files = snapshot ? JSON.parse(snapshot.files_json) : [];
  const names = files.map((f) => f.name ?? f.path);
  console.log(`[live-run] Snapshot has ${files.length} files: ${names.join(", ")}`);
  for (const wanted of ["index.html", "src/main.jsx", "src/index.css", "package.json", "src/App.jsx"]) {
    check(`snapshot includes ${wanted}`, names.includes(wanted));
  }
  const unfilled = [];
  for (const f of files) {
    if (/TODO:\s*FILL_IN/.test(f.code ?? "")) unfilled.push(f.path);
  }
  check("no unfilled TODO regions remain", unfilled.length === 0, unfilled.join(", "));

  if (failures > 0) {
    console.error(`\n[live-run] FAILED: ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\n[live-run] PASSED: real-provider end-to-end run succeeded.");
}

main().catch((error) => {
  console.error("[live-run] Uncaught failure:", error);
  process.exit(1);
});
