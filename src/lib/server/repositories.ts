import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/server/db";
import type {
  GeneratedFile,
  MemoryCardRow,
  MemoryCardType,
  MemoryRetrievalLogRow,
  MessageRole,
  MessageRow,
  ParsedMessage,
  ParsedMemoryCard,
  ParsedMemoryRetrievalLog,
  ParsedRunArtifact,
  ParsedRunStep,
  ParsedSnapshot,
  ParsedThreadSummary,
  ThreadSummaryPayload,
  ThreadSummaryRow,
  ProjectRow,
  ProjectSummary,
  RunArtifactKind,
  RunArtifactRow,
  RunRow,
  RunStatus,
  RunStepRow,
  SnapshotRow,
  StepPhase,
  StepStatus,
  ThreadRow,
} from "@/lib/server/types";

const ACTIVE_RUN_STATUSES: RunStatus[] = [
  "queued",
  "planning",
  "executing",
  "validating",
  "repairing",
];

const TERMINAL_RUN_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);
const DEFAULT_RUN_STALE_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_RUN_STALE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_RUN_HARD_TIMEOUT_MS = 45 * 60 * 1000;
const RUN_STALE_TIMEOUT_BUFFER_MS = 5 * 60 * 1000;

function parseRunStaleTimeoutMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_RUN_STALE_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_RUN_STALE_TIMEOUT_MS) {
    return DEFAULT_RUN_STALE_TIMEOUT_MS;
  }

  return parsed;
}

function parseRunHardTimeoutMs(raw: string | undefined): number {
  if (!raw) {
    return DEFAULT_RUN_HARD_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_RUN_STALE_TIMEOUT_MS) {
    return DEFAULT_RUN_HARD_TIMEOUT_MS;
  }

  return parsed;
}

const RUN_HARD_TIMEOUT_MS = parseRunHardTimeoutMs(process.env.DEXTER_RUN_TIMEOUT_MS);
const RUN_STALE_TIMEOUT_MS = Math.max(
  parseRunStaleTimeoutMs(process.env.DEXTER_RUN_STALE_TIMEOUT_MS),
  RUN_HARD_TIMEOUT_MS + RUN_STALE_TIMEOUT_BUFFER_MS
);

const DEFAULT_THREAD_TITLE = "Main";

function now(): number {
  return Date.now();
}

function isActiveRunStatus(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

function getRunByIdRaw(runId: string): RunRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
       FROM runs
       WHERE id = ?`
    )
    .get(runId) as RunRow | undefined;
  return row ?? null;
}

function getRunLastActivityAt(run: RunRow): number {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MAX(
         CASE
           WHEN COALESCE(finished_at, 0) > COALESCE(started_at, 0)
             THEN COALESCE(finished_at, 0)
           ELSE COALESCE(started_at, 0)
         END
       ) AS last_activity
       FROM run_steps
       WHERE run_id = ?`
    )
    .get(run.id) as { last_activity: number | null } | undefined;

  const lastStepActivity = typeof row?.last_activity === "number" ? row.last_activity : 0;
  return Math.max(run.created_at, lastStepActivity);
}

