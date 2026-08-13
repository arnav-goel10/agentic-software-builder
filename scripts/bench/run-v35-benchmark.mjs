#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = process.env.BENCH_BASE_URL || "http://localhost:3000";
const DEFAULT_PROMPTS_PATH = "scripts/bench/prompts-v35.json";
const DEFAULT_OUTPUT_DIR = "artifacts/benchmarks";
const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    promptsPath: DEFAULT_PROMPTS_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    pollMs: DEFAULT_POLL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--base-url" && next) {
      args.baseUrl = next;
      index += 1;
      continue;
    }
    if (token === "--prompts" && next) {
      args.promptsPath = next;
      index += 1;
      continue;
    }
    if (token === "--output-dir" && next) {
      args.outputDir = next;
      index += 1;
      continue;
    }
    if (token === "--poll-ms" && next) {
      args.pollMs = Number.parseInt(next, 10) || DEFAULT_POLL_MS;
      index += 1;
      continue;
    }
    if (token === "--timeout-ms" && next) {
      args.timeoutMs = Number.parseInt(next, 10) || DEFAULT_TIMEOUT_MS;
      index += 1;
      continue;
    }
  }

  return args;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return sorted[middle];
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "0s";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m ${remainder}s`;
}

async function fetchJson(baseUrl, route, init = undefined) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const bodyText = await response.text();
  let payload = null;
  try {
    payload = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.error || payload?.message || bodyText || `HTTP ${response.status}`;
    throw new Error(`${route} -> ${response.status}: ${String(message).slice(0, 500)}`);
  }

  return payload;
}

async function loadPrompts(promptsPath) {
  const raw = await readFile(promptsPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Prompts file must be an array: ${promptsPath}`);
  }
  return parsed.map((row, index) => {
    const prompt = typeof row?.prompt === "string" ? row.prompt.trim() : "";
    if (!prompt) {
      throw new Error(`Prompt at index ${index} is empty`);
    }
    const category = typeof row?.category === "string" ? row.category.trim() : "uncategorized";
    return {
      category,
      prompt,
    };
  });
}

