#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function parseArgs(argv) {
  const args = {
    dbPath: process.env.DEXTER_DB_PATH?.trim() || path.resolve("data/dexter.sqlite"),
    limit: 100,
    allowEmpty: false,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--db" && next) {
      args.dbPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      args.limit = Number.isFinite(parsed) && parsed > 0 ? parsed : args.limit;
      index += 1;
      continue;
    }
    if (token === "--allow-empty") {
      args.allowEmpty = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
  }

  return args;
}

function tableExists(db, tableName) {
  const row = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type IN ('table', 'view') AND name = ?`
    )
    .get(tableName);
  return Boolean(row?.name);
}

function normalizeFailureSignature(message) {
  if (!message || typeof message !== "string") {
    return "unknown_error";
  }
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<uuid>")
    .replace(/\bline\s+\d+\b/gi, "line <n>")
    .replace(/\bstatus=\d+\b/gi, "status=<n>")
    .replace(/\b\d{2,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function classifyFailure(signature) {
  const lower = signature.toLowerCase();
  if (lower.includes("invalid json")) return "provider_invalid_json";
  if (lower.includes("quality gate failed")) return "qa_or_validation_blocker";
  if (lower.includes("no allowed operations")) return "task_write_set_rejection";
  if (lower.includes("no effective operations") || lower.includes("zero effective operations")) {
    return "no_effective_ops";
  }
  if (lower.includes("patch failed")) return "legacy_patch_failure";
  if (lower.includes("failed to resolve import")) return "import_contract_failure";
  if (lower.includes("react hook violation")) return "react_hook_rule_failure";
  if (lower.includes("api quota") || lower.includes("rate limit")) return "provider_quota_or_rate_limit";
  if (lower.includes("user not found") || lower.includes("status=<n>")) return "provider_auth_or_routing";
  return "other";
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.dbPath)) {
    const message = `DB not found: ${args.dbPath}`;
    if (args.allowEmpty) {
      console.log(`SKIP ${message}`);
      process.exit(0);
    }
    console.error(`FAIL ${message}`);
    process.exit(2);
  }

  const db = new Database(args.dbPath, { readonly: true });
  if (!tableExists(db, "runs")) {
    const message = `DB has no runs table: ${args.dbPath}`;
    if (args.allowEmpty) {
      console.log(`SKIP ${message}`);
      process.exit(0);
    }
    console.error(`FAIL ${message}`);
    process.exit(2);
  }

  const runs = db
    .prepare(
      `SELECT id, project_id, status, model, error, created_at, finished_at
       FROM runs
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(args.limit);

  if (runs.length === 0) {
    const message = "No runs found";
    if (args.allowEmpty) {
      console.log(`SKIP ${message}`);
      process.exit(0);
    }
    console.error(`FAIL ${message}`);
    process.exit(2);
  }

  const failedRuns = runs.filter((run) => run.status === "failed");
  const grouped = new Map();
  for (const run of failedRuns) {
    const signature = normalizeFailureSignature(run.error || "unknown_error");
    const classification = classifyFailure(signature);
    const current = grouped.get(signature) || {
      signature,
      classification,
      count: 0,
      runIds: [],
      models: new Set(),
      latestAt: 0,
    };
    current.count += 1;
    current.runIds.push(run.id);
    if (run.model) current.models.add(run.model);
    current.latestAt = Math.max(current.latestAt, run.created_at || 0);
    grouped.set(signature, current);
  }

  const topFailures = Array.from(grouped.values())
    .sort((left, right) => right.count - left.count || right.latestAt - left.latestAt)
    .map((entry) => ({
      signature: entry.signature,
      classification: entry.classification,
      count: entry.count,
      latestAt: entry.latestAt,
      sampleRunIds: entry.runIds.slice(0, 5),
      models: Array.from(entry.models).sort((a, b) => a.localeCompare(b)),
    }));

  const result = {
    dbPath: args.dbPath,
    scanned: runs.length,
    failed: failedRuns.length,
    completed: runs.filter((run) => run.status === "completed").length,
    cancelled: runs.filter((run) => run.status === "cancelled").length,
    topFailures,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Run Failure Analysis");
  console.log(`DB: ${args.dbPath}`);
  console.log(`Scanned: ${result.scanned}`);
  console.log(`Failed: ${result.failed}`);
  console.log(`Completed: ${result.completed}`);
  console.log(`Cancelled: ${result.cancelled}`);
  if (topFailures.length === 0) {
    console.log("\nNo failed runs in the sampled window.");
    return;
  }

  console.log("\nTop failure signatures:");
  for (const failure of topFailures.slice(0, 12)) {
    console.log(`- (${failure.count}) [${failure.classification}] ${failure.signature}`);
  }
}

run();