function reconcileRunIfStale(run: RunRow): RunRow {
  if (!isActiveRunStatus(run.status)) {
    return run;
  }

  const lastActivityAt = getRunLastActivityAt(run);
  const idleMs = now() - lastActivityAt;
  if (idleMs <= RUN_STALE_TIMEOUT_MS) {
    return run;
  }

  const idleMinutes = Math.max(1, Math.floor(idleMs / 60000));
  const reason = `Run timed out after ${idleMinutes}m without progress; marked failed automatically.`;

  const db = getDb();
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
  const finishedAt = now();
  const result = db
    .prepare(
      `UPDATE runs
       SET status = 'failed',
           error = ?,
           started_at = COALESCE(started_at, ?),
           finished_at = ?
       WHERE id = ? AND status IN (${placeholders})`
    )
    .run(reason, run.started_at ?? run.created_at, finishedAt, run.id, ...ACTIVE_RUN_STATUSES);

  if (result.changes > 0) {
    const activeSteps = db
      .prepare(
        `SELECT id
         FROM run_steps
         WHERE run_id = ? AND status IN ('pending', 'running')`
      )
      .all(run.id) as Array<{ id: string }>;

    for (const step of activeSteps) {
      updateRunStep({
        stepId: step.id,
        status: "error",
        detail: `Run aborted: ${reason}`,
      });
    }

    updateProjectTimestamp(run.project_id);
  }

  const refreshed = getRunByIdRaw(run.id);
  if (refreshed) {
    return refreshed;
  }

  return {
    ...run,
    status: "failed",
    error: reason,
    finished_at: finishedAt,
    started_at: run.started_at ?? run.created_at,
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseFilesJson(value: string): GeneratedFile[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((file) => {
        if (!file || typeof file !== "object") return null;
        const row = file as {
          name?: unknown;
          code?: unknown;
          language?: unknown;
        };
        if (typeof row.name !== "string" || typeof row.code !== "string") {
          return null;
        }
        const normalized: GeneratedFile = {
          name: row.name,
          code: row.code,
          language: typeof row.language === "string" ? row.language : undefined,
        };
        return normalized;
      })
      .filter((item): item is GeneratedFile => item !== null);
  } catch {
    return [];
  }
}

export function toParsedMessage(row: MessageRow): ParsedMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    meta: parseJsonObject(row.meta_json),
    createdAt: row.created_at,
  };
}

export function toParsedThreadSummary(row: ThreadSummaryRow): ParsedThreadSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    startMessageId: row.start_message_id,
    endMessageId: row.end_message_id,
    summary: parseJsonObject(row.summary_json),
    createdAt: row.created_at,
  };
}

