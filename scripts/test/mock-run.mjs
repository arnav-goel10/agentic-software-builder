#!/usr/bin/env -S npx tsx
// scripts/test/mock-run.mjs — keyless end-to-end harness for the agent engine.
//
// Boots a scratch sqlite DB, points the model layer at the "mock" provider
// (deterministic JSON fixtures, no API keys required), scripts a "todo app"
// brief through the full spec -> plan -> skeleton DAG -> skeleton fill ->
// region fill -> finalize pipeline via executeRun, and asserts the run
// completed with the expected files and fully-filled regions.
//
// Run via `npm run test:loop` (invokes `tsx scripts/test/mock-run.mjs`).

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures", "todo-app");

if (!fs.existsSync(FIXTURES_DIR)) {
  console.error(`[mock-run] Fixtures directory not found: ${FIXTURES_DIR}`);
  process.exit(1);
}

// Scratch sqlite DB, isolated per run so this never touches the real dev DB.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dexter-mock-run-"));
const dbPath = path.join(tempDir, "mock-run.sqlite");

// --- Environment setup -----------------------------------------------------
// syncRuntimeEnv() lazily merges the project's real .env files into
// process.env the first time any model-provider/env-reading code calls it.
// If the real .env already pins DEXTER_MODEL_PROVIDER (e.g. to "google" for
// manual testing), that merge would clobber our "mock" override the first
// time it runs. Force the merge to happen now, up front, then apply our
// overrides on top — later calls hit syncRuntimeEnv's cached-signature fast
// path and just return process.env as-is, so our overrides stick for the
// rest of this process. This never reads, writes, or otherwise touches any
// .env file on disk.
const { syncRuntimeEnv } = await import("@/lib/server/runtime-env");
syncRuntimeEnv();

process.env.DEXTER_DB_PATH = dbPath;
process.env.DEXTER_MODEL_PROVIDER = "mock";
process.env.DEXTER_MOCK_FIXTURES = FIXTURES_DIR;
process.env.DEXTER_ENABLE_STARTER_TEMPLATES = "false";
// Deterministic contract-conformance heuristics (validateSkeletonWorkingTree)
// are exercised by validation.ts's own tests; this harness is scoped to
// proving the mock-provider fill pipeline and deterministic entrypoint
// seeding work end-to-end, so skeleton validation is disabled alongside the
// two gates named in the spec to keep the harness fixture-driven rather than
// regex-heuristic-driven.
process.env.DEXTER_ENABLE_SKELETON_VALIDATION = "false";
process.env.DEXTER_ENABLE_FINAL_VALIDATION = "false";
process.env.DEXTER_ENABLE_QA = "false";
process.env.DEXTER_RUN_DISPATCH_ENABLED = "false";

// --- Imports (after env is pinned) -----------------------------------------
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

// --- Harness helpers ---------------------------------------------------

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
  console.error("[mock-run] Run steps:");
  for (const step of steps) {
    console.error(`  - [${step.status}] ${step.phase} / ${step.title}: ${step.detail}`);
  }
}

// BEGIN_FILL:<id> ... END_FILL:<id> blocks, mirroring the pattern used by
// the orchestrator/generators for region extraction.
const FILL_REGION_PATTERN =
  /\/\/\s*BEGIN_FILL:\s*([A-Za-z0-9_-]+)[^\n]*\n([\s\S]*?)\/\/\s*END_FILL:\s*\1/g;

function findUnfilledRegions(fileName, code) {
  const unfilled = [];
  for (const match of code.matchAll(FILL_REGION_PATTERN)) {
    const regionId = match[1];
    const body = match[2];
    if (/TODO:\s*FILL_IN/.test(body)) {
      unfilled.push(`${fileName}#${regionId}`);
    }
  }
  return unfilled;
}

// --- Scenario ------------------------------------------------------------

