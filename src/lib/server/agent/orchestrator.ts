// orchestrator.ts — Execution engine only. Types, schemas, prompts, context
// utilities, normalizers, and generators live in the ./orchestrator/ submodules.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import ts from "typescript";
import {
  claimNextQueuedRun,
  claimQueuedRunById,
  createRunArtifact,
  createMessage,
  createRunStep,
  createSnapshot,
  getCurrentSnapshotForProject,
  getMessageById,
  getProjectById,
  getRunStepById,
  getThreadById,
  listRunSteps,
  setProjectCurrentSnapshot,
  toParsedRunStep,
  updateRunStep,
} from "@/lib/server/repositories";
import type { ExecutionMode, ExecutionScope, GeneratedFile, RunRow } from "@/lib/server/types";
import { publishRunEvent } from "@/lib/server/agent/event-bus";
import {
  applyFileOperations,
  normalizePath,
  summarizeBlockingIssues,
  buildStructureLocks,
  enforceStructureLockedFillOperations,
  generateDeterministicValidationFixOperations,
  type FileOperation,
  type InvalidFileOperationIssue,
  type ValidationIssue,
  type ValidationResult,
  type PreviewRiskReport,
  validateSkeletonWorkingTree,
  validateFinalWorkingTree,
} from "@/lib/server/agent/validation";
import {
  ensureDeterministicPackageManifest,
  stripPackageManifestOperations,
} from "@/lib/server/agent/package-manifest";
import {
  getConfiguredModelProvidersForPhase,
  getConfiguredModelProvidersForPhaseWithModels,
  type ConfiguredModelProvider,
  type ModelProviderPhase,
} from "@/lib/server/agent/model-provider";

// Re-exports from submodules so external consumers keep working
export type {
  ExecutionInput,
  ModelTrace,
  OperationResult,
  PlanTask,
  QaResult,
  RunDiagnostics,
  SpecResponse,
  ArchitectPlanResponse,
  FileContract,
  ImportContract,
  ExportContract,
  DbQueryContract,
  SkeletonFile,
} from "./orchestrator/types";

export {
  ACCEPTANCE_GATE_MIN_SCORE,
  ACCEPTANCE_HARD_FAIL_SCORE,
} from "./orchestrator/prompts";

import {
  assertNonTerminal,
  toSafeJson,
  toUserFacingAgentError,
  buildThreadPromptContextPack,
  getPriorRunContext,
  runSnapshotFiles,
  ensureRunExists,
  updateRunAndReload,
  summarizeTreeChanges,
  countOperationKinds,
  initializeDiagnostics,
  estimateSpecQualityScore,
  persistRunMemoryCards,
} from "./orchestrator/context";
import type { ThreadContextPack } from "./orchestrator/context";

import {
  generateSpec,
  generateModeDecision,
  generatePlanOutline,
  generateSkeletonSpecDag,
  generateSkeletonFile,
  generateFileEdit,
  generateSkeletonAutofix,
  generateFillForSkeleton,
  generateFixDag,
  generateFixOperations,
  generateQaVerdict,
  generateQaFixOperations,
  generateFinalSummary,
  generateMissingFillRegions,
} from "./orchestrator/generators";

import type {
  ExecutionInput,
  ModelTrace,
  OperationResult,
  PlanTask,
  QaResponse,
  QaResult,
  FileContract,
  SkeletonFile,
  SkeletonDagNode,
} from "./orchestrator/types";
import {
  ACCEPTANCE_GATE_MIN_SCORE,
  ACCEPTANCE_HARD_FAIL_SCORE,
  getStarterTemplateFiles,
  selectStarterTemplateProfile,
  type StarterTemplateProfileId,
  type TemplateDiversitySeed,
} from "./orchestrator/prompts";

// ─── Execution Guard ──────────────────────────────────────────────

let executionGuard: Set<string> | null = null;

function getExecutionGuard(): Set<string> {
  if (!executionGuard) {
    executionGuard = new Set<string>();
  }
  return executionGuard;
}

const DEFAULT_RUN_DISPATCH_POLL_MS = 1000;
const MIN_RUN_DISPATCH_POLL_MS = 100;
const MAX_RUN_DISPATCH_POLL_MS = 60000;
const DEFAULT_RUN_HARD_TIMEOUT_MS = 45 * 60 * 1000;
const MIN_RUN_HARD_TIMEOUT_MS = 30000;
const DEFAULT_RUNTIME_GATE_TIMEOUT_MS = 120000;
const MIN_RUNTIME_GATE_TIMEOUT_MS = 30000;
const MAX_RUNTIME_GATE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_SKELETON_AUTOFIX_PASSES = 1;
const DEFAULT_FIX_DAG_MAX_PASSES = 3;
const DEFAULT_QA_FIX_PASSES = 1;

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseBoundedIntegerEnv(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function isRunDispatcherEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_RUN_DISPATCH_ENABLED, true);
}

function getRunDispatchPollMs(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_RUN_DISPATCH_POLL_MS,
    DEFAULT_RUN_DISPATCH_POLL_MS,
    MIN_RUN_DISPATCH_POLL_MS,
    MAX_RUN_DISPATCH_POLL_MS
  );
}

function getRunHardTimeoutMs(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_RUN_TIMEOUT_MS,
    DEFAULT_RUN_HARD_TIMEOUT_MS,
    MIN_RUN_HARD_TIMEOUT_MS,
    Number.MAX_SAFE_INTEGER
  );
}

type RunDispatcherState = {
  started: boolean;
  timer: NodeJS.Timeout | null;
  running: boolean;
  wakeRequested: boolean;
};

let runDispatcherState: RunDispatcherState | null = null;

function getRunDispatcherState(): RunDispatcherState {
  if (!runDispatcherState) {
    runDispatcherState = {
      started: false,
      timer: null,
      running: false,
      wakeRequested: false,
    };
  }
  return runDispatcherState;
}
function isBuildCacheEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_BUILD_CACHE_ENABLED, true);
}

function getSkeletonAutofixPasses(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_SKELETON_AUTOFIX_PASSES,
    DEFAULT_SKELETON_AUTOFIX_PASSES,
    0,
    3
  );
}

function getFixDagMaxPasses(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_FIX_DAG_MAX_PASSES,
    DEFAULT_FIX_DAG_MAX_PASSES,
    0,
    6
  );
}

function getQaFixMaxPasses(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_QA_FIX_PASSES,
    DEFAULT_QA_FIX_PASSES,
    0,
    5
  );
}

const DEFAULT_FILL_CONCURRENCY = 3;
const MAX_FILL_CONCURRENCY = 20;

function getFillConcurrency(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_FILL_CONCURRENCY,
    DEFAULT_FILL_CONCURRENCY,
    1,
    MAX_FILL_CONCURRENCY
  );
}

/**
 * Tiny inline semaphore: runs `worker` over `items` with at most `limit`
 * calls in flight at once, preserving result order. Rejects as soon as any
 * worker throws (mirrors Promise.all), without cancelling in-flight work.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const runNext = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: boundedLimit }, runNext));
  return results;
}

/**
 * Same bounded-concurrency runner as mapWithConcurrency, but settles every
 * item like Promise.allSettled instead of rejecting on the first failure.
 */
async function mapSettledWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(limit, items.length));
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  const runNext = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        const value = await worker(items[currentIndex], currentIndex);
        results[currentIndex] = { status: "fulfilled", value };
      } catch (error) {
        results[currentIndex] = { status: "rejected", reason: error };
      }
    }
  };

  await Promise.all(Array.from({ length: boundedLimit }, runNext));
  return results;
}

function isSkeletonValidationEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_ENABLE_SKELETON_VALIDATION, true);
}

function isFinalValidationEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_ENABLE_FINAL_VALIDATION, true);
}

// Static validation (validateFinalWorkingTree + the deterministic autofix)
// and the terminal build check (npm install + npm run build) both live
// behind DEXTER_ENABLE_FINAL_VALIDATION today. This lets a run keep static
// validation on while skipping only the slow/expensive npm install+build,
// e.g. for a mock-provider harness that wants gates on without a real build.
function isTerminalBuildSkipped(): boolean {
  return parseBooleanEnv(process.env.DEXTER_SKIP_TERMINAL_BUILD, false);
}

function isQaEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_ENABLE_QA, true);
}

function isFixDagEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_ENABLE_FIX_DAG, true);
}

function isStarterTemplatesEnabled(): boolean {
  return parseBooleanEnv(process.env.DEXTER_ENABLE_STARTER_TEMPLATES, false);
}

function parseCsvEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

function getRuntimeGateTimeoutMs(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_RUNTIME_GATE_TIMEOUT_MS,
    DEFAULT_RUNTIME_GATE_TIMEOUT_MS,
    MIN_RUNTIME_GATE_TIMEOUT_MS,
    MAX_RUNTIME_GATE_TIMEOUT_MS
  );
}

// Kept as the deterministic fallback for resolveExecutionModeDecision below:
// a model call can fail (timeout, provider outage, bad JSON after retries),
// and classification must never be the reason a run fails.
function classifyExecutionModeHeuristic(input: {
  userPrompt: string;
  threadContext: string;
  priorRunContext: string;
}): ExecutionMode {
  const signal = `${input.userPrompt}\n${input.threadContext}\n${input.priorRunContext}`.toLowerCase();
  const looksLikeFollowup =
    /\b(fix|bug|error|broken|fails?|failing|not working|doesn't|doesnt|issue|regression|why)\b/.test(
      signal
    ) ||
    /\brun failed\b|\bquality gate failed\b/.test(signal);
  return looksLikeFollowup ? "followup_fix_mode" : "feature_mode";
}

type ExecutionModeDecisionResult = {
  mode: ExecutionMode;
  scope: ExecutionScope;
  reasoning: string;
  targetPaths: string[];
  trace: ModelTrace | null;
  classifiedViaModel: boolean;
};

/**
 * Structured mode/scope classification for follow-up runs. Only meaningful
 * once a prior snapshot exists — callers should skip invoking this entirely
 * for first-message runs so greenfield builds never pay for a classification
 * call. Never throws: a failed/malformed model call falls back to the old
 * regex heuristic (scope always "full_rebuild" in that case, preserving
 * today's behavior) so classification can never fail a run.
 */
async function resolveExecutionModeDecision(input: {
  providers: ConfiguredModelProvider[];
  userPrompt: string;
  threadContext: string;
  priorRunContext: string;
  files: GeneratedFile[];
}): Promise<ExecutionModeDecisionResult> {
  try {
    const result = await generateModeDecision({
      providers: input.providers,
      userPrompt: input.userPrompt,
      threadContext: input.threadContext,
      priorRunContext: input.priorRunContext,
      files: input.files,
    });
    return {
      mode: result.decision.mode,
      scope: result.decision.scope,
      reasoning: result.decision.reasoning,
      targetPaths: result.decision.targetPaths,
      trace: result.trace,
      classifiedViaModel: true,
    };
  } catch (error) {
    const heuristicMode = classifyExecutionModeHeuristic({
      userPrompt: input.userPrompt,
      threadContext: input.threadContext,
      priorRunContext: input.priorRunContext,
    });
    const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
    return {
      mode: heuristicMode,
      scope: "full_rebuild",
      reasoning: `Heuristic fallback (mode-decision call failed: ${reason})`,
      targetPaths: [],
      trace: null,
      classifiedViaModel: false,
    };
  }
}

/**
 * Wraps a planning-phase generation call with a single additional retry:
 * if the first attempt throws (provider pool exhausted) or `execute` itself
 * throws after inspecting a structurally-empty result, retry exactly once
 * with a corrective note describing the failure appended to the prompt.
 * Only if the retry also fails does the error propagate and fail the run.
 */
async function withCorrectivePromptRetry<T>(
  label: string,
  execute: (correctiveNote?: string) => Promise<T>
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
    console.warn(
      `[orchestrator] ${label} failed on first attempt; retrying once. Reason: ${message}`
    );
    return execute(
      `IMPORTANT: The previous attempt failed with: "${message}". Address this specifically and return a complete, valid response.`
    );
  }
}

function normalizeQaBlockers(qa: QaResponse): {
  hardBlockers: string[];
  softBlockers: string[];
} {
  const soft = [...qa.softBlockers];
  const hard: string[] = [];
  const runtimeBreakingSignals = [
    /\bruntime\b/,
    /\bbuild\b/,
    /\bcompile\b/,
    /\bsyntax\b/,
    /\bparse\b/,
    /\bmodule not found\b/,
    /\bcannot resolve\b/,
    /\bfailed to resolve\b/,
    /\bmissing export\b/,
    /\bundefined\b/,
    /\btypeerror\b/,
    /\breferenceerror\b/,
    /\binvalid hook call\b/,
    /\bhook violation\b/,
    /\brouter provider\b/,
    /\bapp (?:won't|will not) (?:boot|run|render)\b/,
    /\bblank screen\b/,
    /\bwhite screen\b/,
    /\bthrows?\b/,
    /\bcrash(?:es|ed|ing)?\b/,
    /\bfatal\b/,
    /\bdoes not build\b/,
    /\bcannot start\b/,
  ];
  const advisorySignals = [
    /\bnative dialog\b/,
    /\bwindow\.(alert|prompt|confirm)\b/,
    /\b(alert|prompt|confirm)\b/,
    /\bpolish\b/,
    /\bvisual\b/,
    /\bsty(?:le|ling)\b/,
    /\bcopy\b/,
    /\bmicrocopy\b/,
    /\ba11y\b/,
    /\baccessibility\b/,
    /\banimation\b/,
    /\bspacing\b/,
    /\btypography\b/,
    /\bcolor\b/,
    /\bnon[- ]blocking\b/,
    /\boptional\b/,
  ];

  for (const blocker of qa.hardBlockers) {
    const lower = blocker.toLowerCase();
    const advisoryOnly = advisorySignals.some((pattern) => pattern.test(lower));
    const runtimeBreaking = runtimeBreakingSignals.some((pattern) => pattern.test(lower));
    if (advisoryOnly || !runtimeBreaking) {
      soft.push(blocker);
      continue;
    }
    hard.push(blocker);
  }

  return {
    hardBlockers: Array.from(new Set(hard)),
    softBlockers: Array.from(new Set(soft)),
  };
}

type QaConfidenceReport = {
  lowConfidence: boolean;
  missingCriteriaCount: number;
  notEvaluatedCriteriaCount: number;
  lowScore: boolean;
  reasons: string[];
};

function normalizeCriterionForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isNotEvaluatedEvidence(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("not explicitly evaluated") ||
    normalized.includes("insufficient visibility") ||
    normalized.includes("not evaluated")
  );
}

function assessQaConfidence(qa: QaResponse, requiredCriteria: string[]): QaConfidenceReport {
  const normalizedAcceptance = qa.acceptance.map((item) => ({
    criterion: normalizeCriterionForMatch(item.criterion),
    evidence: item.evidence,
  }));

  let missingCriteriaCount = 0;
  let notEvaluatedCriteriaCount = 0;

  for (const criterion of requiredCriteria) {
    const normalized = normalizeCriterionForMatch(criterion);
    if (!normalized) {
      continue;
    }

    const matched = normalizedAcceptance.find(
      (item) =>
        item.criterion === normalized ||
        item.criterion.includes(normalized) ||
        normalized.includes(item.criterion)
    );
    if (!matched) {
      missingCriteriaCount += 1;
      continue;
    }
    if (isNotEvaluatedEvidence(matched.evidence)) {
      notEvaluatedCriteriaCount += 1;
    }
  }

  const lowScore = qa.score < ACCEPTANCE_GATE_MIN_SCORE;
  const reasons: string[] = [];
  if (missingCriteriaCount > 0) {
    reasons.push(`missing_acceptance_coverage=${missingCriteriaCount}`);
  }
  if (notEvaluatedCriteriaCount > 0) {
    reasons.push(`not_evaluated_criteria=${notEvaluatedCriteriaCount}`);
  }
  if (lowScore) {
    reasons.push(`score_below_min=${qa.score}<${ACCEPTANCE_GATE_MIN_SCORE}`);
  }

  return {
    lowConfidence: reasons.length > 0,
    missingCriteriaCount,
    notEvaluatedCriteriaCount,
    lowScore,
    reasons,
  };
}