export function toParsedMemoryCard(row: MemoryCardRow): ParsedMemoryCard {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    text: row.text,
    sourceRunId: row.source_run_id,
    weight: row.weight,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toParsedMemoryRetrievalLog(
  row: MemoryRetrievalLogRow
): ParsedMemoryRetrievalLog {
  return {
    id: row.id,
    runId: row.run_id,
    phase: row.phase,
    selectedCardIds: parseJsonStringArray(row.selected_card_ids_json),
    droppedCardIds: parseJsonStringArray(row.dropped_card_ids_json),
    tokenEstimate: row.token_estimate,
    createdAt: row.created_at,
  };
}

export function toParsedRunStep(row: RunStepRow): ParsedRunStep {
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    phase: row.phase,
    status: row.status,
    title: row.title,
    detail: row.detail,
    payload: parseJsonObject(row.payload_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export function toParsedSnapshot(row: SnapshotRow): ParsedSnapshot {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    parentSnapshotId: row.parent_snapshot_id,
    summary: row.summary,
    files: parseFilesJson(row.files_json),
    createdAt: row.created_at,
  };
}

export function toParsedRunArtifact(row: RunArtifactRow): ParsedRunArtifact {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    content: parseJsonObject(row.content_json),
    createdAt: row.created_at,
  };
}

export function createProject(input: {
  name: string;
  description?: string | null;
}): ProjectRow {
  const db = getDb();
  const id = randomUUID();
  const timestamp = now();

  db.prepare(
    `INSERT INTO projects (id, name, description, status, current_snapshot_id, created_at, updated_at)
     VALUES (?, ?, ?, 'active', NULL, ?, ?)`
  ).run(id, input.name.trim(), input.description?.trim() || null, timestamp, timestamp);

  return getProjectById(id)!;
}

export function listProjects(): ProjectSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         p.id AS p_id,
         p.name AS p_name,
         p.description AS p_description,
         p.status AS p_status,
         p.current_snapshot_id AS p_current_snapshot_id,
         p.created_at AS p_created_at,
         p.updated_at AS p_updated_at,

         s.id AS s_id,
         s.project_id AS s_project_id,
         s.run_id AS s_run_id,
         s.parent_snapshot_id AS s_parent_snapshot_id,
         s.summary AS s_summary,
         s.files_json AS s_files_json,
         s.created_at AS s_created_at,

         r.id AS r_id,
         r.project_id AS r_project_id,
         r.thread_id AS r_thread_id,
         r.trigger_message_id AS r_trigger_message_id,
         r.status AS r_status,
         r.model AS r_model,
         r.error AS r_error,
         r.created_at AS r_created_at,
         r.started_at AS r_started_at,
         r.finished_at AS r_finished_at
       FROM projects p
       LEFT JOIN snapshots s ON s.id = p.current_snapshot_id
       LEFT JOIN runs r ON r.id = (
         SELECT r2.id
         FROM runs r2
         WHERE r2.project_id = p.id
         ORDER BY r2.created_at DESC
         LIMIT 1
       )
       ORDER BY p.updated_at DESC`
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const project: ProjectRow = {
      id: String(row.p_id),
      name: String(row.p_name),
      description: (row.p_description as string | null) ?? null,
      status: row.p_status as ProjectRow["status"],
      current_snapshot_id: (row.p_current_snapshot_id as string | null) ?? null,
      created_at: Number(row.p_created_at),
      updated_at: Number(row.p_updated_at),
    };

    const snapshot: SnapshotRow | null = row.s_id
      ? {
        id: String(row.s_id),
        project_id: String(row.s_project_id),
        run_id: String(row.s_run_id),
        parent_snapshot_id: (row.s_parent_snapshot_id as string | null) ?? null,
        summary: String(row.s_summary),
        files_json: String(row.s_files_json),
        created_at: Number(row.s_created_at),
      }
      : null;

    let latestRun: RunRow | null = row.r_id
      ? {
        id: String(row.r_id),
        project_id: String(row.r_project_id),
        thread_id: String(row.r_thread_id),
        trigger_message_id: String(row.r_trigger_message_id),
        status: row.r_status as RunStatus,
        model: String(row.r_model),
        error: (row.r_error as string | null) ?? null,
        created_at: Number(row.r_created_at),
        started_at: (row.r_started_at as number | null) ?? null,
        finished_at: (row.r_finished_at as number | null) ?? null,
      }
      : null;

    if (latestRun) {
      latestRun = reconcileRunIfStale(latestRun);
    }

    return {
      project,
      currentSnapshot: snapshot,
      latestRun,
    } satisfies ProjectSummary;
  });
}

export function getProjectById(projectId: string): ProjectRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, name, description, status, current_snapshot_id, created_at, updated_at
       FROM projects
       WHERE id = ?`
    )
    .get(projectId) as ProjectRow | undefined;

  return row ?? null;
}

export function deleteProjectById(projectId: string): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
  return result.changes > 0;
}

export function updateProjectTimestamp(projectId: string): void {
  const db = getDb();
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now(), projectId);
}

export function setProjectCurrentSnapshot(projectId: string, snapshotId: string): void {
  const db = getDb();
  db.prepare(`UPDATE projects SET current_snapshot_id = ?, updated_at = ? WHERE id = ?`).run(
    snapshotId,
    now(),
    projectId
  );
}

export function createThread(input: { projectId: string; title?: string }): ThreadRow {
  const db = getDb();
  const id = randomUUID();
  const timestamp = now();

  db.prepare(
    `INSERT INTO threads (id, project_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, input.projectId, input.title?.trim() || DEFAULT_THREAD_TITLE, timestamp, timestamp);

  return getThreadById(id)!;
}

export function getThreadById(threadId: string): ThreadRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, title, created_at, updated_at
       FROM threads
       WHERE id = ?`
    )
    .get(threadId) as ThreadRow | undefined;
  return row ?? null;
}

export function getDefaultThreadForProject(projectId: string): ThreadRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, title, created_at, updated_at
       FROM threads
       WHERE project_id = ?
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(projectId) as ThreadRow | undefined;

  return row ?? null;
}

export function ensureDefaultThread(projectId: string): ThreadRow {
  const existing = getDefaultThreadForProject(projectId);
  if (existing) return existing;
  return createThread({ projectId, title: DEFAULT_THREAD_TITLE });
}

