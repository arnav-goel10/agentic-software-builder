#!/usr/bin/env -S npx tsx
// scripts/test/live-followup-run.mjs — two-turn live proof: build, then modify.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dexter-live-followup-"));
const dbPath = path.join(tempDir, "live-followup.sqlite");

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
  if (condition) console.log(`  [pass] ${label}`);
  else { failures += 1; console.error(`  [FAIL] ${label}${detail ? ` — ${detail}` : ""}`); }
}
function snapshotFiles(projectId) {
  const snapshot = getCurrentSnapshotForProject(projectId);
  return snapshot ? JSON.parse(snapshot.files_json) : [];
}
function printSteps(runId, tag) {
  console.log(`[${tag}] steps:`);
  for (const s of listRunSteps(runId).map(toParsedRunStep)) {
    console.log(`  - [${s.status}] ${s.phase} / ${s.title}: ${String(s.detail).slice(0, 120)}`);
  }
}

async function main() {
  const project = createProject({ name: "Live Follow-up Proof" });
  const thread = createThread({ projectId: project.id, title: "Counter" });

  // Turn 1: tiny greenfield build.
  const m1 = createMessage({ threadId: thread.id, role: "user", content: "Build a simple counter: a number display with increment and decrement buttons." });
  const run1 = createRun({ projectId: project.id, threadId: thread.id, triggerMessageId: m1.id, model: "google/auto" });
  console.log("[turn1] building...");
  await executeRun({ runId: run1.id });
  const r1 = getRunById(run1.id);
  console.log(`[turn1] status: ${r1?.status}`);
  printSteps(run1.id, "turn1");
  check("turn 1 completed", r1?.status === "completed", r1?.error ?? "");
  if (r1?.status !== "completed") return report();

  const filesBefore = snapshotFiles(project.id);
  const byNameBefore = new Map(filesBefore.map((f) => [f.name, f.code]));
  console.log(`[turn1] snapshot: ${filesBefore.length} files`);

  // Turn 2: targeted follow-up in the same thread.
  const m2 = createMessage({ threadId: thread.id, role: "user", content: "Add a reset button that sets the count back to zero." });
  const run2 = createRun({ projectId: project.id, threadId: thread.id, triggerMessageId: m2.id, model: "google/auto" });
  console.log("[turn2] modifying...");
  await executeRun({ runId: run2.id });
  const r2 = getRunById(run2.id);
  console.log(`[turn2] status: ${r2?.status}`);
  printSteps(run2.id, "turn2");
  check("turn 2 completed", r2?.status === "completed", r2?.error ?? "");
  if (r2?.status !== "completed") return report();

  const filesAfter = snapshotFiles(project.id);
  const byNameAfter = new Map(filesAfter.map((f) => [f.name, f.code]));
  console.log(`[turn2] snapshot: ${filesAfter.length} files`);

  check("no original file lost", filesBefore.every((f) => byNameAfter.has(f.name)),
    filesBefore.filter((f) => !byNameAfter.has(f.name)).map((f) => f.name).join(", "));
  const resetSomewhere = filesAfter.some((f) => /reset/i.test(f.code));
  check("reset behavior present after follow-up", resetSomewhere);
  const changedCount = filesBefore.filter((f) => byNameAfter.get(f.name) !== byNameBefore.get(f.name)).length;
  console.log(`[turn2] files changed vs turn 1: ${changedCount} of ${filesBefore.length}`);
  check("follow-up did not rewrite everything", changedCount < filesBefore.length, `changed=${changedCount}`);
  report();
}

function report() {
  if (failures > 0) { console.error(`\n[live-followup] FAILED: ${failures} assertion(s).`); process.exit(1); }
  console.log("\n[live-followup] PASSED: two-turn build-then-modify flow works live.");
}

main().catch((e) => { console.error("[live-followup] Uncaught:", e); process.exit(1); });