function taskWriteSetOverlap(left: PlanTask, right: PlanTask): number {
  const leftSet = new Set(left.taskWriteSet);
  const rightSet = new Set(right.taskWriteSet);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  let overlap = 0;
  for (const path of leftSet) {
    if (rightSet.has(path)) overlap += 1;
  }
  return overlap / Math.min(leftSet.size, rightSet.size);
}

function taskSimilarity(left: PlanTask, right: PlanTask): number {
  const tokenize = (value: string): Set<string> =>
    new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 3)
    );
  const leftTokens = tokenize(`${left.title}\n${left.instructions}`);
  const rightTokens = tokenize(`${right.title}\n${right.instructions}`);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : shared / union;
}

function dedupeTasksBeforeExecution(
  tasks: PlanTask[],
  executionMode: ExecutionMode
): PlanTask[] {
  const sorted = [...tasks].sort((left, right) => left.id.localeCompare(right.id));
  const deduped: PlanTask[] = [];
  for (const task of sorted) {
    const existing = deduped.find((candidate) => {
      const overlap = taskWriteSetOverlap(candidate, task);
      if (overlap < 0.7) return false;
      return taskSimilarity(candidate, task) >= 0.65;
    });

    if (!existing) {
      deduped.push(task);
      continue;
    }

    existing.instructions = `${existing.instructions}\n\n${task.instructions}`.trim();
    existing.taskWriteSet = Array.from(new Set(existing.taskWriteSet.concat(task.taskWriteSet)));
    existing.dependsOn = Array.from(new Set(existing.dependsOn.concat(task.dependsOn)));
  }

  const normalized = deduped.map((task) => ({
    ...task,
    taskWriteSet: Array.from(new Set(task.taskWriteSet)).sort((a, b) => a.localeCompare(b)),
  }));

  if (executionMode === "followup_fix_mode") {
    return normalized.slice(0, 3);
  }
  return normalized;
}

// ─── Cancellation Guard ───────────────────────────────────────────

const runAbortControllers = new Map<string, AbortController>();

export function cancelRun(runId: string): void {
  const controller = runAbortControllers.get(runId);
  if (controller) {
    controller.abort();
    console.log(`[run:${runId}] cancellation triggered manually`);
  }
}

// ─── Step Publishing ──────────────────────────────────────────────

function publishStep(run: RunRow, stepId: string): void {
  const row = getRunStepById(stepId);
  if (!row) {
    throw new Error(`Run step not found: ${stepId}`);
  }
  const updated = toParsedRunStep(row);

  publishRunEvent({
    type: "step",
    payload: {
      runId: run.id,
      projectId: run.project_id,
      timestamp: Date.now(),
      step: updated,
    },
  });
}

type TerminalCommandResult = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string[];
  stderrTail: string[];
  combinedTail: string[];
};

type TerminalBuildCheckResult = {
  passed: boolean;
  install: TerminalCommandResult | null;
  build: TerminalCommandResult | null;
  issues: ValidationIssue[];
  diagnostics: string[];
  outputTail: string[];
};

const DEFAULT_TERMINAL_INSTALL_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TERMINAL_BUILD_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_TERMINAL_OUTPUT_LINES = 140;
const MAX_TERMINAL_OUTPUT_CHARS = 180_000;

function getTerminalInstallTimeoutMs(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_TERMINAL_INSTALL_TIMEOUT_MS,
    DEFAULT_TERMINAL_INSTALL_TIMEOUT_MS,
    10_000,
    30 * 60 * 1000
  );
}

function getTerminalBuildTimeoutMs(): number {
  return parseBoundedIntegerEnv(
    process.env.DEXTER_TERMINAL_BUILD_TIMEOUT_MS,
    DEFAULT_TERMINAL_BUILD_TIMEOUT_MS,
    10_000,
    30 * 60 * 1000
  );
}

function toTailLines(value: string, maxLines = DEFAULT_TERMINAL_OUTPUT_LINES): string[] {
  return value
    .split(/\r?\n/g)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

async function runCommandWithCapture(input: {
  cwd: string;
  command: string;
  args: string[];
  timeoutMs: number;
  envOverrides?: Record<string, string>;
}): Promise<TerminalCommandResult> {
  return await new Promise<TerminalCommandResult>((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: { ...process.env, CI: "1", ...(input.envOverrides ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const appendChunk = (current: string, chunk: string): string => {
      const next = `${current}${chunk}`;
      if (next.length <= MAX_TERMINAL_OUTPUT_CHARS) {
        return next;
      }
      return next.slice(next.length - MAX_TERMINAL_OUTPUT_CHARS);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuffer = appendChunk(stdoutBuffer, chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuffer = appendChunk(stderrBuffer, chunk.toString());
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    }, input.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const commandLabel = [input.command, ...input.args].join(" ");
      const stdoutTail = toTailLines(stdoutBuffer);
      const stderrTail = toTailLines(`${stderrBuffer}\n${error.message}`);
      resolve({
        command: commandLabel,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs,
        stdoutTail,
        stderrTail,
        combinedTail: [...stdoutTail, ...stderrTail].slice(-DEFAULT_TERMINAL_OUTPUT_LINES),
      });
    });

    child.on("close", (exitCode, signalCode) => {
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const commandLabel = [input.command, ...input.args].join(" ");
      const stdoutTail = toTailLines(stdoutBuffer);
      const stderrTail = toTailLines(stderrBuffer);
      resolve({
        command: commandLabel,
        exitCode,
        signal: signalCode,
        timedOut,
        durationMs,
        stdoutTail,
        stderrTail,
        combinedTail: [...stdoutTail, ...stderrTail].slice(-DEFAULT_TERMINAL_OUTPUT_LINES),
      });
    });
  });
}

function mapTerminalPathToWorkspacePath(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/\\/g, "/");
  const srcIndex = normalized.indexOf("/src/");
  if (srcIndex >= 0) {
    return normalized.slice(srcIndex + 1);
  }
  const rootCandidates = [
    "package.json",
    "index.html",
    "vite.config.js",
    "vite.config.ts",
    "postcss.config.js",
    "postcss.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
  ];
  for (const candidate of rootCandidates) {
    if (normalized.endsWith(`/${candidate}`) || normalized === candidate) {
      return candidate;
    }
  }
  return undefined;
}

function parseNodeModulesPackageName(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/\\/g, "/");
  const marker = "/node_modules/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const remainder = normalized.slice(markerIndex + marker.length);
  const segments = remainder.split("/").filter(Boolean);
  if (segments.length === 0) return undefined;
  if (segments[0].startsWith("@") && segments.length >= 2) {
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0];
}