export function listMessagesByThread(threadId: string): MessageRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, thread_id, role, content, meta_json, created_at
       FROM messages
       WHERE thread_id = ?
       ORDER BY created_at ASC`
    )
    .all(threadId) as MessageRow[];
}

export function listThreadSummariesByThread(
  threadId: string,
  limit = 24
): ThreadSummaryRow[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return db
    .prepare(
      `SELECT id, thread_id, start_message_id, end_message_id, summary_json, created_at
       FROM thread_summaries
       WHERE thread_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(threadId, safeLimit) as ThreadSummaryRow[];
}

export function createThreadSummary(input: {
  threadId: string;
  startMessageId: string;
  endMessageId: string;
  summary: ThreadSummaryPayload | Record<string, unknown>;
}): ThreadSummaryRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();
  db.prepare(
    `INSERT INTO thread_summaries (id, thread_id, start_message_id, end_message_id, summary_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.threadId,
    input.startMessageId,
    input.endMessageId,
    JSON.stringify(input.summary ?? {}),
    createdAt
  );

  const row = db
    .prepare(
      `SELECT id, thread_id, start_message_id, end_message_id, summary_json, created_at
       FROM thread_summaries
       WHERE id = ?`
    )
    .get(id) as ThreadSummaryRow | undefined;

  if (!row) {
    throw new Error("Failed to create thread summary");
  }
  return row;
}

function hasMemoryCardsFts(): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'memory_cards_fts'`
    )
    .get() as { name?: string } | undefined;
  return Boolean(row?.name);
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/g)
    .map((token) => token.trim().replace(/["'*:()]/g, ""))
    .filter((token) => token.length >= 2)
    .map((token) => `${token}*`)
    .slice(0, 12)
    .join(" ");
}

export function createOrUpdateMemoryCard(input: {
  projectId: string;
  type: MemoryCardType;
  text: string;
  sourceRunId?: string | null;
  weight?: number;
}): MemoryCardRow {
  const db = getDb();
  const normalizedText = input.text.trim();
  if (!normalizedText) {
    throw new Error("Memory card text cannot be empty");
  }

  const timestamp = now();
  const existing = db
    .prepare(
      `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
       FROM memory_cards
       WHERE project_id = ? AND type = ? AND text = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    )
    .get(input.projectId, input.type, normalizedText) as MemoryCardRow | undefined;

  if (existing) {
    const nextWeight = Math.max(
      0.1,
      Number(existing.weight ?? 1) + Number(input.weight ?? 1)
    );
    db.prepare(
      `UPDATE memory_cards
       SET source_run_id = COALESCE(?, source_run_id),
           weight = ?,
           updated_at = ?
       WHERE id = ?`
    ).run(input.sourceRunId ?? null, nextWeight, timestamp, existing.id);

    return (
      db
        .prepare(
          `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
           FROM memory_cards
           WHERE id = ?`
        )
        .get(existing.id) as MemoryCardRow
    );
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO memory_cards (
      id, project_id, type, text, source_run_id, weight, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.projectId,
    input.type,
    normalizedText,
    input.sourceRunId ?? null,
    Math.max(0.1, Number(input.weight ?? 1)),
    timestamp,
    timestamp
  );

  return (
    db
      .prepare(
        `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
         FROM memory_cards
         WHERE id = ?`
      )
      .get(id) as MemoryCardRow
  );
}

export function listMemoryCardsByProject(input: {
  projectId: string;
  limit?: number;
  types?: MemoryCardType[];
}): MemoryCardRow[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 32)));
  const types = Array.isArray(input.types)
    ? input.types.filter((type): type is MemoryCardType => typeof type === "string")
    : [];
  if (types.length === 0) {
    return db
      .prepare(
        `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
         FROM memory_cards
         WHERE project_id = ?
         ORDER BY weight DESC, updated_at DESC
         LIMIT ?`
      )
      .all(input.projectId, safeLimit) as MemoryCardRow[];
  }

  const placeholders = types.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
       FROM memory_cards
       WHERE project_id = ? AND type IN (${placeholders})
       ORDER BY weight DESC, updated_at DESC
       LIMIT ?`
    )
    .all(input.projectId, ...types, safeLimit) as MemoryCardRow[];
}

export function searchMemoryCardsByProject(input: {
  projectId: string;
  query: string;
  limit?: number;
  types?: MemoryCardType[];
}): MemoryCardRow[] {
  const db = getDb();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 24)));
  const query = input.query.trim();
  const types = Array.isArray(input.types)
    ? input.types.filter((type): type is MemoryCardType => typeof type === "string")
    : [];

  if (!query) {
    return listMemoryCardsByProject({
      projectId: input.projectId,
      limit: safeLimit,
      types,
    });
  }

  if (hasMemoryCardsFts()) {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery) {
      try {
        if (types.length > 0) {
          const placeholders = types.map(() => "?").join(",");
          return db
            .prepare(
              `SELECT m.id, m.project_id, m.type, m.text, m.source_run_id, m.weight, m.created_at, m.updated_at
               FROM memory_cards_fts f
               JOIN memory_cards m ON m.id = f.card_id
               WHERE f.project_id = ?
                 AND f.type IN (${placeholders})
                 AND memory_cards_fts MATCH ?
               ORDER BY bm25(memory_cards_fts), m.weight DESC, m.updated_at DESC
               LIMIT ?`
            )
            .all(input.projectId, ...types, ftsQuery, safeLimit) as MemoryCardRow[];
        }

        return db
          .prepare(
            `SELECT m.id, m.project_id, m.type, m.text, m.source_run_id, m.weight, m.created_at, m.updated_at
             FROM memory_cards_fts f
             JOIN memory_cards m ON m.id = f.card_id
             WHERE f.project_id = ?
               AND memory_cards_fts MATCH ?
             ORDER BY bm25(memory_cards_fts), m.weight DESC, m.updated_at DESC
             LIMIT ?`
          )
          .all(input.projectId, ftsQuery, safeLimit) as MemoryCardRow[];
      } catch {
        // Fall through to LIKE query fallback.
      }
    }
  }

  const likeQuery = `%${query.toLowerCase()}%`;
  if (types.length > 0) {
    const placeholders = types.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
         FROM memory_cards
         WHERE project_id = ?
           AND type IN (${placeholders})
           AND LOWER(text) LIKE ?
         ORDER BY weight DESC, updated_at DESC
         LIMIT ?`
      )
      .all(input.projectId, ...types, likeQuery, safeLimit) as MemoryCardRow[];
  }

  return db
    .prepare(
      `SELECT id, project_id, type, text, source_run_id, weight, created_at, updated_at
       FROM memory_cards
       WHERE project_id = ? AND LOWER(text) LIKE ?
       ORDER BY weight DESC, updated_at DESC
       LIMIT ?`
    )
    .all(input.projectId, likeQuery, safeLimit) as MemoryCardRow[];
}

export function createMemoryRetrievalLog(input: {
  runId: string;
  phase: string;
  selectedCardIds: string[];
  droppedCardIds: string[];
  tokenEstimate: number;
}): MemoryRetrievalLogRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();
  db.prepare(
    `INSERT INTO memory_retrieval_logs (
      id, run_id, phase, selected_card_ids_json, dropped_card_ids_json, token_estimate, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.runId,
    input.phase,
    JSON.stringify(input.selectedCardIds ?? []),
    JSON.stringify(input.droppedCardIds ?? []),
    Math.max(0, Math.floor(input.tokenEstimate ?? 0)),
    createdAt
  );

  const row = db
    .prepare(
      `SELECT id, run_id, phase, selected_card_ids_json, dropped_card_ids_json, token_estimate, created_at
       FROM memory_retrieval_logs
       WHERE id = ?`
    )
    .get(id) as MemoryRetrievalLogRow | undefined;
  if (!row) {
    throw new Error("Failed to create memory retrieval log");
  }
  return row;
}