async function main() {
  console.log(`[mock-run] Scratch DB: ${dbPath}`);
  console.log(`[mock-run] Fixtures:   ${FIXTURES_DIR}`);

  const project = createProject({ name: "Mock Todo App Run" });
  const thread = createThread({ projectId: project.id, title: "Build a todo app" });
  const triggerMessage = createMessage({
    threadId: thread.id,
    role: "user",
    content:
      "Build a simple todo app where I can add a task, mark it complete, and remove it from the list.",
  });
  const run = createRun({
    projectId: project.id,
    threadId: thread.id,
    triggerMessageId: triggerMessage.id,
    model: "mock/mock-model",
  });

  console.log(`[mock-run] Created project=${project.id} thread=${thread.id} run=${run.id}`);
  console.log("[mock-run] Executing run against the mock provider...");

  await executeRun({ runId: run.id });

  const finishedRun = getRunById(run.id);
  if (!finishedRun) {
    console.error("[mock-run] Run vanished after execution (unexpected).");
    process.exit(1);
  }

  console.log(`[mock-run] Run finished with status: ${finishedRun.status}`);

  console.log("\n[mock-run] Assertions:");
  check("run status is completed", finishedRun.status === "completed", `actual=${finishedRun.status} error=${finishedRun.error ?? "(none)"}`);

  if (finishedRun.status !== "completed") {
    printRunSteps(run.id);
    return;
  }

  const snapshot = getCurrentSnapshotForProject(project.id);
  check("project has a current snapshot", Boolean(snapshot));

  if (!snapshot) {
    return;
  }

  /** @type {Array<{ name: string; code: string; language?: string }>} */
  const files = JSON.parse(snapshot.files_json);
  const fileNames = files.map((file) => file.name).sort();
  console.log(`[mock-run] Snapshot has ${files.length} file(s): ${fileNames.join(", ")}`);

  const byName = new Map(files.map((file) => [file.name, file]));

  for (const required of ["index.html", "src/main.jsx", "src/App.jsx", "src/index.css", "package.json"]) {
    check(`working files include ${required}`, byName.has(required));
  }

  const mainJsx = byName.get("src/main.jsx");
  if (mainJsx) {
    check(
      "src/main.jsx renders src/App.jsx",
      /from\s+["']\.\/App["']/.test(mainJsx.code),
      mainJsx.code
    );
    check(
      "src/main.jsx imports ./index.css",
      /import\s+["']\.\/index\.css["']/.test(mainJsx.code)
    );
  }

  let unfilledRegions = [];
  let totalRegions = 0;
  for (const file of files) {
    const matches = Array.from(file.code.matchAll(FILL_REGION_PATTERN));
    totalRegions += matches.length;
    unfilledRegions = unfilledRegions.concat(findUnfilledRegions(file.name, file.code));
  }
  console.log(`[mock-run] Found ${totalRegions} BEGIN_FILL region(s) across all files.`);
  check("at least one BEGIN_FILL region was generated", totalRegions > 0);
  check(
    "every BEGIN_FILL region was filled (no leftover TODO: FILL_IN)",
    unfilledRegions.length === 0,
    unfilledRegions.join(", ")
  );

  const appJsx = byName.get("src/App.jsx");
  if (appJsx) {
    check("src/App.jsx fill includes todo state logic", /useState/.test(appJsx.code) && /handleAdd/.test(appJsx.code));
  }
  const todoList = byName.get("src/components/TodoList.jsx");
  check("src/components/TodoList.jsx was generated and filled", Boolean(todoList));
  if (todoList) {
    check("src/components/TodoList.jsx fill includes the rendered list", /todos\.map/.test(todoList.code));
  }
}

function reportAndExit() {
  console.log("");
  if (failures > 0) {
    console.error(`[mock-run] FAILED: ${failures} assertion(s) did not pass.`);
    process.exitCode = 1;
    return;
  }
  console.log("[mock-run] PASSED: all assertions succeeded.");
}

// --- Scenario 2: validation + QA gates on, terminal build skipped ---------
//
// Scenario 1 above proves the mock fill pipeline end-to-end with every
// post-fill gate disabled. This scenario proves the opposite edge: static
// validation and the QA gate (including its repair loop) both run for
// real against the mock provider's output, while DEXTER_SKIP_TERMINAL_BUILD
// skips only the slow npm install/build sub-step so the harness stays fast
// and keyless. It asserts the run still completes and that QA actually ran.

async function runScenarioTwo() {
  console.log("\n[mock-run] Scenario 2: validation + QA gates on, terminal build skipped");

  process.env.DEXTER_ENABLE_SKELETON_VALIDATION = "false";
  process.env.DEXTER_ENABLE_FINAL_VALIDATION = "true";
  process.env.DEXTER_ENABLE_QA = "true";
  process.env.DEXTER_ENABLE_FIX_DAG = "true";
  process.env.DEXTER_SKIP_TERMINAL_BUILD = "true";

  const project = createProject({ name: "Mock Todo App Run (gates on)" });
  const thread = createThread({ projectId: project.id, title: "Build a todo app" });
  const triggerMessage = createMessage({
    threadId: thread.id,
    role: "user",
    content:
      "Build a simple todo app where I can add a task, mark it complete, and remove it from the list.",
  });
  const run = createRun({
    projectId: project.id,
    threadId: thread.id,
    triggerMessageId: triggerMessage.id,
    model: "mock/mock-model",
  });

  console.log(`[mock-run] Created project=${project.id} thread=${thread.id} run=${run.id}`);
  console.log("[mock-run] Executing run against the mock provider (gates on)...");

  await executeRun({ runId: run.id });

  const finishedRun = getRunById(run.id);
  if (!finishedRun) {
    console.error("[mock-run] Scenario 2 run vanished after execution (unexpected).");
    failures += 1;
    return;
  }

  console.log(`[mock-run] Scenario 2 run finished with status: ${finishedRun.status}`);

  console.log("\n[mock-run] Scenario 2 assertions:");
  check(
    "scenario 2: run status is completed",
    finishedRun.status === "completed",
    `actual=${finishedRun.status} error=${finishedRun.error ?? "(none)"}`
  );

  const steps = listRunSteps(run.id).map(toParsedRunStep);
  const qaSteps = steps.filter((step) => step.phase === "qa");
  check("scenario 2: at least one QA step ran", qaSteps.length > 0);
  check(
    "scenario 2: QA step reports the final quality gate",
    qaSteps.some((step) => step.title.toLowerCase().includes("quality gate")),
    qaSteps.map((step) => step.title).join(", ")
  );

  if (finishedRun.status !== "completed") {
    printRunSteps(run.id);
    return;
  }

  const snapshot = getCurrentSnapshotForProject(project.id);
  check("scenario 2: project has a current snapshot", Boolean(snapshot));
}

try {
  await main();
  await runScenarioTwo();
} catch (error) {
  console.error("[mock-run] Harness crashed:", error);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only.
  }
  reportAndExit();
}