function parseTerminalBuildIssues(output: string): ValidationIssue[] {
  const cleanedOutput = output.replace(/\u001b\[[0-9;]*m/g, "");
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  const pushIssue = (issue: ValidationIssue) => {
    const key = `${issue.code}::${issue.file ?? ""}::${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(issue);
    }
  };

  const tailwindUnknownUtility =
    /tailwindcss:\s+([^\s:][^:]*?):\d+:\d+:\s+Cannot apply unknown utility class [`'"]?([^`'"\s]+)[`'"]?/gi;
  for (const match of cleanedOutput.matchAll(tailwindUnknownUtility)) {
    const file = mapTerminalPathToWorkspacePath(match[1] ?? "");
    const classToken = match[2] ?? "unknown";
    pushIssue({
      code: "tailwind.css_apply_custom_class",
      file,
      message: `Found custom class \`${classToken}\` used inside \`@apply\`. Tailwind \`@apply\` accepts utility classes only; move reusable styles into regular CSS selectors or replace with concrete utility tokens.`,
    });
  }

  const localMissingImport =
    /Failed to resolve import ["'`]([^"'`]+)["'`] from ["'`]([^"'`]+)["'`]/gi;
  for (const match of cleanedOutput.matchAll(localMissingImport)) {
    const specifier = match[1] ?? "";
    const sourceFile = mapTerminalPathToWorkspacePath(match[2] ?? "") ?? match[2];
    pushIssue({
      code: "imports.local_missing_module",
      file: sourceFile,
      message: `Local import "${specifier}" could not be resolved. Ensure the target file exists and relative import path is correct.`,
    });
  }

  const missingNamedExport =
    /No matching export in ["'`]([^"'`]+)["'`] for import ["'`]([^"'`]+)["'`]/gi;
  for (const match of cleanedOutput.matchAll(missingNamedExport)) {
    const sourceFile = mapTerminalPathToWorkspacePath(match[1] ?? "") ?? match[1];
    const importedName = match[2] ?? "unknown";
    pushIssue({
      code: "imports.local_missing_export",
      file: sourceFile,
      message: `Import "${importedName}" is missing from "${sourceFile}". Keep import/export contracts synchronized.`,
    });
  }

  const rollupMissingExport =
    /([^(\n]+)\s+\(\d+:\d+\):\s*["'`]([^"'`]+)["'`]\s+is not exported by\s+["'`]([^"'`]+)["'`],\s+imported by\s+["'`]([^"'`]+)["'`]/gi;
  for (const match of cleanedOutput.matchAll(rollupMissingExport)) {
    const importedName = match[2] ?? "unknown";
    const exportedByRaw = match[3] ?? "";
    const importerRaw = match[4] ?? "";
    const importerFile = mapTerminalPathToWorkspacePath(importerRaw) ?? importerRaw;
    const exportedByFile = mapTerminalPathToWorkspacePath(exportedByRaw);
    const packageName = parseNodeModulesPackageName(exportedByRaw);

    if (packageName === "lucide-react") {
      pushIssue({
        code: "imports.lucide_missing_export",
        file: importerFile,
        message: `Lucide icon "${importedName}" is not exported by lucide-react. Replace with a valid lucide icon export and keep import/usage synchronized.`,
      });
      continue;
    }

    if (exportedByFile) {
      pushIssue({
        code: "imports.local_missing_export",
        file: importerFile,
        message: `Import "${importedName}" is missing from "${exportedByFile}". Keep import/export contracts synchronized.`,
      });
      continue;
    }

    if (packageName) {
      pushIssue({
        code: "imports.package_missing_export",
        file: importerFile,
        message: `Package import "${importedName}" is not exported by "${packageName}". Replace with a valid export from that package.`,
      });
      continue;
    }

    pushIssue({
      code: "imports.package_missing_export",
      file: importerFile,
      message: `Import "${importedName}" is not exported by "${exportedByRaw}". Replace with a valid export from that source.`,
    });
  }

  const duplicateExport = /Multiple exports with the same name ["'`]([^"'`]+)["'`]/gi;
  for (const match of cleanedOutput.matchAll(duplicateExport)) {
    const exportName = match[1] ?? "unknown";
    pushIssue({
      code: "exports.duplicate_named_export",
      message: `Found duplicate named export "${exportName}". Keep each export name unique within a module.`,
    });
  }

  if (
    /['"`]import['"`],\s*and\s*['"`]export['"`]\s*cannot be used outside of module code/i.test(
      cleanedOutput
    ) &&
    /export\s+const\s+db\s*=\s*new\s+PGlite\s*\(/.test(cleanedOutput)
  ) {
    const fileMatch = cleanedOutput.match(/file:\s*([^\s:][^:\n]+):\d+:\d+/i);
    const resolvedPath = mapTerminalPathToWorkspacePath(fileMatch?.[1] ?? "") ?? "src/lib/db.js";
    pushIssue({
      code: "pglite.invalid_nested_export",
      file: resolvedPath,
      message:
        "Detected nested `export const db = new PGlite(...)` in DB init path. Export must be top-level module scope.",
    });
  }

  return issues;
}

function terminalResultToPayload(result: TerminalBuildCheckResult): Record<string, unknown> {
  const mapCommand = (command: TerminalCommandResult | null): Record<string, unknown> | null => {
    if (!command) return null;
    return {
      command: command.command,
      exitCode: command.exitCode,
      signal: command.signal,
      timedOut: command.timedOut,
      durationMs: command.durationMs,
      stdoutTail: command.stdoutTail,
      stderrTail: command.stderrTail,
      combinedTail: command.combinedTail,
    };
  };
  return {
    passed: result.passed,
    install: mapCommand(result.install),
    build: mapCommand(result.build),
    outputTail: result.outputTail,
    diagnostics: result.diagnostics,
  };
}

type FilesystemSyncResult = {
  files: GeneratedFile[];
  skippedMetadataCount: number;
  skippedBinaryCount: number;
};

function isFilesystemMetadataPath(rawPath: string): boolean {
  const normalized = normalizePath(rawPath).toLowerCase();
  return (
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".next" ||
    normalized.startsWith(".next/") ||
    normalized === "node_modules" ||
    normalized.startsWith("node_modules/") ||
    normalized === "dist" ||
    normalized.startsWith("dist/") ||
    normalized === ".aider.chat.history.md" ||
    normalized === ".aider.input.history" ||
    normalized.startsWith(".aider.tags.cache")
  );
}

function isLikelyBinaryContent(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function materializeWorkspaceSnapshot(
  workspaceDir: string,
  files: GeneratedFile[]
): Promise<void> {
  for (const file of files) {
    const normalized = normalizePath(file.name);
    if (isFilesystemMetadataPath(normalized)) {
      continue;
    }
    const absolutePath = path.join(workspaceDir, normalized);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, file.code, "utf8");
  }
}

async function collectWorkspaceFiles(
  workspaceDir: string
): Promise<FilesystemSyncResult> {
  const output: GeneratedFile[] = [];
  let skippedMetadataCount = 0;
  let skippedBinaryCount = 0;

  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = normalizePath(path.relative(workspaceDir, absolutePath));
      if (isFilesystemMetadataPath(relativePath)) {
        skippedMetadataCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      try {
        const content = await fs.readFile(absolutePath);
        if (isLikelyBinaryContent(content)) {
          skippedBinaryCount += 1;
          continue;
        }
        output.push({
          name: relativePath,
          code: content.toString("utf8"),
        });
      } catch {
        skippedBinaryCount += 1;
      }
    }
  };

  await walk(workspaceDir);
  output.sort((left, right) => left.name.localeCompare(right.name));
  return {
    files: output,
    skippedMetadataCount,
    skippedBinaryCount,
  };
}

async function runFilesystemRoundTrip(files: GeneratedFile[]): Promise<FilesystemSyncResult> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "dexter-fs-sync-"));
  try {
    await materializeWorkspaceSnapshot(workspaceDir, files);
    return await collectWorkspaceFiles(workspaceDir);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
}

async function getProjectCacheDir(projectId: string): Promise<string> {
  const hash = crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 12);
  const cacheDir = path.join(os.tmpdir(), "dexter-cache", hash);
  await fs.mkdir(cacheDir, { recursive: true });
  return cacheDir;
}

async function runTerminalBuildCheck(
  files: GeneratedFile[],
  options?: {
    runtimeGateTimeoutMs?: number;
    projectId?: string;
  }
): Promise<TerminalBuildCheckResult> {
  const buildCacheEnabled = isBuildCacheEnabled();

  let tempDir: string;
  if (buildCacheEnabled && options?.projectId) {
    tempDir = await getProjectCacheDir(options.projectId);
  } else {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dexter-final-build-"));
  }

  try {
    const desiredPathSet = new Set<string>();

    // Incremental write: only overwrite if content differs
    for (const file of files) {
      const normalizedPath = normalizePath(file.name);
      desiredPathSet.add(normalizedPath);
      const fullPath = path.join(tempDir, normalizedPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      let shouldWrite = true;
      if (buildCacheEnabled) {
        try {
          const existing = await fs.readFile(fullPath, "utf8");
          if (existing === file.code) {
            shouldWrite = false;
          }
        } catch {
          // File doesn't exist, write it
        }
      }

      if (shouldWrite) {
        await fs.writeFile(fullPath, file.code, "utf8");
      }
    }

    // Prune stale source files when using cache so old files do not mask failures.
    if (buildCacheEnabled) {
      const pruneStaleWorkspaceFiles = async (directory: string): Promise<void> => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          const absolutePath = path.join(directory, entry.name);
          const relativePath = normalizePath(path.relative(tempDir, absolutePath));
          if (!relativePath || relativePath === ".") {
            continue;
          }
          if (isFilesystemMetadataPath(relativePath)) {
            continue;
          }
          if (entry.isDirectory()) {
            await pruneStaleWorkspaceFiles(absolutePath);
            const remaining = await fs.readdir(absolutePath).catch(() => []);
            if (remaining.length === 0) {
              await fs.rm(absolutePath, { recursive: true, force: true });
            }
            continue;
          }
          if (!desiredPathSet.has(relativePath)) {
            await fs.rm(absolutePath, { force: true });
          }
        }
      };
      await pruneStaleWorkspaceFiles(tempDir);
    }

    const packageJsonPath = path.join(tempDir, "package.json");
    let packageJsonRaw = "";
    try {
      packageJsonRaw = await fs.readFile(packageJsonPath, "utf8");
    } catch {
      return {
        passed: false,
        install: null,
        build: null,
        issues: [
          {
            code: "runtime.terminal_build_failed",
            message: "Terminal build gate could not run because package.json is missing.",
          },
        ],
        diagnostics: ["[terminal] package.json missing; cannot run install/build."],
        outputTail: ["package.json missing; terminal build gate skipped with failure."],
      };
    }
    try {
      JSON.parse(packageJsonRaw);
    } catch {
      return {
        passed: false,
        install: null,
        build: null,
        issues: [
          {
            code: "runtime.invalid_package_json",
            message: "package.json is not valid JSON.",
          },
        ],
        diagnostics: ["[terminal] package.json invalid JSON; cannot run build gate."],
        outputTail: ["package.json invalid JSON."],
      };
    }

    const hasLockFile = await fs
      .stat(path.join(tempDir, "package-lock.json"))
      .then(() => true)
      .catch(() => false);

    // If caching is enabled, we check node_modules. If it exists, we might skip install or run 'npm install' (which is fast).
    // 'npm ci' forces a clean install (deletes node_modules), so we should use 'npm install' when caching is on
    // to benefit from the cache.
    const installCommand = buildCacheEnabled ? "install" : (hasLockFile ? "ci" : "install");

    const installArgs = [installCommand, "--no-audit", "--no-fund", "--include=dev"];

    // If strict CI is requested (hasLockFile and NOT cached), ensuring clean slate.
    // If cached, we prefer speed, so standard 'install' is better as it respects existing modules.

    const install = await runCommandWithCapture({
      cwd: tempDir,
      command: "npm",
      args: installArgs,
      timeoutMs: getTerminalInstallTimeoutMs(),
      envOverrides: {
        NODE_ENV: "development",
        NPM_CONFIG_PRODUCTION: "false",
        npm_config_production: "false",
        NPM_CONFIG_INCLUDE: "dev",
        npm_config_include: "dev",
        // Force color for better logs? No, keep standard.
      },
    });

    if (install.exitCode !== 0) {
      const firstError = install.combinedTail.find((line) => /error/i.test(line)) ?? "Dependency install failed.";
      return {
        passed: false,
        install,
        build: null,
        issues: [
          {
            code: "runtime.terminal_install_failed",
            message: `${install.command} failed. ${firstError}`,
          },
        ],
        diagnostics: [
          `[terminal] ${install.command} failed (exit=${install.exitCode ?? "null"}, timedOut=${install.timedOut})`,
          ...install.combinedTail.slice(-8),
        ],
        outputTail: install.combinedTail.slice(-DEFAULT_TERMINAL_OUTPUT_LINES),
      };
    }

    const build = await runCommandWithCapture({
      cwd: tempDir,
      command: "npm",
      args: ["run", "build"],
      timeoutMs: getTerminalBuildTimeoutMs(),
    });


    if (build.exitCode === 0) {
      return {
        passed: true,
        install,
        build,
        issues: [],
        diagnostics: ["[terminal] npm run build passed"],
        outputTail: build.combinedTail.slice(-DEFAULT_TERMINAL_OUTPUT_LINES),
      };
    }

    const combinedOutput = [...build.stdoutTail, ...build.stderrTail].join("\n");
    const parsedIssues = parseTerminalBuildIssues(combinedOutput);
    const issues =
      parsedIssues.length > 0
        ? parsedIssues
        : [
          {
            code: "runtime.terminal_build_failed",
            message:
              build.combinedTail.find((line) => /error|failed/i.test(line)) ??
              "Terminal build command failed.",
          },
        ];

    return {
      passed: false,
      install,
      build,
      issues,
      diagnostics: [
        `[terminal] ${build.command} failed (exit=${build.exitCode ?? "null"}, timedOut=${build.timedOut})`,
        ...build.combinedTail.slice(-12),
      ],
      outputTail: build.combinedTail.slice(-DEFAULT_TERMINAL_OUTPUT_LINES),
    };
  } finally {
    if (!buildCacheEnabled) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

// ─── Core Execution ───────────────────────────────────────────────

async function executeRunInternal({ runId, signal }: ExecutionInput & { signal?: AbortSignal }): Promise<void> {
  if (signal?.aborted) throw new Error("Run cancelled");
  const initialRun = ensureRunExists(runId);
  assertNonTerminal(initialRun);

  const project = getProjectById(initialRun.project_id);
  if (!project) {
    throw new Error(`Project not found: ${initialRun.project_id}`);
  }

  const thread = getThreadById(initialRun.thread_id);
  if (!thread) {
    throw new Error(`Thread not found: ${initialRun.thread_id}`);
  }

  const triggerMessage = getMessageById(initialRun.trigger_message_id);
  if (!triggerMessage) {
    throw new Error(`Trigger message not found: ${initialRun.trigger_message_id}`);
  }

  const resolvePhaseProviders = (phase: ModelProviderPhase): ConfiguredModelProvider[] =>
    getConfiguredModelProvidersForPhase(phase);
  const resolveLengthFallbackProviders = (): ConfiguredModelProvider[] => {
    const activeProvider = (process.env.DEXTER_MODEL_PROVIDER ?? "openrouter").trim().toLowerCase();
    const models =
      activeProvider === "google"
        ? parseCsvEnv(process.env.GEMINI_MODELS_CODER_LENGTH_FALLBACK ?? "gemini-2.5-flash-lite")
        : parseCsvEnv(process.env.OPENROUTER_MODELS_CODER_LENGTH_FALLBACK);
    if (models.length === 0) {
      return [];
    }
    return getConfiguredModelProvidersForPhaseWithModels("coder", models);
  };
  const isLengthLikeFailure = (message: string): boolean => {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("finish_reason=length") ||
      normalized.includes("finish reason=length") ||
      normalized.includes("output truncated") ||
      normalized.includes("truncated repeatedly") ||
      normalized.includes("length cap") ||
      normalized.includes("no continuation progress")
    );
  };

  // Invalid file operations no longer abort the run (see applyFileOperations).
  // They are queued here and drained into the next validation gate so the
  // fix-DAG repair loop gets a chance to see and address them.
  let pendingOperationIssues: ValidationIssue[] = [];

  const applyOperationsWithEngineManifest = (
    currentFiles: GeneratedFile[],
    operations: FileOperation[],
    context: { phase: string; taskId?: string }
  ): {
    files: GeneratedFile[];
    appliedOperations: FileOperation[];
    strippedPackageOps: number;
    invalidOperations: InvalidFileOperationIssue[];
  } => {
    const currentByPath = new Map<string, GeneratedFile>();
    for (const file of currentFiles) {
      currentByPath.set(normalizePath(file.name), file);
    }

    const sanitized = operations.filter((operation) => {
      if (operation.op !== "json_manifest_update") {
        return true;
      }
      let normalizedPath: string;
      try {
        normalizedPath = normalizePath(operation.path);
      } catch {
        return false;
      }
      if (!/\.json$/i.test(normalizedPath)) {
        return false;
      }
      const existing = currentByPath.get(normalizedPath);
      if (!existing) {
        return false;
      }
      try {
        const parsed = JSON.parse(existing.code);
        return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
      } catch {
        return false;
      }
    });

    const { filtered, strippedCount } = stripPackageManifestOperations(sanitized);
    const applyResult =
      filtered.length > 0
        ? applyFileOperations(currentFiles, filtered, context)
        : { files: currentFiles, appliedOperations: [] as FileOperation[], invalidOperations: [] as InvalidFileOperationIssue[] };

    if (applyResult.invalidOperations.length > 0) {
      console.warn(
        `[orchestrator] Dropped ${applyResult.invalidOperations.length} invalid file operation(s) in phase=${context.phase}${
          context.taskId ? ` task=${context.taskId}` : ""
        }: ${applyResult.invalidOperations.map((issue) => issue.reason).join(" | ")}`
      );
      for (const issue of applyResult.invalidOperations) {
        pendingOperationIssues.push({
          code: "operations.invalid",
          message: issue.reason,
          file: issue.path,
        });
      }
    }

    return {
      files: ensureDeterministicPackageManifest(applyResult.files),
      appliedOperations: applyResult.appliedOperations,
      strippedPackageOps: strippedCount,
      invalidOperations: applyResult.invalidOperations,
    };
  };

  const buildDagTiers = <T extends { id: string; dependsOn?: string[] }>(items: T[]): T[][] => {
    if (items.length === 0) return [];
    const map = new Map(items.map((item) => [item.id, item] as const));
    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();
    for (const item of items) {
      adjacency.set(item.id, []);
      indegree.set(item.id, 0);
    }
    for (const item of items) {
      for (const dep of item.dependsOn ?? []) {
        if (!map.has(dep)) continue;
        adjacency.get(dep)?.push(item.id);
        indegree.set(item.id, (indegree.get(item.id) ?? 0) + 1);
      }
    }

    let queue = items
      .filter((item) => (indegree.get(item.id) ?? 0) === 0)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (queue.length === 0) {
      return items.map((item) => [item]);
    }

    const tiers: T[][] = [];
    let visited = 0;
    while (queue.length > 0) {
      tiers.push(queue);
      visited += queue.length;
      const nextQueue: T[] = [];
      for (const item of queue) {
        for (const neighborId of adjacency.get(item.id) ?? []) {
          const nextValue = (indegree.get(neighborId) ?? 0) - 1;
          indegree.set(neighborId, nextValue);
          if (nextValue === 0) {
            const neighbor = map.get(neighborId);
            if (neighbor) nextQueue.push(neighbor);
          }
        }
      }
      nextQueue.sort((left, right) => left.id.localeCompare(right.id));
      queue = nextQueue;
    }

    if (visited < items.length) {
      return items.map((item) => [item]);
    }
    return tiers;
  };

  const areFixWriteSetsDisjoint = (tasks: Array<{ taskWriteSet: string[] }>): boolean => {
    const seen = new Set<string>();
    for (const task of tasks) {
      for (const rawPath of task.taskWriteSet) {
        const normalized = normalizePath(rawPath);
        if (seen.has(normalized)) return false;
        seen.add(normalized);
      }
    }
    return true;
  };

  const ensureFillRegionMarkers = (filePath: string, code: string): string => {
    if (/\/\/\s*BEGIN_FILL:[A-Za-z0-9_-]+/.test(code)) {
      // The model wrote its own markers: keep the structure but not the ids.
      // Duplicate ids (e.g. four regions all named "Counter") break region
      // matching in the fill merge, so uniquify repeats deterministically.
      const seen = new Map<string, number>();
      return code.replace(
        /(\/\/\s*BEGIN_FILL:)([A-Za-z0-9_-]+)([^\n]*\n[\s\S]*?\/\/\s*END_FILL:)\2/g,
        (whole, beginPrefix: string, id: string, middle: string) => {
          const count = (seen.get(id) ?? 0) + 1;
          seen.set(id, count);
          if (count === 1) {
            return whole;
          }
          const uniqueId = `${id}_${count}`;
          return `${beginPrefix}${uniqueId}${middle}${uniqueId}`;
        }
      );
    }

    const scriptKind = (() => {
      const normalized = normalizePath(filePath).toLowerCase();
      if (normalized.endsWith(".tsx")) return ts.ScriptKind.TSX;
      if (normalized.endsWith(".jsx")) return ts.ScriptKind.JSX;
      if (normalized.endsWith(".ts") || normalized.endsWith(".mts") || normalized.endsWith(".cts")) {
        return ts.ScriptKind.TS;
      }
      return ts.ScriptKind.JS;
    })();

    const source = ts.createSourceFile(
      filePath,
      code,
      ts.ScriptTarget.Latest,
      true,
      scriptKind
    );
    const sanitizedPath = normalizePath(filePath).replace(/[^A-Za-z0-9_]+/g, "_");
    let counter = 0;
    const replacements: Array<{ start: number; end: number; text: string }> = [];

    const pushReplacement = (block: ts.Block): void => {
      const start = block.getStart(source);
      const end = block.end;
      if (start + 1 >= end - 1) return;
      const innerStart = start + 1;
      const innerEnd = end - 1;
      const innerText = code.slice(innerStart, innerEnd);
      if (!/\/\/\s*TODO:\s*FILL_IN/.test(innerText) || /\/\/\s*BEGIN_FILL:/.test(innerText)) {
        return;
      }
      const lineStart = code.lastIndexOf("\n", start) + 1;
      const blockIndent = (code.slice(lineStart, start).match(/^\s*/) ?? [""])[0];
      const innerIndent = `${blockIndent}  `;
      const id = `${sanitizedPath}_${counter}`;
      counter += 1;
      replacements.push({
        start: innerStart,
        end: innerEnd,
        text: `\n${innerIndent}// BEGIN_FILL:${id}\n${innerIndent}// TODO: FILL_IN\n${innerIndent}// END_FILL:${id}\n${blockIndent}`,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.body) {
        pushReplacement(node.body);
      } else if (
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        if (node.body && ts.isBlock(node.body)) {
          pushReplacement(node.body);
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(source);

    if (replacements.length === 0) {
      return code.replace(/\/\/\s*TODO:\s*FILL_IN/g, () => {
        const id = `${sanitizedPath}_${counter}`;
        counter += 1;
        return `// BEGIN_FILL:${id}\n// TODO: FILL_IN\n// END_FILL:${id}`;
      });
    }

    let nextCode = code;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      nextCode =
        nextCode.slice(0, replacement.start) +
        replacement.text +
        nextCode.slice(replacement.end);
    }
    return nextCode;
  };

  type FillRegionBlock = {
    id: string;
    fullText: string;
  };
  const FILL_REGION_BLOCK_PATTERN =
    /\/\/\s*BEGIN_FILL:([A-Za-z0-9_-]+)[^\n]*\n([\s\S]*?)\/\/\s*END_FILL:\1/g;
  const extractFillRegionBlocks = (code: string): FillRegionBlock[] => {
    const blocks: FillRegionBlock[] = [];
    for (const match of code.matchAll(FILL_REGION_BLOCK_PATTERN)) {
      const id = (match[1] ?? "").trim();
      const fullText = match[0] ?? "";
      if (!id || !fullText) continue;
      blocks.push({ id, fullText });
    }
    return blocks;
  };
  const mergeCandidateRegions = (params: {
    baseCode: string;
    candidateCode: string;
    recoveredCode?: string;
  }): string => {
    const baseBlocks = extractFillRegionBlocks(params.baseCode);
    if (baseBlocks.length === 0) {
      return params.candidateCode;
    }
    const candidateById = new Map(
      extractFillRegionBlocks(params.candidateCode).map((block) => [block.id, block.fullText] as const)
    );
    const recoveredById = new Map(
      extractFillRegionBlocks(params.recoveredCode ?? "").map((block) => [block.id, block.fullText] as const)
    );

    let merged = params.baseCode;
    for (const block of baseBlocks) {
      const replacement =
        candidateById.get(block.id) ??
        recoveredById.get(block.id) ??
        block.fullText;
      merged = merged.replace(block.fullText, replacement);
    }
    return merged;
  };

  // model-provider.ts computes invalid-JSON/schema counters per call
  // (ProviderStructuredDiagnostics) but nothing ever read them back off the
  // ModelTrace. Every call site that receives a trace should route it
  // through here so RunDiagnostics reflects what actually happened.
  const accumulateProviderDiagnostics = (trace: ModelTrace | null | undefined): void => {
    if (!trace?.diagnostics) return;
    diagnostics.invalidJsonIncidents += trace.diagnostics.invalidJsonIncidents;
    diagnostics.invalidSchemaIncidents += trace.diagnostics.invalidSchemaIncidents;
  };

  const getTraceTelemetry = (
    phase: ModelProviderPhase,
    phaseProviders: ConfiguredModelProvider[],
    trace: ModelTrace
  ): {
    selectedModel: string;
    modelCandidates: string[];
    reasoningEnabled: boolean;
    phaseTimeoutMs: number;
  } => {
    accumulateProviderDiagnostics(trace);
    const modelCandidates = phaseProviders.map((provider) => provider.model);
    const selectedAttempt = trace.attempts.find((attempt) => attempt.ok) ?? trace.attempts.at(-1);
    const selectedModel = selectedAttempt?.model ?? modelCandidates[0] ?? "unknown";
    const reasoningEnabled = phaseProviders[0]?.reasoningEnabled ?? false;
    const phaseTimeoutMs = phaseProviders[0]?.timeoutMs ?? 0;

    const selectedIndex = modelCandidates.indexOf(selectedModel);
    if (selectedIndex > 0) {
      diagnostics.fallbackSwitches += 1;
    }
    for (const attempt of trace.attempts) {
      const message = (attempt.message ?? "").toLowerCase();
      const timeoutDetected = message.includes("timeout");
      if (!timeoutDetected) continue;
      diagnostics.phaseTimeouts += 1;
      publishRunEvent({
        type: "phase_timeout",
        payload: {
          runId,
          projectId: run.project_id,
          timestamp: Date.now(),
          phase,
          model: attempt.model,
          detail: attempt.message,
          phaseTimeoutMs,
        },
      });
    }

    return {
      selectedModel,
      modelCandidates,
      reasoningEnabled,
      phaseTimeoutMs,
    };
  };

  const collectFinalValidationState = async (
    files: GeneratedFile[],
    runtimeGateTimeoutMs: number
  ): Promise<{
    validation: ValidationResult;
    blockingIssues: string[];
    runtimeDiagnostics: string[];
    terminalBuild: TerminalBuildCheckResult;
  }> => {
    let validation = await validateFinalWorkingTree(files);

    // Run the deterministic fixer before ever falling back to an LLM fix-DAG
    // pass: cheap, offline, mechanical fixes (Tailwind directives, process.env
    // usage, PGlite migration guards, etc.) should not cost a model call.
    if (validation.issues.length > 0) {
      const fixPlan = generateDeterministicValidationFixOperations(
        validation.files,
        validation.issues
      );
      if (fixPlan.operations.length > 0) {
        const applied = applyOperationsWithEngineManifest(validation.files, fixPlan.operations, {
          phase: "deterministic_autofix",
        });
        const counts = countOperationKinds(applied.appliedOperations);
        diagnostics.totalOperations += applied.appliedOperations.length;
        diagnostics.totalUpserts += counts.upserts;
        diagnostics.totalDeletes += counts.deletes;

        const revalidated = await validateFinalWorkingTree(applied.files);

        const autofixStep = createRunStep({
          runId,
          seq: seq++,
          phase: "repair",
          status: "complete",
          title: "Deterministic autofix",
          detail: `Deterministic autofix applied ${applied.appliedOperations.length} operation(s); ${revalidated.issues.length} issue(s) remain`,
          payload: {
            attemptedIssueCodes: fixPlan.attemptedIssueCodes,
            fixedIssueCodes: fixPlan.fixedIssueCodes,
            appliedOperationCount: applied.appliedOperations.length,
            invalidOperationCount: applied.invalidOperations.length,
            issuesBefore: validation.issues.length,
            issuesAfter: revalidated.issues.length,
          },
        });
        publishStep(run, autofixStep.id);

        validation = revalidated;
      }
    }

    const terminalBuild: TerminalBuildCheckResult = isTerminalBuildSkipped()
      ? {
          passed: true,
          install: null,
          build: null,
          issues: [],
          diagnostics: ["[terminal] terminal build check skipped by configuration"],
          outputTail: [],
        }
      : await runTerminalBuildCheck(validation.files, {
          runtimeGateTimeoutMs,
          projectId: run.project_id,
        });

    // Drain any invalid-file-operation issues queued since the last gate so
    // the fix-DAG loop gets a chance to see and address them, rather than
    // silently dropping them (or crashing the run) at the point they occurred.
    const drainedOperationIssues = pendingOperationIssues;
    pendingOperationIssues = [];

    const combinedIssues: ValidationIssue[] = [
      ...validation.issues,
      ...(terminalBuild.passed ? [] : terminalBuild.issues),
      ...drainedOperationIssues,
    ];
    const runtimeDiagnostics = Array.from(
      new Set([...validation.runtimeDiagnostics, ...terminalBuild.diagnostics])
    );

    const blockingIssues = summarizeBlockingIssues(combinedIssues);
    if (blockingIssues.length > 0) {
      diagnostics.validationFailures += 1;
    }

    return {
      validation,
      blockingIssues,
      runtimeDiagnostics,
      terminalBuild,
    };
  };

  let run = updateRunAndReload(runId, "planning");
  publishRunEvent({
    type: "run_started",
    payload: {
      runId,
      projectId: run.project_id,
      timestamp: Date.now(),
      run,
    },
  });

  let seq = 1;
  const hasExistingSnapshot = Boolean(getCurrentSnapshotForProject(run.project_id));
  const starterTemplatesEnabled = isStarterTemplatesEnabled();
  let selectedStarterProfile: StarterTemplateProfileId | null = null;
  let selectedStarterReason: string | null = null;
  let selectedDiversitySeed: TemplateDiversitySeed | null = null;
  let workingFiles = ensureDeterministicPackageManifest(
    hasExistingSnapshot
      ? runSnapshotFiles(run.project_id)
      : starterTemplatesEnabled
        ? getStarterTemplateFiles()
        : []
  );

  const priorRunContext = getPriorRunContext(run.project_id, run.id);
  const specContextPack = buildThreadPromptContextPack({
    projectId: run.project_id,
    threadId: thread.id,
    triggerMessageId: triggerMessage.id,
    runId: run.id,
    phase: "spec",
    userPrompt: triggerMessage.content,
  });
  const threadContext = specContextPack.text;

  // ── Execution mode / scope classification ──
  // First-message runs (no prior snapshot) always stay feature_mode /
  // full_rebuild and never pay for a classification call. Follow-up runs
  // get a structured model decision (cheapest phase: reuse "spec"
  // providers), falling back to the old regex heuristic if that call fails.
  const specProviders = resolvePhaseProviders("spec");
  let executionMode: ExecutionMode = "feature_mode";
  let executionScope: ExecutionScope = "full_rebuild";
  let executionModeReasoning = "No prior snapshot; first run always builds from scratch.";
  let executionModeTargetPaths: string[] = [];
  if (hasExistingSnapshot) {
    const modeDecision = await resolveExecutionModeDecision({
      providers: specProviders,
      userPrompt: triggerMessage.content,
      threadContext,
      priorRunContext,
      files: workingFiles,
    });
    accumulateProviderDiagnostics(modeDecision.trace);
    executionMode = modeDecision.mode;
    executionScope = modeDecision.scope;
    executionModeReasoning = modeDecision.reasoning;
    executionModeTargetPaths = modeDecision.targetPaths;

    createRunArtifact({
      runId,
      kind: "metrics",
      title: "Execution mode decision",
      content: {
        executionMode,
        executionScope,
        reasoning: executionModeReasoning,
        targetPaths: executionModeTargetPaths,
        classifiedViaModel: modeDecision.classifiedViaModel,
      },
    });
  }

  const runtimeGateTimeoutMs = getRuntimeGateTimeoutMs();
  const skeletonAutofixPasses = getSkeletonAutofixPasses();
  const fixDagMaxPasses = getFixDagMaxPasses();
  const fillConcurrencyLimit = getFillConcurrency();

  // ── Spec ──
  const specStep = createRunStep({
    runId,
    seq: seq++,
    phase: "spec",
    status: "running",
    title: "Write product spec",
    detail: "Deriving requirements, acceptance criteria, and test checklist",
    payload: {},
  });
  publishStep(run, specStep.id);

  const specResult = await withCorrectivePromptRetry("spec generation", (correctiveNote) =>
    generateSpec({
      providers: specProviders,
      userPrompt: correctiveNote
        ? `${triggerMessage.content}\n\n${correctiveNote}`
        : triggerMessage.content,
      threadContext,
      priorRunContext,
      files: workingFiles,
      onPartial: (partial) => {
        publishRunEvent({
          type: "spec_progress",
          payload: {
            runId,
            projectId: run.project_id,
            timestamp: Date.now(),
            ...partial,
          },
        });
      },
    })
  );
  const spec = specResult.spec;

  const starterSelection = starterTemplatesEnabled
    ? selectStarterTemplateProfile({
      userPrompt: triggerMessage.content,
      spec,
    })
    : null;
  selectedDiversitySeed = starterSelection?.seed ?? null;

  if (!hasExistingSnapshot && starterSelection) {
    selectedStarterProfile = starterSelection.id;
    selectedStarterReason = starterSelection.reason;
    workingFiles = ensureDeterministicPackageManifest(getStarterTemplateFiles(starterSelection.id));
  }

  createRunArtifact({
    runId,
    kind: "spec",
    title: "Implementation spec",
    content: spec as unknown as Record<string, unknown>,
  });

  const diagnostics = initializeDiagnostics(0, executionMode);
  diagnostics.specQualityScore = estimateSpecQualityScore(spec);

  const specTelemetry = getTraceTelemetry("spec", specProviders, specResult.trace);
  updateRunStep({
    stepId: specStep.id,
    status: "complete",
    detail: `Defined ${spec.acceptanceCriteria.length} acceptance criteria`,
    payload: {
      spec,
      executionMode,
      executionScope,
      modeReasoning: executionModeReasoning,
      modeTargetPaths: executionModeTargetPaths,
      retrievedContextStats: specContextPack.stats,
      starterTemplate: selectedStarterProfile
        ? {
          profile: selectedStarterProfile,
          reason: selectedStarterReason,
          seededFileCount: workingFiles.length,
          diversitySeed: selectedDiversitySeed,
        }
        : !hasExistingSnapshot && !starterTemplatesEnabled
          ? {
            profile: "disabled",
            reason: "Starter templates disabled; running from neutral baseline scaffold.",
            seededFileCount: workingFiles.length,
            diversitySeed: selectedDiversitySeed,
          }
        : {
          profile: "project-snapshot",
          reason: "Existing project snapshot detected; starter template selection skipped.",
          seededFileCount: workingFiles.length,
          diversitySeed: selectedDiversitySeed,
        },
      model: specResult.trace,
      selectedModel: specTelemetry.selectedModel,
      modelCandidates: specTelemetry.modelCandidates,
      reasoningEnabled: specTelemetry.reasoningEnabled,
      phaseTimeoutMs: specTelemetry.phaseTimeoutMs,
      memoryCardIds: specContextPack.stats.selectedCardIds,
    },
  });
  publishStep(run, specStep.id);

  // ── Plan Outline ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "planning");

  const planOutlineContextPack = buildThreadPromptContextPack({
    projectId: run.project_id,
    threadId: thread.id,
    triggerMessageId: triggerMessage.id,
    runId: run.id,
    phase: "architect",
    userPrompt: triggerMessage.content,
  });

  const planOutlineStep = createRunStep({
    runId,
    seq: seq++,
    phase: "architect",
    status: "running",
    title: "Plan outline",
    detail: "Creating non-executing implementation DAG",
    payload: { executionMode },
  });
  publishStep(run, planOutlineStep.id);

  const planOutlineProviders = resolvePhaseProviders("architect");
  const planOutlineResult = await withCorrectivePromptRetry("plan outline generation", (correctiveNote) =>
    generatePlanOutline({
      providers: planOutlineProviders,
      userPrompt: correctiveNote
        ? `${triggerMessage.content}\n\n${correctiveNote}`
        : triggerMessage.content,
      threadContext: planOutlineContextPack.text,
      spec,
      files: workingFiles,
      diversitySeed: selectedDiversitySeed ?? undefined,
      executionMode,
      onPartial: (partial) => {
        publishRunEvent({
          type: "architect_progress",
          payload: {
            runId,
            projectId: run.project_id,
            timestamp: Date.now(),
            ...partial,
          },
        });
      },
    })
  );

  const planOutline = planOutlineResult.plan;
  planOutline.tasks = dedupeTasksBeforeExecution(planOutline.tasks, executionMode);
  diagnostics.tasksPlanned = planOutline.tasks.length;

  const planOutlineTelemetry = getTraceTelemetry(
    "architect",
    planOutlineProviders,
    planOutlineResult.trace
  );
  updateRunStep({
    stepId: planOutlineStep.id,
    status: "complete",
    detail: `Planned ${planOutline.tasks.length} non-executing tasks`,
    payload: {
      summary: planOutline.summary,
      tasks: planOutline.tasks,
      executionMode,
      retrievedContextStats: planOutlineContextPack.stats,
      model: planOutlineResult.trace,
      selectedModel: planOutlineTelemetry.selectedModel,
      modelCandidates: planOutlineTelemetry.modelCandidates,
      reasoningEnabled: planOutlineTelemetry.reasoningEnabled,
      phaseTimeoutMs: planOutlineTelemetry.phaseTimeoutMs,
      memoryCardIds: planOutlineContextPack.stats.selectedCardIds,
    },
  });
  publishStep(run, planOutlineStep.id);

  createRunArtifact({
    runId,
    kind: "metrics",
    title: "Plan outline",
    content: {
      summary: planOutline.summary,
      tasks: planOutline.tasks,
      executionMode,
    },
  });

  // ── Skeleton DAG Spec ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "planning");

  const skeletonDagStep = createRunStep({
    runId,
    seq: seq++,
    phase: "scaffold",
    status: "running",
    title: "Skeleton DAG spec",
    detail: "Building file-level DAG with contracts",
    payload: { executionMode, executionScope },
  });
  publishStep(run, skeletonDagStep.id);

  const skeletonDagProviders = resolvePhaseProviders("architect");
  const skeletonDagResult = await withCorrectivePromptRetry(
    "skeleton DAG generation",
    async (correctiveNote) => {
      const result = await generateSkeletonSpecDag({
        providers: skeletonDagProviders,
        userPrompt: correctiveNote
          ? `${triggerMessage.content}\n\n${correctiveNote}`
          : triggerMessage.content,
        threadContext: planOutlineContextPack.text,
        spec,
        files: workingFiles,
        planOutline,
        diversitySeed: selectedDiversitySeed ?? undefined,
        executionMode,
        scope: executionScope,
        targetPaths: executionModeTargetPaths,
        onPartial: (partial) => {
          publishRunEvent({
            type: "architect_progress",
            payload: {
              runId,
              projectId: run.project_id,
              timestamp: Date.now(),
              ...partial,
            },
          });
        },
      });

      const contractCount =
        result.dag.fileContracts.length +
        result.dag.tasks.flatMap((task) => task.fileContracts ?? []).length;
      if (contractCount === 0 || result.dag.nodes.length === 0) {
        throw new Error(
          "Skeleton DAG spec returned zero fileContracts or zero nodes. You MUST return at least one file contract and one node for the entry App component (e.g. src/App.jsx), including its imports, exports, and purpose."
        );
      }

      return result;
    }
  );
  const skeletonDag = skeletonDagResult.dag;
  const allFileContracts: FileContract[] = Array.from(
    new Map(
      skeletonDag.fileContracts
        .concat(skeletonDag.tasks.flatMap((task) => task.fileContracts ?? []))
        .map((contract) => [contract.path, contract] as const)
    ).values()
  );
  const dagNodes = Array.from(
    new Map(skeletonDag.nodes.map((node) => [normalizePath(node.path), node] as const)).values()
  );
  const skeletonRouteOwnedPaths = dagNodes
    .filter((node) => typeof node.routeOwnership === "string" && node.routeOwnership.trim().length > 0)
    .map((node) => normalizePath(node.path));

  if (allFileContracts.length === 0 || dagNodes.length === 0) {
    throw new Error("Skeleton DAG spec returned zero contracts/nodes");
  }

  // Targeted-edit scope: split DAG nodes into brand-new files (still go
  // through the normal skeleton -> fill pipeline below) and nodes whose path
  // already exists in the working tree (edited in place further down via
  // generateFileEdit, using their current content as the baseline instead of
  // a from-scratch skeleton). Untouched existing files never appear in
  // either list, so they pass through this run byte-identical.
  const targetedEditActive = executionScope === "targeted_edit";
  const existingWorkingFilePaths = new Set(
    workingFiles.map((file) => normalizePath(file.name))
  );
  const existingFileNodes: SkeletonDagNode[] = targetedEditActive
    ? dagNodes.filter((node) => existingWorkingFilePaths.has(normalizePath(node.path)))
    : [];
  const newFileNodes: SkeletonDagNode[] = targetedEditActive
    ? dagNodes.filter((node) => !existingWorkingFilePaths.has(normalizePath(node.path)))
    : dagNodes;
  // Existing-file-edit nodes are never run through skeleton generation, so
  // they won't carry BEGIN_FILL markers — exclude their contracts from
  // skeleton-phase contract-conformance validation below (final validation
  // still covers them once they're filled in).
  const skeletonValidationContracts = targetedEditActive
    ? allFileContracts.filter(
        (contract) => !existingWorkingFilePaths.has(normalizePath(contract.path))
      )
    : allFileContracts;

  const skeletonDagTelemetry = getTraceTelemetry(
    "architect",
    skeletonDagProviders,
    skeletonDagResult.trace
  );
  updateRunStep({
    stepId: skeletonDagStep.id,
    status: "complete",
    detail: `Skeleton DAG: ${dagNodes.length} nodes / ${allFileContracts.length} contracts`,
    payload: {
      summary: skeletonDag.summary,
      tasks: skeletonDag.tasks,
      nodeCount: dagNodes.length,
      newFileNodeCount: newFileNodes.length,
      existingFileNodeCount: existingFileNodes.length,
      fileContractCount: allFileContracts.length,
      dbSchema: skeletonDag.dbSchema ?? null,
      model: skeletonDagResult.trace,
      selectedModel: skeletonDagTelemetry.selectedModel,
      modelCandidates: skeletonDagTelemetry.modelCandidates,
      reasoningEnabled: skeletonDagTelemetry.reasoningEnabled,
      phaseTimeoutMs: skeletonDagTelemetry.phaseTimeoutMs,
    },
  });
  publishStep(run, skeletonDagStep.id);

  createRunArtifact({
    runId,
    kind: "metrics",
    title: "Skeleton DAG spec",
    content: {
      summary: skeletonDag.summary,
      tasks: skeletonDag.tasks,
      nodes: dagNodes,
      fileContracts: allFileContracts,
      dbSchema: skeletonDag.dbSchema ?? null,
    },
  });

  // ── Skeleton Generation ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "executing");

  const skeletonGenerateStep = createRunStep({
    runId,
    seq: seq++,
    phase: "scaffold",
    status: "running",
    title: "Generate skeleton files",
    detail: `Generating ${newFileNodes.length} skeleton files by DAG tiers`,
    payload: {
      nodeCount: newFileNodes.length,
      executionMode,
    },
  });
  publishStep(run, skeletonGenerateStep.id);

  const scaffoldProviders = resolvePhaseProviders("scaffold");
  const nodeTiers = buildDagTiers(
    newFileNodes.map((node) => ({
      id: normalizePath(node.path),
      dependsOn: node.dependsOnPaths.map((depPath) => normalizePath(depPath)),
      node,
    }))
  );
  const skeletonMap = new Map<string, SkeletonFile>();

  for (let tierIndex = 0; tierIndex < nodeTiers.length; tierIndex += 1) {
    const tier = nodeTiers[tierIndex];
    if (signal?.aborted) throw new Error("Run cancelled");
    const tierResults = await mapWithConcurrency(
      tier,
      fillConcurrencyLimit,
      async ({ node }) => {
        const result = await generateSkeletonFile({
          providers: scaffoldProviders,
          node,
          allContracts: allFileContracts,
          dbSchema: skeletonDag.dbSchema,
          spec,
          userPrompt: triggerMessage.content,
          onPartial: (partial) => {
            if (!partial.operations) return;
            publishRunEvent({
              type: "coder_progress",
              payload: {
                runId,
                projectId: run.project_id,
                timestamp: Date.now(),
                taskId: `skeleton-${normalizePath(node.path)}`,
                operations: partial.operations as unknown as FileOperation[],
              },
            });
          },
        });
        accumulateProviderDiagnostics(result.trace);
        return { path: normalizePath(node.path), result };
      }
    );

    const tierOps: FileOperation[] = tierResults.map(({ path, result }) => {
      const fixedCode = ensureFillRegionMarkers(path, result.skeleton.skeleton);
      skeletonMap.set(path, {
        ...result.skeleton,
        path,
        skeleton: fixedCode,
      });
      return {
        op: "upsert",
        path,
        code: fixedCode,
      };
    });

    const applied = applyOperationsWithEngineManifest(workingFiles, tierOps, {
      phase: "skeleton_generate",
      taskId: `tier-${tierIndex + 1}`,
    });
    workingFiles = applied.files;
    const counts = countOperationKinds(applied.appliedOperations);
    diagnostics.totalOperations += applied.appliedOperations.length;
    diagnostics.totalUpserts += counts.upserts;
    diagnostics.totalDeletes += counts.deletes;

    publishRunEvent({
      type: "coder_progress",
      payload: {
        runId,
        projectId: run.project_id,
        timestamp: Date.now(),
        taskId: `skeleton-tier-${tierIndex + 1}`,
        operations: tierOps,
      },
    });
  }

  updateRunStep({
    stepId: skeletonGenerateStep.id,
    status: "complete",
    detail: `Generated ${skeletonMap.size} skeleton files`,
    payload: {
      skeletonCount: skeletonMap.size,
      skeletonPaths: Array.from(skeletonMap.keys()).sort((left, right) =>
        left.localeCompare(right)
      ),
      tierCount: nodeTiers.length,
    },
  });
  publishStep(run, skeletonGenerateStep.id);

  // Publish a full skeleton snapshot before fill so the UI can render all files immediately.
  const skeletonSnapshotOps: FileOperation[] = Array.from(skeletonMap.entries()).map(
    ([path, skeleton]) => ({
      op: "upsert",
      path,
      code: skeleton.skeleton,
    })
  );
  publishRunEvent({
    type: "run_snapshot",
    payload: {
      runId,
      projectId: run.project_id,
      timestamp: Date.now(),
      taskId: "skeleton_snapshot",
      detail: `Published ${skeletonSnapshotOps.length} skeleton files before fill.`,
      operations: skeletonSnapshotOps,
    },
  });

  // ── Skeleton Validation + Autofix ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "validating");

  const skeletonValidationStep = createRunStep({
    runId,
    seq: seq++,
    phase: "validate",
    status: "running",
    title: "Validate skeleton contracts",
    detail: "Checking contract conformance before fill",
    payload: {
      skeletonAutofixPasses,
      fileContractCount: allFileContracts.length,
    },
  });
  publishStep(run, skeletonValidationStep.id);

  const enableSkeletonValidation = isSkeletonValidationEnabled();
  if (!enableSkeletonValidation) {
    updateRunStep({
      stepId: skeletonValidationStep.id,
      status: "complete",
      detail: "Skeleton validation disabled by configuration",
    });
    publishStep(run, skeletonValidationStep.id);
  } else {
    let skeletonIssues = validateSkeletonWorkingTree(workingFiles, skeletonValidationContracts, {
      routeOwnedPaths: skeletonRouteOwnedPaths,
    });
    let appliedAutofixOps = 0;

    for (
      let autofixPass = 1;
      skeletonIssues.length > 0 && autofixPass <= skeletonAutofixPasses;
      autofixPass += 1
    ) {
      const autofixStep = createRunStep({
        runId,
        seq: seq++,
        phase: "repair",
        status: "running",
        title: `Skeleton autofix pass ${autofixPass}`,
        detail: `Repairing ${skeletonIssues.length} skeleton issue(s)`,
        payload: {
          autofixPass,
          issues: skeletonIssues,
        },
      });
      publishStep(run, autofixStep.id);

      const autofixProviders = resolvePhaseProviders("repair_primary");
      const autofixResult = await generateSkeletonAutofix({
        providers: autofixProviders,
        userPrompt: triggerMessage.content,
        spec,
        files: workingFiles,
        issues: skeletonIssues.map((issue) => `${issue.file ?? "unknown"}: ${issue.message}`),
        fileContracts: allFileContracts,
      });
      accumulateProviderDiagnostics(autofixResult.trace);

      const autofixOps = autofixResult.operations.filter(
        (operation): operation is { op: "upsert"; path: string; code: string } =>
          operation.op === "upsert"
      );
      appliedAutofixOps += autofixOps.length;
      if (autofixOps.length > 0) {
        const applied = applyOperationsWithEngineManifest(workingFiles, autofixOps, {
          phase: "skeleton_autofix",
          taskId: `autofix-${autofixPass}`,
        });
        workingFiles = applied.files;
        const counts = countOperationKinds(applied.appliedOperations);
        diagnostics.totalOperations += applied.appliedOperations.length;
        diagnostics.totalUpserts += counts.upserts;
        diagnostics.totalDeletes += counts.deletes;
      }

      skeletonIssues = validateSkeletonWorkingTree(workingFiles, skeletonValidationContracts, {
        routeOwnedPaths: skeletonRouteOwnedPaths,
      });

      updateRunStep({
        stepId: autofixStep.id,
        status: skeletonIssues.length > 0 ? "error" : "complete",
        detail:
          skeletonIssues.length > 0
            ? `Autofix pass ${autofixPass} left ${skeletonIssues.length} issue(s)`
            : "Skeleton autofix resolved issues",
        payload: {
          autofixPass,
          operationCount: autofixOps.length,
          remainingIssues: skeletonIssues,
        },
      });
      publishStep(run, autofixStep.id);
    }

    if (skeletonIssues.length > 0) {
      updateRunStep({
        stepId: skeletonValidationStep.id,
        status: "error",
        detail: `Skeleton validation failed with ${skeletonIssues.length} issue(s)`,
        payload: {
          issues: skeletonIssues,
          appliedAutofixOps,
        },
      });
      publishStep(run, skeletonValidationStep.id);
      throw new Error(
        `Skeleton validation failed after ${skeletonAutofixPasses} autofix pass(es): ${skeletonIssues
          .slice(0, 4)
          .map((issue) => issue.message)
          .join(" | ")}`
      );
    }

    updateRunStep({
      stepId: skeletonValidationStep.id,
      status: "complete",
      detail: "Skeleton validation passed",
      payload: {
        issueCount: 0,
        appliedAutofixOps,
      },
    });
    publishStep(run, skeletonValidationStep.id);

    createRunArtifact({
      runId,
      kind: "metrics",
      title: "Skeleton validation report",
      content: {
        status: "pass",
        appliedAutofixOps,
        fileContractCount: allFileContracts.length,
      },
    });
  }

  // ── Fill Parallel ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "executing");

  const fillStep = createRunStep({
    runId,
    seq: seq++,
    phase: "coder",
    status: "running",
    title: "Fill function bodies in parallel",
    detail: `Filling ${skeletonMap.size} files (concurrency ${Math.min(fillConcurrencyLimit, Math.max(1, skeletonMap.size))})`,
    payload: {
      skeletonCount: skeletonMap.size,
      concurrency: Math.min(fillConcurrencyLimit, Math.max(1, skeletonMap.size)),
    },
  });
  publishStep(run, fillStep.id);

  const baseSkeletonFiles = workingFiles
    .filter((file) => skeletonMap.has(normalizePath(file.name)))
    .map((file) => ({ ...file, name: normalizePath(file.name) }));
  const structureLocks = buildStructureLocks(baseSkeletonFiles);
  const fillProviders = resolvePhaseProviders("coder");
  const fillResults = new Map<string, OperationResult>();

  const fillSettled = await mapSettledWithConcurrency(
    Array.from(skeletonMap.entries()),
    fillConcurrencyLimit,
    async ([nextPath, skeleton]) => {
      try {
        const result = await generateFillForSkeleton({
          providers: fillProviders,
          skeleton,
          allContracts: allFileContracts,
          workingFiles,
          dbSchema: skeletonDag.dbSchema,
          spec,
          userPrompt: triggerMessage.content,
          maxAttempts: 2,
          onPartial: (partial) => {
            if (!partial.operations) return;
            publishRunEvent({
              type: "coder_progress",
              payload: {
                runId,
                projectId: run.project_id,
                timestamp: Date.now(),
                taskId: `fill-${nextPath}`,
                operations: partial.operations as unknown as FileOperation[],
              },
            });
          },
        });
        return { path: nextPath, result };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error ?? "fill generation failed");
        throw new Error(`[${nextPath}] ${reason}`);
      }
    }
  );

  const lengthHitFiles = new Set<string>();
  const fallbackAttemptedFiles: string[] = [];
  const fallbackRecoveredFiles: string[] = [];
  const nonLengthFailures: Array<{ path: string; message: string }> = [];
  const unresolvedLengthFailures = new Map<string, string>();

  for (const settled of fillSettled) {
    if (settled.status === "fulfilled") {
      fillResults.set(settled.value.path, settled.value.result);
      accumulateProviderDiagnostics(settled.value.result.trace);
      if ((settled.value.result.lengthFinishSignals ?? 0) > 0) {
        lengthHitFiles.add(settled.value.path);
      }
      continue;
    }
    const rawMessage =
      settled.reason instanceof Error
        ? settled.reason.message
        : String(settled.reason ?? "Unknown fill failure");
    const pathMatch = rawMessage.match(/^\[([^\]]+)\]\s*(.*)$/);
    const pathName = pathMatch?.[1] ?? "unknown";
    const message = pathMatch?.[2] ?? rawMessage;
    if (isLengthLikeFailure(message)) {
      lengthHitFiles.add(pathName);
      unresolvedLengthFailures.set(pathName, message);
    } else {
      nonLengthFailures.push({ path: pathName, message });
    }
  }

  if (nonLengthFailures.length > 0) {
    updateRunStep({
      stepId: fillStep.id,
      status: "error",
      detail: `Fill phase failed for ${nonLengthFailures.length} non-length file(s)`,
      payload: {
        failedCount: nonLengthFailures.length,
        failures: nonLengthFailures,
        lengthHitFiles: Array.from(lengthHitFiles).sort((left, right) => left.localeCompare(right)),
        fallbackAttemptedFiles,
        fallbackRecoveredFiles,
        nonLengthFailures,
        completedCount: fillResults.size,
        lockCount: structureLocks.length,
      },
    });
    publishStep(run, fillStep.id);
    throw new Error(
      `Fill phase failed for ${nonLengthFailures.length} file(s): ${nonLengthFailures
        .slice(0, 3)
        .map((failure) => `${failure.path}: ${failure.message}`)
        .join(" | ")}`
    );
  }

  const lengthFallbackTargets = Array.from(lengthHitFiles)
    .filter((pathName) => skeletonMap.has(pathName))
    .sort((left, right) => left.localeCompare(right));
  const lengthFallbackProviders = resolveLengthFallbackProviders();
  if (lengthFallbackTargets.length > 0 && lengthFallbackProviders.length > 0) {
    const fallbackSettled = await Promise.allSettled(
      lengthFallbackTargets.map(async (pathName) => {
        fallbackAttemptedFiles.push(pathName);
        const skeleton = skeletonMap.get(pathName);
        if (!skeleton) {
          throw new Error(`[${pathName}] Missing skeleton for fallback`);
        }
        const result = await generateFillForSkeleton({
          providers: lengthFallbackProviders,
          skeleton,
          allContracts: allFileContracts,
          workingFiles,
          dbSchema: skeletonDag.dbSchema,
          spec,
          userPrompt: triggerMessage.content,
          maxAttempts: 2,
        });
        return { path: pathName, result };
      })
    );

    for (const settled of fallbackSettled) {
      if (settled.status === "fulfilled") {
        fillResults.set(settled.value.path, settled.value.result);
        accumulateProviderDiagnostics(settled.value.result.trace);
        fallbackRecoveredFiles.push(settled.value.path);
        unresolvedLengthFailures.delete(settled.value.path);
        continue;
      }
      const rawMessage =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason ?? "Length fallback failed");
      const pathMatch = rawMessage.match(/^\[([^\]]+)\]\s*(.*)$/);
      const pathName = pathMatch?.[1] ?? "unknown";
      const message = pathMatch?.[2] ?? rawMessage;
      if (!fillResults.has(pathName)) {
        unresolvedLengthFailures.set(pathName, message);
      }
    }
  }

  if (lengthFallbackTargets.length > 0 && lengthFallbackProviders.length === 0) {
    for (const pathName of lengthFallbackTargets) {
      if (!fillResults.has(pathName)) {
        unresolvedLengthFailures.set(
          pathName,
          "Length hit and no fallback model configured for coder phase."
        );
      }
    }
  }

  if (unresolvedLengthFailures.size > 0) {
    const unresolved = Array.from(unresolvedLengthFailures.entries())
      .map(([path, message]) => ({ path, message }))
      .sort((left, right) => left.path.localeCompare(right.path));
    updateRunStep({
      stepId: fillStep.id,
      status: "error",
      detail: `Fill phase failed for ${unresolved.length} length-hit file(s) without valid output`,
      payload: {
        failedCount: unresolved.length,
        failures: unresolved,
        lengthHitFiles: Array.from(lengthHitFiles).sort((left, right) => left.localeCompare(right)),
        fallbackAttemptedFiles,
        fallbackRecoveredFiles,
        nonLengthFailures,
        completedCount: fillResults.size,
        lockCount: structureLocks.length,
      },
    });
    publishStep(run, fillStep.id);
    throw new Error(
      `Fill phase failed for ${unresolved.length} length-hit file(s): ${unresolved
        .slice(0, 3)
        .map((failure) => `${failure.path}: ${failure.message}`)
        .join(" | ")}`
    );
  }

  const fillOperations: FileOperation[] = Array.from(fillResults.values()).flatMap((result) =>
    result.operations
      .filter(
        (operation): operation is { op: "upsert"; path: string; code: string } =>
          operation.op === "upsert"
      )
      .map((operation) => ({
        op: "upsert" as const,
        path: normalizePath(operation.path),
        code: operation.code,
      }))
  );

  let lockedFill = enforceStructureLockedFillOperations(baseSkeletonFiles, fillOperations);
  let fillStructureWarnings = lockedFill.violations.filter(
    (issue) => issue.code === "skeleton.fill_structure_changed"
  );
  let fillBlockingViolations = lockedFill.violations.filter(
    (issue) => issue.code !== "skeleton.fill_structure_changed"
  );

  const missingRegionIssues = fillBlockingViolations.filter(
    (issue) => issue.code === "skeleton.fill_region_missing" && issue.file && issue.regionId
  );

  if (missingRegionIssues.length > 0 && fillProviders.length > 0) {
    const missingByFile = new Map<string, string[]>();
    for (const issue of missingRegionIssues) {
      if (issue.file && issue.regionId) {
        const ids = missingByFile.get(issue.file) ?? [];
        ids.push(issue.regionId);
        missingByFile.set(issue.file, ids);
      }
    }

    const missingFallbackSettled = await Promise.allSettled(
      Array.from(missingByFile.entries()).map(async ([pathName, regionIds]) => {
        const skeleton = skeletonMap.get(pathName);
        if (!skeleton) throw new Error(`[${pathName}] Missing skeleton for fallback`);

        const candidateOp = fillOperations.find(
          (op): op is Extract<FileOperation, { op: "upsert" }> => op.op === "upsert" && op.path === pathName
        );
        const candidateCode = candidateOp?.code ?? "";

        const result = await generateMissingFillRegions({
          providers: fillProviders,
          skeleton,
          candidateCode,
          missingRegionIds: regionIds,
          userPrompt: triggerMessage.content,
          spec,
        });
        return { path: pathName, result };
      })
    );

    const recoveredPaths = new Set<string>();
    const missingFallbackFailures: Array<{ path: string; message: string }> = [];
    for (const settled of missingFallbackSettled) {
      if (settled.status === "fulfilled") {
        accumulateProviderDiagnostics(settled.value.result.trace);
        const pathName = settled.value.path;
        const skeleton = skeletonMap.get(pathName);
        if (!skeleton) {
          continue;
        }
        const recoveredOps = settled.value.result.operations;
        const candidateOp = fillOperations.find(
          (op): op is Extract<FileOperation, { op: "upsert" }> => op.op === "upsert" && op.path === pathName
        );
        const recoveredOp = recoveredOps.find(
          (op): op is Extract<FileOperation, { op: "upsert" }> => op.op === "upsert" && op.path === pathName
        );
        if (candidateOp) {
          candidateOp.code = mergeCandidateRegions({
            baseCode: skeleton.skeleton,
            candidateCode: candidateOp.code,
            recoveredCode: recoveredOp?.code,
          });
          recoveredPaths.add(pathName);
        }
        continue;
      }

      const rawMessage =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason ?? "Missing-region recovery failed");
      const pathMatch = rawMessage.match(/^\[([^\]]+)\]\s*(.*)$/);
      missingFallbackFailures.push({
        path: pathMatch?.[1] ?? "unknown",
        message: pathMatch?.[2] ?? rawMessage,
      });
    }

    if (missingFallbackFailures.length > 0) {
      fillStructureWarnings = fillStructureWarnings.concat(
        missingFallbackFailures.map((failure) => ({
          code: "skeleton.fill_region_recovery_failed",
          message: `[${failure.path}] ${failure.message}`,
          file: failure.path,
        }))
      );
    }

    // Even if recovery failed for a file, retain valid regions and restore missing
    // region markers from the original skeleton so the run can continue.
    for (const pathName of missingByFile.keys()) {
      if (recoveredPaths.has(pathName)) continue;
      const skeleton = skeletonMap.get(pathName);
      if (!skeleton) continue;
      const candidateOp = fillOperations.find(
        (op): op is Extract<FileOperation, { op: "upsert" }> => op.op === "upsert" && op.path === pathName
      );
      if (!candidateOp) continue;
      candidateOp.code = mergeCandidateRegions({
        baseCode: skeleton.skeleton,
        candidateCode: candidateOp.code,
      });
    }

    lockedFill = enforceStructureLockedFillOperations(baseSkeletonFiles, fillOperations);
    fillStructureWarnings = lockedFill.violations.filter(
      (issue) => issue.code === "skeleton.fill_structure_changed"
    );
    fillBlockingViolations = lockedFill.violations.filter(
      (issue) => issue.code !== "skeleton.fill_structure_changed"
    );
  }

  if (fillBlockingViolations.length > 0) {
    updateRunStep({
      stepId: fillStep.id,
      status: "error",
      detail: `Fill phase violated structure locks (${fillBlockingViolations.length} issue(s))`,
      payload: {
        violations: fillBlockingViolations,
        structureWarnings: fillStructureWarnings,
        lockCount: structureLocks.length,
      },
    });
    publishStep(run, fillStep.id);
    throw new Error(
      `Fill phase violated structure lock: ${fillBlockingViolations
        .slice(0, 3)
        .map((issue) => issue.message)
        .join(" | ")}`
    );
  }

  const fillApply = applyOperationsWithEngineManifest(workingFiles, lockedFill.operations, {
    phase: "fill_parallel",
  });
  workingFiles = fillApply.files;
  const fillCounts = countOperationKinds(fillApply.appliedOperations);
  diagnostics.totalOperations += fillApply.appliedOperations.length;
  diagnostics.totalUpserts += fillCounts.upserts;
  diagnostics.totalDeletes += fillCounts.deletes;
  diagnostics.tasksCompleted += fillResults.size;

  updateRunStep({
    stepId: fillStep.id,
    status: "complete",
    detail: `Filled ${fillResults.size} files with ${fillApply.appliedOperations.length} operation(s)`,
    payload: {
      filledCount: fillResults.size,
      operationCount: fillApply.appliedOperations.length,
      lockCount: structureLocks.length,
      structureWarnings: fillStructureWarnings,
      lengthHitFiles: Array.from(lengthHitFiles).sort((left, right) => left.localeCompare(right)),
      fallbackAttemptedFiles: Array.from(new Set(fallbackAttemptedFiles)).sort((left, right) =>
        left.localeCompare(right)
      ),
      fallbackRecoveredFiles: Array.from(new Set(fallbackRecoveredFiles)).sort((left, right) =>
        left.localeCompare(right)
      ),
      nonLengthFailures,
      selectedModel: fillProviders[0]?.model ?? "unknown",
      modelCandidates: fillProviders.map((provider) => provider.model),
      reasoningEnabled: fillProviders[0]?.reasoningEnabled ?? false,
      phaseTimeoutMs: fillProviders[0]?.timeoutMs ?? 0,
    },
  });
  publishStep(run, fillStep.id);

  createRunArtifact({
    runId,
    kind: "metrics",
    title: "Fill phase diagnostics",
    content: {
      lengthHitFiles: Array.from(lengthHitFiles).sort((left, right) => left.localeCompare(right)),
      fallbackAttemptedFiles: Array.from(new Set(fallbackAttemptedFiles)).sort((left, right) =>
        left.localeCompare(right)
      ),
      fallbackRecoveredFiles: Array.from(new Set(fallbackRecoveredFiles)).sort((left, right) =>
        left.localeCompare(right)
      ),
      nonLengthFailures,
      providerPrimary: fillProviders.map((provider) => provider.model),
      providerLengthFallback: lengthFallbackProviders.map((provider) => provider.model),
    },
  });

  // ── Existing-file Edits (targeted follow-up scope) ──
  // Runs after new-file skeleton+fill so an edit can reference freshly
  // created sibling files. Each node here already exists in workingFiles;
  // its current content is the baseline and the model returns the whole
  // updated file (no skeleton, no fill regions — see generateFileEdit).
  if (existingFileNodes.length > 0) {
    if (signal?.aborted) throw new Error("Run cancelled");
    run = updateRunAndReload(runId, "executing");

    const fileEditStep = createRunStep({
      runId,
      seq: seq++,
      phase: "coder",
      status: "running",
      title: "Edit existing files for follow-up",
      detail: `Editing ${existingFileNodes.length} existing file(s) in place`,
      payload: {
        targetPaths: existingFileNodes.map((node) => normalizePath(node.path)),
        executionMode,
        executionScope,
      },
    });
    publishStep(run, fileEditStep.id);

    const fileEditProviders = resolvePhaseProviders("coder");
    const fileEditSettled = await mapSettledWithConcurrency(
      existingFileNodes,
      fillConcurrencyLimit,
      async (node) => {
        const nodePath = normalizePath(node.path);
        const currentFile = workingFiles.find(
          (file) => normalizePath(file.name) === nodePath
        );
        if (!currentFile) {
          throw new Error(`[${nodePath}] Existing-file edit target not found in working tree`);
        }
        const result = await generateFileEdit({
          providers: fileEditProviders,
          node,
          currentCode: currentFile.code,
          allContracts: allFileContracts,
          spec,
          userPrompt: triggerMessage.content,
          onPartial: (partial) => {
            if (!partial.operations) return;
            publishRunEvent({
              type: "coder_progress",
              payload: {
                runId,
                projectId: run.project_id,
                timestamp: Date.now(),
                taskId: `file-edit-${nodePath}`,
                operations: partial.operations as unknown as FileOperation[],
              },
            });
          },
        });
        return { path: nodePath, result };
      }
    );

    const fileEditFailures: Array<{ path: string; message: string }> = [];
    let fileEditOps: FileOperation[] = [];
    for (const settled of fileEditSettled) {
      if (settled.status === "fulfilled") {
        accumulateProviderDiagnostics(settled.value.result.trace);
        fileEditOps = fileEditOps.concat(settled.value.result.operations);
        continue;
      }
      const rawMessage =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason ?? "Existing-file edit failed");
      const pathMatch = rawMessage.match(/^\[([^\]]+)\]\s*(.*)$/);
      fileEditFailures.push({
        path: pathMatch?.[1] ?? "unknown",
        message: pathMatch?.[2] ?? rawMessage,
      });
    }

    if (fileEditFailures.length > 0) {
      updateRunStep({
        stepId: fileEditStep.id,
        status: "error",
        detail: `Existing-file edit failed for ${fileEditFailures.length} file(s)`,
        payload: { failures: fileEditFailures },
      });
      publishStep(run, fileEditStep.id);
      throw new Error(
        `Existing-file edit failed for ${fileEditFailures.length} file(s): ${fileEditFailures
          .slice(0, 3)
          .map((failure) => `${failure.path}: ${failure.message}`)
          .join(" | ")}`
      );
    }

    // Routed through the same engine-manifest apply path as every other
    // phase, so stripPackageManifestOperations, per-op isolation, and the
    // downstream validation/fix-DAG gates all still apply unchanged.
    const fileEditApply = applyOperationsWithEngineManifest(workingFiles, fileEditOps, {
      phase: "existing_file_edit",
    });
    workingFiles = fileEditApply.files;
    const fileEditCounts = countOperationKinds(fileEditApply.appliedOperations);
    diagnostics.totalOperations += fileEditApply.appliedOperations.length;
    diagnostics.totalUpserts += fileEditCounts.upserts;
    diagnostics.totalDeletes += fileEditCounts.deletes;
    diagnostics.tasksCompleted += existingFileNodes.length;

    updateRunStep({
      stepId: fileEditStep.id,
      status: "complete",
      detail: `Edited ${existingFileNodes.length} existing file(s) with ${fileEditApply.appliedOperations.length} operation(s)`,
      payload: {
        editedPaths: existingFileNodes.map((node) => normalizePath(node.path)),
        operationCount: fileEditApply.appliedOperations.length,
      },
    });
    publishStep(run, fileEditStep.id);

    createRunArtifact({
      runId,
      kind: "metrics",
      title: "Existing-file edits",
      content: {
        editedPaths: existingFileNodes.map((node) => normalizePath(node.path)),
        operationCount: fileEditApply.appliedOperations.length,
      },
    });
  }

  // ── Post-fill Validation + Runtime Gate ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "validating");

  let blockingIssues: string[] = [];
  let runtimeDiagnostics: string[] = [];
  let terminalBuild: TerminalBuildCheckResult = {
    passed: true,
    install: null,
    build: null,
    issues: [],
    diagnostics: [],
    outputTail: [],
  };
  let previewRisk: PreviewRiskReport = { mode: "local", score: 0, reasons: [], blockers: [] };
  let finalValidationState: Awaited<ReturnType<typeof collectFinalValidationState>> | undefined;

  const enableFinalValidation = isFinalValidationEnabled();
  const enableQa = isQaEnabled();
  if (!enableFinalValidation) {
    const skippedValidationStep = createRunStep({
      runId,
      seq: seq++,
      phase: "validate",
      status: "complete",
      title: "Post-fill validation + runtime gate",
      detail: "Final validation disabled by configuration",
      payload: { executionMode },
    });
    publishStep(run, skippedValidationStep.id);
  } else {
    const postFillValidationStep = createRunStep({
      runId,
      seq: seq++,
      phase: "validate",
      status: "running",
      title: "Post-fill validation + runtime gate",
      detail: "Running validation, npm install, and npm run build",
      payload: { executionMode },
    });
    publishStep(run, postFillValidationStep.id);

    finalValidationState = await collectFinalValidationState(workingFiles, runtimeGateTimeoutMs);
    workingFiles = finalValidationState.validation.files;
    blockingIssues = finalValidationState.blockingIssues;
    runtimeDiagnostics = finalValidationState.runtimeDiagnostics;
    terminalBuild = finalValidationState.terminalBuild;
    previewRisk = finalValidationState.validation.previewRisk;

    updateRunStep({
      stepId: postFillValidationStep.id,
      status: blockingIssues.length > 0 ? "error" : "complete",
      detail:
        blockingIssues.length > 0
          ? `Validation/runtime gate found ${blockingIssues.length} blocker(s)`
          : "Validation/runtime gate passed",
      payload: {
        blockingIssues,
        runtimeDiagnostics,
        terminalBuild: terminalResultToPayload(terminalBuild),
        previewRisk,
      },
    });
    publishStep(run, postFillValidationStep.id);

    createRunArtifact({
      runId,
      kind: "metrics",
      title: "Terminal gate output",
      content: {
        blockingIssues,
        runtimeDiagnostics,
        terminalBuild: terminalResultToPayload(terminalBuild),
      },
    });
  }

  createRunArtifact({
    runId,
    kind: "metrics",
    title: "Terminal gate output",
    content: {
      blockingIssues,
      runtimeDiagnostics,
      terminalBuild: terminalResultToPayload(terminalBuild),
    },
  });

  // ── Fix DAG Remediation ──
  let remediationPass = 0;
  const enableFixDag = isFixDagEnabled();
  while (enableFixDag && blockingIssues.length > 0 && remediationPass < fixDagMaxPasses) {
    remediationPass += 1;
    diagnostics.repairPasses += 1;
    run = updateRunAndReload(runId, "repairing");

    const fixDagStep = createRunStep({
      runId,
      seq: seq++,
      phase: "repair",
      status: "running",
      title: `Fix DAG pass ${remediationPass}`,
      detail: `Planning and executing remediation for ${blockingIssues.length} blocker(s)`,
      payload: {
        remediationPass,
        blockingIssues,
      },
    });
    publishStep(run, fixDagStep.id);

    const fixDagProviders = resolvePhaseProviders("repair_primary");
    const fixDagResult = await generateFixDag({
      providers: fixDagProviders,
      userPrompt: triggerMessage.content,
      spec,
      files: workingFiles,
      issues: blockingIssues,
    });
    const fixDag = fixDagResult.dag;
    if (fixDag.tasks.length === 0) {
      throw new Error(`Fix DAG pass ${remediationPass} returned zero tasks.`);
    }

    const fixDagTelemetry = getTraceTelemetry(
      "repair_primary",
      fixDagProviders,
      fixDagResult.trace
    );

    const fixTiers = buildDagTiers(fixDag.tasks);
    let remediationOperationCount = 0;

    for (let tierIndex = 0; tierIndex < fixTiers.length; tierIndex += 1) {
      const tier = fixTiers[tierIndex];
      if (signal?.aborted) throw new Error("Run cancelled");
      const isParallel = tier.length > 1 && areFixWriteSetsDisjoint(tier);

      if (isParallel) {
        const tierResults = await mapWithConcurrency(tier, fillConcurrencyLimit, (task) =>
          generateFixOperations({
            providers: fixDagProviders,
            userPrompt: triggerMessage.content,
            threadContext,
            spec,
            files: workingFiles,
            task,
          }).then((result) => ({ task, result }))
        );

        for (const { task, result } of tierResults.sort((left, right) =>
          left.task.id.localeCompare(right.task.id)
        )) {
          accumulateProviderDiagnostics(result.trace);
          const applied = applyOperationsWithEngineManifest(workingFiles, result.operations, {
            phase: "fix_dag",
            taskId: task.id,
          });
          workingFiles = applied.files;
          remediationOperationCount += applied.appliedOperations.length;
          const counts = countOperationKinds(applied.appliedOperations);
          diagnostics.totalOperations += applied.appliedOperations.length;
          diagnostics.totalUpserts += counts.upserts;
          diagnostics.totalDeletes += counts.deletes;
          publishRunEvent({
            type: "coder_progress",
            payload: {
              runId,
              projectId: run.project_id,
              timestamp: Date.now(),
              taskId: task.id,
              operations: applied.appliedOperations,
            },
          });
        }
      } else {
        for (const task of tier) {
          const result = await generateFixOperations({
            providers: fixDagProviders,
            userPrompt: triggerMessage.content,
            threadContext,
            spec,
            files: workingFiles,
            task,
          });
          accumulateProviderDiagnostics(result.trace);
          const applied = applyOperationsWithEngineManifest(workingFiles, result.operations, {
            phase: "fix_dag",
            taskId: task.id,
          });
          workingFiles = applied.files;
          remediationOperationCount += applied.appliedOperations.length;
          const counts = countOperationKinds(applied.appliedOperations);
          diagnostics.totalOperations += applied.appliedOperations.length;
          diagnostics.totalUpserts += counts.upserts;
          diagnostics.totalDeletes += counts.deletes;
          publishRunEvent({
            type: "coder_progress",
            payload: {
              runId,
              projectId: run.project_id,
              timestamp: Date.now(),
              taskId: task.id,
              operations: applied.appliedOperations,
            },
          });
        }
      }
    }

    finalValidationState = await collectFinalValidationState(workingFiles, runtimeGateTimeoutMs);
    workingFiles = finalValidationState.validation.files;
    blockingIssues = finalValidationState.blockingIssues;
    runtimeDiagnostics = finalValidationState.runtimeDiagnostics;
    terminalBuild = finalValidationState.terminalBuild;
    previewRisk = finalValidationState.validation.previewRisk;

    createRunArtifact({
      runId,
      kind: "metrics",
      title: `Remediation DAG report (pass ${remediationPass})`,
      content: {
        remediationPass,
        summary: fixDag.summary,
        tasks: fixDag.tasks,
        operationCount: remediationOperationCount,
        remainingBlockers: blockingIssues,
      },
    });

    updateRunStep({
      stepId: fixDagStep.id,
      status: blockingIssues.length > 0 ? "error" : "complete",
      detail:
        blockingIssues.length > 0
          ? `Fix DAG pass ${remediationPass} left ${blockingIssues.length} blocker(s)`
          : `Fix DAG pass ${remediationPass} resolved blockers`,
      payload: {
        remediationPass,
        summary: fixDag.summary,
        taskCount: fixDag.tasks.length,
        operationCount: remediationOperationCount,
        remainingBlockers: blockingIssues,
        runtimeDiagnostics,
        terminalBuild: terminalResultToPayload(terminalBuild),
        model: fixDagResult.trace,
        selectedModel: fixDagTelemetry.selectedModel,
        modelCandidates: fixDagTelemetry.modelCandidates,
        reasoningEnabled: fixDagTelemetry.reasoningEnabled,
        phaseTimeoutMs: fixDagTelemetry.phaseTimeoutMs,
      },
    });
    publishStep(run, fixDagStep.id);
  }

  if (blockingIssues.length > 0) {
    if (!enableFixDag) {
      throw new Error(
        `Runtime/validation blockers remain and fix DAG is disabled: ${blockingIssues
          .slice(0, 4)
          .join(" | ")}`
      );
    }
    throw new Error(
      `Runtime/validation blockers remain after fix DAG passes: ${blockingIssues
        .slice(0, 4)
        .join(" | ")}`
    );
  }

  // ── QA ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "validating");

  let qaResult: QaResult = {
    qa: {
      score: 100,
      summary: "QA disabled by configuration",
      hardBlockers: [],
      softBlockers: [],
      warnings: [],
      acceptance: [],
      suggestedFixes: [],
      attempt: 1,
      maxAttempts: 1,
      blockingDecision: "pass",
    },
    trace: { provider: "none/none", usage: null, attempts: [] },
  };
  let qaContextPack: ThreadContextPack = {
    text: "",
    stats: {
      tokenEstimate: 0,
      tokenBudget: 0,
      selectedCardIds: [],
      droppedCardIds: [],
      summaryIds: [],
      recencyTurns: 0,
      compacted: false,
    },
  };
  let qaTelemetry: {
    selectedModel: string;
    modelCandidates: string[];
    reasoningEnabled: boolean;
    phaseTimeoutMs: number;
  } = { selectedModel: "none", modelCandidates: [], reasoningEnabled: false, phaseTimeoutMs: 0 };
  let qaHardBlockers: string[] = blockingIssues;
  let qaSoftBlockers: string[] = [];
  let qaPassed: boolean = qaHardBlockers.length === 0;

  const qaFixMaxPasses = getQaFixMaxPasses();

  // Runs one QA verdict pass, updating the qaResult/qaContextPack/qaTelemetry/
  // qaHardBlockers/qaSoftBlockers/qaPassed closures above and emitting the
  // run step + artifacts for it. Reused for the initial verdict and for
  // re-checking after each QA repair pass below.
  const runQaVerdictPass = async (
    attempt: number,
    maxAttempts: number,
    stepTitle: string
  ): Promise<void> => {
    const qaStep = createRunStep({
      runId,
      seq: seq++,
      phase: "qa",
      status: "running",
      title: stepTitle,
      detail: "Evaluating final output quality after strict runtime gate pass",
      payload: {
        executionMode,
        validationIssues: blockingIssues,
        runtimeDiagnostics,
        attempt,
        maxAttempts,
      },
    });
    publishStep(run, qaStep.id);

    qaContextPack = buildThreadPromptContextPack({
      projectId: run.project_id,
      threadId: thread.id,
      triggerMessageId: triggerMessage.id,
      runId: run.id,
      phase: "qa",
      userPrompt: [
        triggerMessage.content,
        "",
        "Validation blockers:",
        blockingIssues.length > 0 ? blockingIssues.join("\n") : "(none)",
        "",
        "Runtime diagnostics:",
        runtimeDiagnostics.length > 0 ? runtimeDiagnostics.join("\n") : "(none)",
        "",
        "Runtime output tail:",
        terminalBuild.outputTail.length > 0
          ? terminalBuild.outputTail.slice(-24).join("\n")
          : "(none)",
      ].join("\n"),
      tokenBudget: 12000,
    });

    const qaProviders = resolvePhaseProviders("qa");
    qaResult = await generateQaVerdict({
      providers: qaProviders,
      userPrompt: triggerMessage.content,
      threadContext: qaContextPack.text,
      spec,
      files: workingFiles,
      diversitySeed: selectedDiversitySeed ?? undefined,
      attempt,
      maxAttempts,
      validationIssues: blockingIssues,
      runtimeDiagnostics,
      onPartial: (partial) => {
        publishRunEvent({
          type: "qa_progress",
          payload: {
            runId,
            projectId: run.project_id,
            timestamp: Date.now(),
            ...partial,
          },
        });
      },
    });
    diagnostics.qaPasses += 1;

    qaTelemetry = getTraceTelemetry("qa", qaProviders, qaResult.trace);
    const normalizedQaBlockers = normalizeQaBlockers(qaResult.qa);
    // Runtime diagnostics are EVIDENCE shown to QA, not verdicts: they
    // include pass statements like "[terminal] npm run build passed", which
    // must never fail the gate. Only lines describing an actual failure may
    // join the blocker set.
    const failingDiagnostics = runtimeDiagnostics.filter((line) => {
      const lower = line.toLowerCase();
      if (/\bpass(?:ed)?\b|\bsucceed(?:ed)?\b|\bno issues\b/.test(lower)) {
        return false;
      }
      return /\bfail(?:ed|ure|s)?\b|\berror\b|\bcannot\b|\bunresolved\b|\bmissing\b|\bcrash/.test(lower);
    });
    qaHardBlockers = Array.from(
      new Set(blockingIssues.concat(failingDiagnostics).concat(normalizedQaBlockers.hardBlockers))
    );
    qaSoftBlockers = normalizedQaBlockers.softBlockers;
    qaPassed = qaHardBlockers.length === 0;

    updateRunStep({
      stepId: qaStep.id,
      status: qaPassed ? "complete" : "error",
      detail: qaPassed ? "Final quality gate passed" : "Final quality gate failed",
      payload: {
        ...qaResult.qa,
        hardBlockers: qaHardBlockers,
        softBlockers: qaSoftBlockers,
        validationIssues: blockingIssues,
        runtimeDiagnostics,
        previewRisk,
        executionMode,
        retrievedContextStats: qaContextPack.stats,
        memoryCardIds: qaContextPack.stats.selectedCardIds,
        model: qaResult.trace,
        selectedModel: qaTelemetry.selectedModel,
        modelCandidates: qaTelemetry.modelCandidates,
        reasoningEnabled: qaTelemetry.reasoningEnabled,
        phaseTimeoutMs: qaTelemetry.phaseTimeoutMs,
        attempt,
        maxAttempts,
        blockingDecision: qaPassed ? "pass" : "fail",
      },
    });
    publishStep(run, qaStep.id);

    createRunArtifact({
      runId,
      kind: "preview_risk",
      title: qaPassed ? "Preview risk analysis" : "Preview risk analysis (FAILED)",
      content: {
        mode: previewRisk.mode,
        score: previewRisk.score,
        reasons: previewRisk.reasons,
        blockers: previewRisk.blockers,
        validationIssues: blockingIssues,
      },
    });

    createRunArtifact({
      runId,
      kind: "qa",
      title: qaPassed ? "Quality gate report" : "Quality gate report (FAILED)",
      content: {
        ...qaResult.qa,
        hardBlockers: qaHardBlockers,
        softBlockers: qaSoftBlockers,
        validationIssues: blockingIssues,
        runtimeDiagnostics,
        blockingDecision: qaPassed ? "pass" : "fail",
      },
    });
  };

  if (!enableQa) {
    const skippedQaStep = createRunStep({
      runId,
      seq: seq++,
      phase: "qa",
      status: "complete",
      title: "Final quality gate",
      detail: "Final QA phase disabled by configuration",
      payload: { executionMode },
    });
    publishStep(run, skippedQaStep.id);
  } else {
    await runQaVerdictPass(1, 1 + qaFixMaxPasses, "Final quality gate");

    // QA repair loop: when the gate fails with hard blockers, give the model
    // up to DEXTER_QA_FIX_PASSES chances to close them with targeted whole-
    // file operations before failing the run outright. Each pass reuses the
    // same safety pipeline as fix-DAG operations (stripPackageManifestOperations
    // + per-operation isolation inside applyOperationsWithEngineManifest); no
    // structure locks apply since QA fixes are whole-file ops post-fill.
    let qaFixPass = 0;
    while (!qaPassed && qaFixPass < qaFixMaxPasses) {
      if (signal?.aborted) throw new Error("Run cancelled");
      qaFixPass += 1;
      diagnostics.qaFixPasses += 1;
      run = updateRunAndReload(runId, "repairing");

      const qaFixStep = createRunStep({
        runId,
        seq: seq++,
        phase: "repair",
        status: "running",
        title: `QA repair pass ${qaFixPass}`,
        detail: `Attempting to resolve ${qaHardBlockers.length} hard blocker(s) from the quality gate`,
        payload: { qaFixPass, hardBlockers: qaHardBlockers, softBlockers: qaSoftBlockers },
      });
      publishStep(run, qaFixStep.id);

      const qaFixProviders = resolvePhaseProviders("repair_primary");
      const qaFixResult = await generateQaFixOperations({
        providers: qaFixProviders,
        userPrompt: triggerMessage.content,
        threadContext: qaContextPack.text,
        spec,
        files: workingFiles,
        qa: { ...qaResult.qa, hardBlockers: qaHardBlockers, softBlockers: qaSoftBlockers },
        diversitySeed: selectedDiversitySeed ?? undefined,
        validationIssues: blockingIssues,
        runtimeDiagnostics,
      });
      accumulateProviderDiagnostics(qaFixResult.trace);

      const qaFixApplied = applyOperationsWithEngineManifest(workingFiles, qaFixResult.operations, {
        phase: "qa_fix",
      });
      workingFiles = qaFixApplied.files;
      const qaFixCounts = countOperationKinds(qaFixApplied.appliedOperations);
      diagnostics.totalOperations += qaFixApplied.appliedOperations.length;
      diagnostics.totalUpserts += qaFixCounts.upserts;
      diagnostics.totalDeletes += qaFixCounts.deletes;

      // Re-run static validation + the terminal build check only if the run
      // had them enabled in the first place; otherwise leave blockingIssues
      // as-is and let the next QA verdict pass judge on QA signal alone.
      if (enableFinalValidation) {
        finalValidationState = await collectFinalValidationState(workingFiles, runtimeGateTimeoutMs);
        workingFiles = finalValidationState.validation.files;
        blockingIssues = finalValidationState.blockingIssues;
        runtimeDiagnostics = finalValidationState.runtimeDiagnostics;
        terminalBuild = finalValidationState.terminalBuild;
        previewRisk = finalValidationState.validation.previewRisk;
      }

      updateRunStep({
        stepId: qaFixStep.id,
        status: "complete",
        detail: `QA repair pass ${qaFixPass} applied ${qaFixApplied.appliedOperations.length} operation(s)`,
        payload: {
          qaFixPass,
          summary: qaFixResult.summary,
          operationCount: qaFixApplied.appliedOperations.length,
          remainingValidationIssues: blockingIssues,
          runtimeDiagnostics,
          terminalBuild: terminalResultToPayload(terminalBuild),
        },
      });
      publishStep(run, qaFixStep.id);

      run = updateRunAndReload(runId, "validating");
      await runQaVerdictPass(
        qaFixPass + 1,
        1 + qaFixMaxPasses,
        `Final quality gate (after repair pass ${qaFixPass})`
      );
    }

    if (!qaPassed) {
      throw new Error(`Quality gate failed: ${qaHardBlockers.slice(0, 4).join(" | ")}`);
    }
  }

  // ── Finalize + Instant Preview ──
  if (signal?.aborted) throw new Error("Run cancelled");
  run = updateRunAndReload(runId, "executing");

  const finalizeStep = createRunStep({
    runId,
    seq: seq++,
    phase: "finalize",
    status: "running",
    title: "Persist snapshot and publish preview",
    detail: "Saving snapshot and publishing preview immediately",
    payload: {},
  });
  publishStep(run, finalizeStep.id);

  const provisionalSummary = `Completed skeleton-first pipeline with ${workingFiles.length} files.`;
  const parentSnapshot = getCurrentSnapshotForProject(run.project_id);
  const previousSnapshotFiles = parentSnapshot ? runSnapshotFiles(run.project_id) : [];

  const snapshot = createSnapshot({
    projectId: run.project_id,
    runId,
    parentSnapshotId: parentSnapshot?.id ?? null,
    summary: provisionalSummary,
    files: workingFiles,
  });
  setProjectCurrentSnapshot(run.project_id, snapshot.id);

  const previewDiff = parentSnapshot
    ? summarizeTreeChanges(previousSnapshotFiles, workingFiles)
    : null;
  const previewReused =
    !!previewDiff &&
    previewDiff.created.length === 0 &&
    previewDiff.updated.length === 0 &&
    previewDiff.deleted.length === 0;

  publishRunEvent({
    type: previewReused ? "preview_reused" : "preview_ready",
    payload: {
      runId,
      projectId: run.project_id,
      snapshotId: snapshot.id,
      timestamp: Date.now(),
      changedFiles: previewDiff,
    },
  });

  const finalizeProviders = resolvePhaseProviders("finalize");
  const summaryResult = await generateFinalSummary({
    providers: finalizeProviders,
    userPrompt: triggerMessage.content,
    files: workingFiles,
  });
  accumulateProviderDiagnostics(summaryResult.trace);
  const summary = summaryResult.summary || provisionalSummary;

  createMessage({
    threadId: run.thread_id,
    role: "assistant",
    content: summary,
    meta: {
      runId,
      snapshotId: snapshot.id,
      files: workingFiles.map((file) => file.name),
      diagnostics,
      completionMode: "strict",
      qa: {
        score: qaResult.qa.score,
        previewRiskMode: previewRisk.mode,
        previewRiskScore: previewRisk.score,
      },
    },
  });

  const persistedMemoryCardIds = persistRunMemoryCards({
    projectId: run.project_id,
    runId,
    specSummary: spec.summary,
    planSummary: skeletonDag.summary,
    lockedConstraints: spec.requirements,
    hardBlockers: [],
    verifiedFixes: qaResult.qa.acceptance
      .filter((item) => item.status === "pass")
      .map((item) => `${item.criterion}: ${item.evidence}`),
  });

  if (persistedMemoryCardIds.length > 0) {
    publishRunEvent({
      type: "memory_cards_updated",
      payload: {
        runId,
        projectId: run.project_id,
        timestamp: Date.now(),
        memoryCardIds: persistedMemoryCardIds,
        detail: `Persisted ${persistedMemoryCardIds.length} memory cards`,
      },
    });
  }

  createRunArtifact({
    runId,
    kind: "metrics",
    title: "Run metrics",
    content: {
      executionMode,
      executionScope,
      diagnostics,
      fileCount: workingFiles.length,
      snapshotId: snapshot.id,
      fixDagMaxPasses,
      skeletonAutofixPasses,
    },
  });

  updateRunStep({
    stepId: finalizeStep.id,
    status: "complete",
    detail: `Saved snapshot with ${workingFiles.length} files`,
    payload: {
      snapshotId: snapshot.id,
      summary,
      files: workingFiles.map((file) => file.name),
      diagnostics,
      executionMode,
      qa: qaResult.qa,
      previewRisk,
      model: summaryResult.trace,
      selectedModel:
        summaryResult.trace?.attempts.find((attempt) => attempt.ok)?.model ??
        finalizeProviders[0]?.model ??
        "unknown",
      modelCandidates: finalizeProviders.map((provider) => provider.model),
      reasoningEnabled: finalizeProviders[0]?.reasoningEnabled ?? false,
      phaseTimeoutMs: finalizeProviders[0]?.timeoutMs ?? 0,
    },
  });
  publishStep(run, finalizeStep.id);

  run = updateRunAndReload(runId, "completed");
  publishRunEvent({
    type: "run_completed",
    payload: {
      runId,
      projectId: run.project_id,
      timestamp: Date.now(),
      run,
      snapshotId: snapshot.id,
      summary,
      detail: "Completed in strict skeleton-first mode",
    },
  });
}
// ─── Public API ───────────────────────────────────────────────────