export function listMemoryRetrievalLogsByRun(runId: string): MemoryRetrievalLogRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, run_id, phase, selected_card_ids_json, dropped_card_ids_json, token_estimate, created_at
       FROM memory_retrieval_logs
       WHERE run_id = ?
       ORDER BY created_at ASC`
    )
    .all(runId) as MemoryRetrievalLogRow[];
}

export function createMessage(input: {
  threadId: string;
  role: MessageRole;
  content: string;
  meta?: Record<string, unknown>;
}): MessageRow {
  const db = getDb();
  const id = randomUUID();
  const timestamp = now();
  db.prepare(
    `INSERT INTO messages (id, thread_id, role, content, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.threadId,
    input.role,
    input.content,
    JSON.stringify(input.meta ?? {}),
    timestamp
  );

  db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(timestamp, input.threadId);

  return getMessageById(id)!;
}

export function getMessageById(messageId: string): MessageRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, thread_id, role, content, meta_json, created_at
       FROM messages
       WHERE id = ?`
    )
    .get(messageId) as MessageRow | undefined;
  return row ?? null;
}

export function createRun(input: {
  projectId: string;
  threadId: string;
  triggerMessageId: string;
  model: string;
}): RunRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.prepare(
    `INSERT INTO runs (
      id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
     ) VALUES (?, ?, ?, ?, 'queued', ?, NULL, ?, NULL, NULL)`
  ).run(id, input.projectId, input.threadId, input.triggerMessageId, input.model, createdAt);

  updateProjectTimestamp(input.projectId);
  return getRunById(id)!;
}

export function listQueuedRuns(limit = 50): RunRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
       FROM runs
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as RunRow[];
}

function claimQueuedRunWithSelection(selectSql: string, args: unknown[] = []): RunRow | null {
  const db = getDb();
  const claimedAt = now();
  let inTransaction = false;

  try {
    db.prepare(`BEGIN IMMEDIATE`).run();
    inTransaction = true;

    const queuedRun = db.prepare(selectSql).get(...args) as RunRow | undefined;
    if (!queuedRun) {
      db.prepare(`COMMIT`).run();
      inTransaction = false;
      return null;
    }

    const claimed = db
      .prepare(
        `UPDATE runs
         SET status = 'planning',
             started_at = COALESCE(started_at, ?),
             finished_at = NULL
         WHERE id = ?
           AND status = 'queued'`
      )
      .run(claimedAt, queuedRun.id);

    if (claimed.changes !== 1) {
      db.prepare(`ROLLBACK`).run();
      inTransaction = false;
      return null;
    }

    db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(claimedAt, queuedRun.project_id);

    const claimedRun = db
      .prepare(
        `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
         FROM runs
         WHERE id = ?`
      )
      .get(queuedRun.id) as RunRow | undefined;

    db.prepare(`COMMIT`).run();
    inTransaction = false;

    if (claimedRun) {
      return claimedRun;
    }

    return {
      ...queuedRun,
      status: "planning",
      started_at: queuedRun.started_at ?? claimedAt,
      finished_at: null,
    };
  } catch (error) {
    if (inTransaction) {
      try {
        db.prepare(`ROLLBACK`).run();
      } catch {
        // Ignore rollback errors to preserve original error.
      }
    }
    throw error;
  }
}

export function claimQueuedRunById(runId: string): RunRow | null {
  return claimQueuedRunWithSelection(
    `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
     FROM runs
     WHERE id = ?
       AND status = 'queued'
     LIMIT 1`,
    [runId]
  );
}

export function claimNextQueuedRun(): RunRow | null {
  return claimQueuedRunWithSelection(
    `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
     FROM runs
     WHERE status = 'queued'
     ORDER BY created_at ASC
     LIMIT 1`
  );
}

export function findActiveRunForProject(projectId: string): RunRow | null {
  const db = getDb();
  const placeholders = ACTIVE_RUN_STATUSES.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
       FROM runs
       WHERE project_id = ? AND status IN (${placeholders})
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(projectId, ...ACTIVE_RUN_STATUSES) as RunRow | undefined;

  if (!row) return null;

  const reconciled = reconcileRunIfStale(row);
  if (!isActiveRunStatus(reconciled.status)) {
    return null;
  }

  return reconciled;
}

export function getRunById(runId: string): RunRow | null {
  const row = getRunByIdRaw(runId);
  if (!row) return null;
  return reconcileRunIfStale(row);
}

export function listRunsByProject(projectId: string): RunRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
       FROM runs
       WHERE project_id = ?
       ORDER BY created_at DESC`
    )
    .all(projectId) as RunRow[];

  return rows.map((row) => reconcileRunIfStale(row));
}