async function runSinglePrompt({ baseUrl, category, prompt, index, pollMs, timeoutMs }) {
  const startedAt = Date.now();
  const projectName = `[bench:${category}] ${index + 1}`;

  const created = await fetchJson(baseUrl, "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name: projectName }),
  });

  const projectId = created.project.id;
  const threadId = created.thread.id;

  const message = await fetchJson(baseUrl, `/api/projects/${projectId}/messages`, {
    method: "POST",
    body: JSON.stringify({ threadId, content: prompt }),
  });

  const runCreated = await fetchJson(baseUrl, `/api/projects/${projectId}/runs`, {
    method: "POST",
    body: JSON.stringify({ threadId, messageId: message.message.id }),
  });

  const runId = runCreated.runId;
  const deadline = Date.now() + timeoutMs;
  let latestRun = null;
  let latestSteps = [];
  let latestArtifacts = [];

  while (Date.now() < deadline) {
    const runData = await fetchJson(baseUrl, `/api/projects/${projectId}/runs/${runId}`);
    latestRun = runData.run;
    latestSteps = Array.isArray(runData.steps) ? runData.steps : [];
    latestArtifacts = Array.isArray(runData.artifacts) ? runData.artifacts : [];

    if (["completed", "failed", "cancelled"].includes(latestRun.status)) {
      break;
    }

    await sleep(pollMs);
  }

  if (!latestRun) {
    throw new Error(`Run ${runId} did not return data`);
  }

  if (!["completed", "failed", "cancelled"].includes(latestRun.status)) {
    throw new Error(`Run ${runId} timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  const details = await fetchJson(baseUrl, `/api/projects/${projectId}`);
  const finishedAt = latestRun.finished_at || Date.now();
  const createdAt = latestRun.created_at || startedAt;
  const durationMs = Math.max(1, finishedAt - createdAt);
  const previewReady = Boolean(details.currentSnapshot && Array.isArray(details.currentSnapshot.files) && details.currentSnapshot.files.length > 0);

  const qaArtifact = latestArtifacts.find((artifact) => artifact.kind === "qa");
  const metricsArtifact = latestArtifacts.find((artifact) => artifact.kind === "metrics");

  return {
    category,
    prompt,
    projectId,
    runId,
    status: latestRun.status,
    model: latestRun.model,
    error: latestRun.error,
    durationMs,
    stepCount: latestSteps.length,
    artifactCount: latestArtifacts.length,
    qaScore: qaArtifact?.content?.score ?? null,
    hardBlockers: Array.isArray(qaArtifact?.content?.hardBlockers)
      ? qaArtifact.content.hardBlockers.length
      : null,
    fallbackSwitches: metricsArtifact?.content?.diagnostics?.fallbackSwitches ?? null,
    phaseTimeouts: metricsArtifact?.content?.diagnostics?.phaseTimeouts ?? null,
    previewReady,
    createdAt,
    finishedAt,
  };
}

function buildSummary(entries) {
  const total = entries.length;
  const completed = entries.filter((entry) => entry.status === "completed");
  const failed = entries.filter((entry) => entry.status === "failed");
  const cancelled = entries.filter((entry) => entry.status === "cancelled");

  const durations = entries.map((entry) => entry.durationMs);
  const completionDurations = completed.map((entry) => entry.durationMs);

  const byCategory = new Map();
  for (const entry of entries) {
    const current = byCategory.get(entry.category) || {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      medianDurationMs: 0,
      durations: [],
    };
    current.total += 1;
    if (entry.status === "completed") current.completed += 1;
    if (entry.status === "failed") current.failed += 1;
    if (entry.status === "cancelled") current.cancelled += 1;
    current.durations.push(entry.durationMs);
    byCategory.set(entry.category, current);
  }

  const categories = Array.from(byCategory.entries()).map(([category, row]) => ({
    category,
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    cancelled: row.cancelled,
    completionRate: row.total ? Number((row.completed / row.total).toFixed(3)) : 0,
    medianDurationMs: median(row.durations),
    p95DurationMs: percentile(row.durations, 95),
  }));

  return {
    total,
    completed: completed.length,
    failed: failed.length,
    cancelled: cancelled.length,
    completionRate: total ? Number((completed.length / total).toFixed(3)) : 0,
    medianDurationMs: median(durations),
    p95DurationMs: percentile(durations, 95),
    medianCompletedDurationMs: median(completionDurations),
    p95CompletedDurationMs: percentile(completionDurations, 95),
    previewBootSuccessRate: completed.length
      ? Number((completed.filter((entry) => entry.previewReady).length / completed.length).toFixed(3))
      : 0,
    categories,
  };
}

function toMarkdownReport(report) {
  const lines = [];
  lines.push(`# Dexter v3.5 Benchmark Report`);
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Base URL: ${report.baseUrl}`);
  lines.push(`- Prompt file: ${report.promptsPath}`);
  lines.push("");
  lines.push(`## Global Metrics`);
  lines.push(`- Total runs: ${report.summary.total}`);
  lines.push(`- Completed: ${report.summary.completed}`);
  lines.push(`- Failed: ${report.summary.failed}`);
  lines.push(`- Cancelled: ${report.summary.cancelled}`);
  lines.push(`- Completion rate: ${(report.summary.completionRate * 100).toFixed(1)}%`);
  lines.push(`- Median duration: ${formatDuration(report.summary.medianDurationMs)}`);
  lines.push(`- P95 duration: ${formatDuration(report.summary.p95DurationMs)}`);
  lines.push(`- Median completed duration: ${formatDuration(report.summary.medianCompletedDurationMs)}`);
  lines.push(`- P95 completed duration: ${formatDuration(report.summary.p95CompletedDurationMs)}`);
  lines.push(`- Preview boot success (completed runs): ${(report.summary.previewBootSuccessRate * 100).toFixed(1)}%`);
  lines.push("");
  lines.push(`## Category Metrics`);
  lines.push(`| Category | Total | Completed | Failed | Completion Rate | Median | P95 |`);
  lines.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
  for (const row of report.summary.categories) {
    lines.push(
      `| ${row.category} | ${row.total} | ${row.completed} | ${row.failed} | ${(row.completionRate * 100).toFixed(1)}% | ${formatDuration(row.medianDurationMs)} | ${formatDuration(row.p95DurationMs)} |`
    );
  }

  lines.push("");
  lines.push(`## Slowest 10 Runs`);
  lines.push(`| Category | Status | Duration | Prompt | Error |`);
  lines.push(`| --- | --- | ---: | --- | --- |`);
  const slowest = [...report.entries]
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, 10);
  for (const row of slowest) {
    const prompt = row.prompt.replace(/\|/g, "\\|").slice(0, 90);
    const error = (row.error || "").replace(/\|/g, "\\|").slice(0, 120);
    lines.push(
      `| ${row.category} | ${row.status} | ${formatDuration(row.durationMs)} | ${prompt} | ${error} |`
    );
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompts = await loadPrompts(args.promptsPath);

  console.log(`[bench] Loaded ${prompts.length} prompts from ${args.promptsPath}`);
  console.log(`[bench] Base URL: ${args.baseUrl}`);

  const entries = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const item = prompts[index];
    const label = `${index + 1}/${prompts.length}`;
    console.log(`[bench] (${label}) ${item.category}: ${item.prompt.slice(0, 80)}${item.prompt.length > 80 ? "..." : ""}`);

    try {
      const entry = await runSinglePrompt({
        baseUrl: args.baseUrl,
        category: item.category,
        prompt: item.prompt,
        index,
        pollMs: args.pollMs,
        timeoutMs: args.timeoutMs,
      });
      entries.push(entry);
      console.log(`[bench] (${label}) status=${entry.status} duration=${formatDuration(entry.durationMs)} qa=${entry.qaScore ?? "n/a"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({
        category: item.category,
        prompt: item.prompt,
        projectId: null,
        runId: null,
        status: "failed",
        model: null,
        error: message,
        durationMs: 0,
        stepCount: 0,
        artifactCount: 0,
        qaScore: null,
        hardBlockers: null,
        fallbackSwitches: null,
        phaseTimeouts: null,
        previewReady: false,
        createdAt: Date.now(),
        finishedAt: Date.now(),
      });
      console.error(`[bench] (${label}) failed early: ${message}`);
    }
  }

  const summary = buildSummary(entries);
  const report = {
    generatedAt: nowIso(),
    baseUrl: args.baseUrl,
    promptsPath: args.promptsPath,
    summary,
    entries,
  };

  await mkdir(args.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(args.outputDir, `v35-benchmark-${stamp}.json`);
  const markdownPath = path.join(args.outputDir, `v35-benchmark-${stamp}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, `${toMarkdownReport(report)}\n`, "utf8");

  console.log(`[bench] Report JSON: ${jsonPath}`);
  console.log(`[bench] Report Markdown: ${markdownPath}`);
  console.log(`[bench] Completion rate: ${(summary.completionRate * 100).toFixed(1)}%`);
  console.log(`[bench] Median: ${formatDuration(summary.medianDurationMs)} | P95: ${formatDuration(summary.p95DurationMs)}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[bench] Fatal: ${message}`);
  process.exitCode = 1;
});