export async function executeRun({ runId }: ExecutionInput): Promise<void> {
  const run = ensureRunExists(runId);
  const controller = new AbortController();
  const hardTimeoutMs = getRunHardTimeoutMs();
  let hardTimeoutTriggered = false;
  let hardTimeoutHandle: NodeJS.Timeout | null = null;
  runAbortControllers.set(runId, controller);

  try {
    hardTimeoutHandle = setTimeout(() => {
      hardTimeoutTriggered = true;
      controller.abort();
    }, hardTimeoutMs);

    await executeRunInternal({ runId, signal: controller.signal });
  } catch (caughtError) {
    const error =
      hardTimeoutTriggered && controller.signal.aborted
        ? new Error(`Run exceeded hard timeout of ${hardTimeoutMs}ms.`)
        : caughtError;

    if (controller.signal.aborted && !hardTimeoutTriggered) {
      console.log(`[run:${runId}] aborted via signal`);
      try {
        updateRunAndReload(runId, "cancelled", "Run cancelled by user request");
      } catch { /* likely deleted */ }
      return;
    }

    // If the run was deleted (e.g. project deletion), we can't update it. Just abort.
    if (
      !hardTimeoutTriggered &&
      error instanceof Error &&
      (error.message.includes("Run not found") ||
        error.message.includes("FOREIGN KEY constraint failed") ||
        error.message === "Run cancelled")
    ) {
      console.log(`[run:${runId}] aborted: ${error.message}`);
      return;
    }

    const message = toUserFacingAgentError(error);

    const activeSteps = listRunSteps(runId).filter(
      (step) => step.status === "running" || step.status === "pending"
    );
    for (const step of activeSteps) {
      updateRunStep({
        stepId: step.id,
        status: "error",
        detail: `Run aborted: ${message}`,
      });
      publishStep(run, step.id);
    }

    const failedRun = updateRunAndReload(runId, "failed", message);

    const failureMemoryCardIds = persistRunMemoryCards({
      projectId: failedRun.project_id,
      runId,
      specSummary: "Run failed before completion",
      planSummary: message,
      hardBlockers: [message],
      lockedConstraints: [],
      verifiedFixes: [],
    });
    if (failureMemoryCardIds.length > 0) {
      publishRunEvent({
        type: "memory_cards_updated",
        payload: {
          runId,
          projectId: failedRun.project_id,
          timestamp: Date.now(),
          memoryCardIds: failureMemoryCardIds,
          detail: `Persisted ${failureMemoryCardIds.length} failure memory cards`,
        },
      });
    }

    createMessage({
      threadId: failedRun.thread_id,
      role: "assistant",
      content: `Run failed: ${message}`,
      meta: { runId, failed: true },
    });

    publishRunEvent({
      type: "run_failed",
      payload: {
        runId,
        projectId: run.project_id,
        timestamp: Date.now(),
        run: failedRun,
        error: message,
      },
    });

    console.error(`[run:${runId}] failed`, error);
  } finally {
    if (hardTimeoutHandle) {
      clearTimeout(hardTimeoutHandle);
    }
    runAbortControllers.delete(runId);
  }
}