export function getPreviousCompletedRun(projectId: string, currentRunId: string): RunRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
       FROM runs
       WHERE project_id = ? AND id <> ? AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(projectId, currentRunId) as RunRow | undefined;

  return row ?? null;
}

export function listRecentRuns(limit = 50): Array<RunRow & { project_name: string }> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         r.id,
         r.project_id,
         r.thread_id,
         r.trigger_message_id,
         r.status,
         r.model,
         r.error,
         r.created_at,
         r.started_at,
         r.finished_at,
         p.name AS project_name
       FROM runs r
       JOIN projects p ON p.id = r.project_id
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .all(limit) as Array<RunRow & { project_name: string }>;

  return rows.map((row) => {
    const reconciled = reconcileRunIfStale({
      id: row.id,
      project_id: row.project_id,
      thread_id: row.thread_id,
      trigger_message_id: row.trigger_message_id,
      status: row.status,
      model: row.model,
      error: row.error,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
    });
    return {
      ...row,
      ...reconciled,
      project_name: row.project_name,
    };
  });
}

export function updateRunStatus(input: {
  runId: string;
  status: RunStatus;
  error?: string | null;
}): void {
  const db = getDb();
  const current = getRunByIdRaw(input.runId);
  if (!current) return;

  if (TERMINAL_RUN_STATUSES.has(current.status) && current.status !== input.status) {
    return;
  }

  const startAt = current.started_at ?? (input.status === "queued" ? null : now());
  const finishAt =
    input.status === "completed" || input.status === "failed" || input.status === "cancelled"
      ? current.finished_at ?? now()
      : null;

  db.prepare(
    `UPDATE runs
     SET status = ?, error = ?, started_at = COALESCE(started_at, ?), finished_at = ?
     WHERE id = ?`
  ).run(input.status, input.error ?? null, startAt, finishAt, input.runId);

  updateProjectTimestamp(current.project_id);
}

