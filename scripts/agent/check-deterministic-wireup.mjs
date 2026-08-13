#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ORCHESTRATOR_PATH = path.resolve("src/lib/server/agent/orchestrator.ts");

function findPattern(haystack, pattern) {
  const index = haystack.search(pattern);
  if (index < 0) return null;
  const prefix = haystack.slice(0, index);
  return prefix.split("\n").length;
}

function run() {
  if (!fs.existsSync(ORCHESTRATOR_PATH)) {
    console.error(`FAIL: missing file ${ORCHESTRATOR_PATH}`);
    process.exit(1);
  }

  const source = fs.readFileSync(ORCHESTRATOR_PATH, "utf8");
  const checks = [
    {
      name: "imports_skeleton_first_generators",
      pattern:
        /generatePlanOutline[\s\S]*generateSkeletonSpecDag[\s\S]*generateSkeletonFile[\s\S]*generateSkeletonAutofix[\s\S]*generateFillForSkeleton[\s\S]*generateFixDag[\s\S]*generateFixOperations/,
    },
    {
      name: "runtime_smoke_disabled",
      forbid: /const startSmoke = await runStartServerSmokeCheck\(/,
    },
    {
      name: "skeleton_snapshot_emitted",
      pattern:
        /type:\s*"run_snapshot"[\s\S]*taskId:\s*"skeleton_snapshot"[\s\S]*before fill/i,
    },
    {
      name: "fill_uses_all_settled",
      pattern: /const fillSettled = await Promise\.allSettled\(/,
    },
    {
      name: "skeleton_validation_uses_skeleton_validator",
      pattern: /validateSkeletonWorkingTree\(workingFiles,\s*allFileContracts/,
    },
    {
      name: "final_validation_uses_final_validator",
      pattern: /const validation = await validateFinalWorkingTree\(files\);/,
    },
    {
      name: "fix_dag_conditional_loop",
      pattern:
        /while \(enableFixDag && blockingIssues\.length > 0 && remediationPass < fixDagMaxPasses\)/,
    },
    {
      name: "final_qa_single_pass",
      pattern:
        /title:\s*"Final quality gate"[\s\S]*generateQaVerdict\([\s\S]*attempt:\s*1,[\s\S]*maxAttempts:\s*1/,
    },
    {
      name: "legacy_execute_task_removed",
      forbid: /executeTask\(/,
    },
    {
      name: "legacy_execution_tiers_removed",
      forbid: /buildExecutionTiers\(/,
    },
    {
      name: "legacy_task_merge_removed",
      forbid: /mergeTierOutputs\(/,
    },
    {
      name: "legacy_generic_validator_not_used",
      forbid: /validateWorkingTree\(/,
    },
  ];

  const failures = [];
  const passes = [];

  for (const check of checks) {
    if (check.forbid) {
      const line = findPattern(source, check.forbid);
      if (line != null) {
        failures.push(`${check.name} (forbidden pattern @ line ~${line})`);
      } else {
        passes.push({ name: check.name, line: null });
      }
      continue;
    }

    const line = findPattern(source, check.pattern);
    if (line == null) {
      failures.push(check.name);
    } else {
      passes.push({ name: check.name, line });
    }
  }

  const orderedStepTitles = [
    'title: "Plan outline"',
    'title: "Skeleton DAG spec"',
    'title: "Generate skeleton files"',
    'title: "Validate skeleton contracts"',
    'title: "Fill function bodies in parallel"',
    'title: "Post-fill validation + runtime gate"',
    'title: "Final quality gate"',
    'title: "Persist snapshot and publish preview"',
  ];
  const orderedIndices = orderedStepTitles.map((title) => source.indexOf(title));
  const missingStep = orderedIndices.findIndex((index) => index < 0);
  if (missingStep >= 0) {
    failures.push(`pipeline_step_missing:${orderedStepTitles[missingStep]}`);
  } else {
    let ordered = true;
    for (let index = 1; index < orderedIndices.length; index += 1) {
      if (orderedIndices[index] <= orderedIndices[index - 1]) {
        ordered = false;
        break;
      }
    }
    if (!ordered) {
      failures.push("pipeline_step_order_invalid");
    } else {
      passes.push({ name: "pipeline_step_order_valid", line: null });
    }
  }

  console.log("Skeleton-First Wire-up Audit");
  console.log(`File: ${ORCHESTRATOR_PATH}`);
  for (const pass of passes) {
    const suffix = pass.line == null ? "" : ` @ line ~${pass.line}`;
    console.log(`PASS ${pass.name}${suffix}`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL ${failure}`);
    }
    process.exit(1);
  }

  console.log("All skeleton-first wire-up checks passed.");
}

run();