async function executeClaimedRun(runId: string): Promise<void> {
  const guard = getExecutionGuard();
  if (guard.has(runId)) {
    return;
  }

  guard.add(runId);
  try {
    await executeRun({ runId });
  } finally {
    guard.delete(runId);
  }
}

async function drainQueuedRuns(): Promise<void> {
  while (true) {
    const claimed = claimNextQueuedRun();
    if (!claimed) {
      break;
    }
    await executeClaimedRun(claimed.id);
  }
}

function scheduleRunDispatcherTick(delayMs: number): void {
  const state = getRunDispatcherState();
  if (state.timer) {
    clearTimeout(state.timer);
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    void runDispatcherTick();
  }, Math.max(0, delayMs));
}

async function runDispatcherTick(): Promise<void> {
  const state = getRunDispatcherState();
  if (!isRunDispatcherEnabled()) {
    state.running = false;
    state.wakeRequested = false;
    return;
  }

  if (state.running) {
    state.wakeRequested = true;
    return;
  }

  state.running = true;
  try {
    await drainQueuedRuns();
  } catch (error) {
    console.error("[run-dispatcher] tick failed", error);
  } finally {
    state.running = false;
    const immediate = state.wakeRequested;
    state.wakeRequested = false;
    scheduleRunDispatcherTick(immediate ? 0 : getRunDispatchPollMs());
  }
}

export function ensureRunDispatcherStarted(): void {
  if (!isRunDispatcherEnabled()) {
    return;
  }

  const state = getRunDispatcherState();
  if (state.started) {
    return;
  }

  state.started = true;
  scheduleRunDispatcherTick(0);
}

function requestRunDispatcherWake(): void {
  ensureRunDispatcherStarted();
  const state = getRunDispatcherState();
  if (state.running) {
    state.wakeRequested = true;
    return;
  }
  scheduleRunDispatcherTick(0);
}

export function queueRunExecution(runId: string): void {
  ensureRunDispatcherStarted();
  setTimeout(() => {
    const claimed = claimQueuedRunById(runId);
    if (claimed) {
      void executeClaimedRun(claimed.id).finally(() => {
        requestRunDispatcherWake();
      });
      return;
    }
    requestRunDispatcherWake();
  }, 0);
}

export function describeRunForLog(run: RunRow): string {
  return toSafeJson({
    id: run.id,
    projectId: run.project_id,
    threadId: run.thread_id,
    status: run.status,
    model: run.model,
    createdAt: run.created_at,
  });
}