export function createRunStep(input: {
  runId: string;
  seq: number;
  phase: StepPhase;
  status: StepStatus;
  title: string;
  detail: string;
  payload?: Record<string, unknown>;
}): RunStepRow {
  const db = getDb();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO run_steps (id, run_id, seq, phase, status, title, detail, payload_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.runId,
    input.seq,
    input.phase,
    input.status,
    input.title,
    input.detail,
    JSON.stringify(input.payload ?? {}),
    input.status === "running" ? now() : null,
    input.status === "complete" || input.status === "error" ? now() : null
  );

  return getRunStepById(id)!;
}

export function getRunStepById(stepId: string): RunStepRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, run_id, seq, phase, status, title, detail, payload_json, started_at, finished_at
       FROM run_steps
       WHERE id = ?`
    )
    .get(stepId) as RunStepRow | undefined;
  return row ?? null;
}

export function updateRunStep(input: {
  stepId: string;
  status?: StepStatus;
  title?: string;
  detail?: string;
  payload?: Record<string, unknown>;
}): void {
  const db = getDb();
  const current = getRunStepById(input.stepId);
  if (!current) return;

  const nextStatus = input.status ?? current.status;
  const startedAt =
    current.started_at ?? (nextStatus === "running" ? now() : null);
  const finishedAt =
    nextStatus === "complete" || nextStatus === "error"
      ? current.finished_at ?? now()
      : null;

  db.prepare(
    `UPDATE run_steps
     SET status = ?,
         title = ?,
         detail = ?,
         payload_json = ?,
         started_at = ?,
         finished_at = ?
     WHERE id = ?`
  ).run(
    nextStatus,
    input.title ?? current.title,
    input.detail ?? current.detail,
    JSON.stringify(input.payload ?? parseJsonObject(current.payload_json)),
    startedAt,
    finishedAt,
    input.stepId
  );
}

export function listRunSteps(runId: string): RunStepRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, run_id, seq, phase, status, title, detail, payload_json, started_at, finished_at
       FROM run_steps
       WHERE run_id = ?
       ORDER BY seq ASC`
    )
    .all(runId) as RunStepRow[];
}

export function createRunArtifact(input: {
  runId: string;
  kind: RunArtifactKind;
  title: string;
  content: Record<string, unknown>;
}): RunArtifactRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.prepare(
    `INSERT INTO run_artifacts (id, run_id, kind, title, content_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.runId, input.kind, input.title, JSON.stringify(input.content ?? {}), createdAt);

  return getRunArtifactById(id)!;
}

export function getRunArtifactById(artifactId: string): RunArtifactRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, run_id, kind, title, content_json, created_at
       FROM run_artifacts
       WHERE id = ?`
    )
    .get(artifactId) as RunArtifactRow | undefined;

  return row ?? null;
}

export function listRunArtifacts(runId: string): RunArtifactRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, run_id, kind, title, content_json, created_at
       FROM run_artifacts
       WHERE run_id = ?
       ORDER BY created_at ASC`
    )
    .all(runId) as RunArtifactRow[];
}

export function createSnapshot(input: {
  projectId: string;
  runId: string;
  parentSnapshotId?: string | null;
  summary: string;
  files: GeneratedFile[];
}): SnapshotRow {
  const db = getDb();
  const id = randomUUID();
  const createdAt = now();

  db.prepare(
    `INSERT INTO snapshots (
      id, project_id, run_id, parent_snapshot_id, summary, files_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.projectId,
    input.runId,
    input.parentSnapshotId ?? null,
    input.summary,
    JSON.stringify(input.files),
    createdAt
  );

  return getSnapshotById(id)!;
}

export function getSnapshotById(snapshotId: string): SnapshotRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, run_id, parent_snapshot_id, summary, files_json, created_at
       FROM snapshots
       WHERE id = ?`
    )
    .get(snapshotId) as SnapshotRow | undefined;

  return row ?? null;
}

export function listSnapshotsByProject(projectId: string): SnapshotRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, project_id, run_id, parent_snapshot_id, summary, files_json, created_at
       FROM snapshots
       WHERE project_id = ?
       ORDER BY created_at DESC`
    )
    .all(projectId) as SnapshotRow[];
}

export function getCurrentSnapshotForProject(projectId: string): SnapshotRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT s.id, s.project_id, s.run_id, s.parent_snapshot_id, s.summary, s.files_json, s.created_at
       FROM projects p
       LEFT JOIN snapshots s ON s.id = p.current_snapshot_id
       WHERE p.id = ?`
    )
    .get(projectId) as SnapshotRow | undefined;

  return row?.id ? row : null;
}

export function restoreSnapshotForProject(projectId: string, snapshotId: string): void {
  setProjectCurrentSnapshot(projectId, snapshotId);
}

export function getProjectSummary(projectId: string): {
  project: ProjectRow;
  currentSnapshot: SnapshotRow | null;
  latestRun: RunRow | null;
} | null {
  const project = getProjectById(projectId);
  if (!project) return null;

  const currentSnapshot = project.current_snapshot_id
    ? getSnapshotById(project.current_snapshot_id)
    : null;

  const latestRun = getLatestRunForProject(projectId);

  return {
    project,
    currentSnapshot,
    latestRun,
  };
}

export function getLatestRunForProject(projectId: string): RunRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, project_id, thread_id, trigger_message_id, status, model, error, created_at, started_at, finished_at
       FROM runs
       WHERE project_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(projectId) as RunRow | undefined;

  if (!row) return null;
  return reconcileRunIfStale(row);
}
