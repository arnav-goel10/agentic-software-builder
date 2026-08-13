import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_DB_PATH = path.join(process.cwd(), "data", "dexter.sqlite");

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  current_snapshot_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thread_summaries (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  start_message_id TEXT NOT NULL,
  end_message_id TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (start_message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (end_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  source_run_id TEXT,
  weight REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (source_run_id) REFERENCES runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS memory_retrieval_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  selected_card_ids_json TEXT NOT NULL,
  dropped_card_ids_json TEXT NOT NULL,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_snapshot_id TEXT,
  summary TEXT NOT NULL,
  files_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_snapshot_id) REFERENCES snapshots(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_project_updated ON threads(project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_thread_summaries_thread_created ON thread_summaries(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_project_created ON runs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_seq ON run_steps(run_id, seq ASC);
CREATE INDEX IF NOT EXISTS idx_snapshots_project_created ON snapshots(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_kind ON run_artifacts(run_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_cards_project_type_weight ON memory_cards(project_id, type, weight DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_retrieval_logs_run_phase_created ON memory_retrieval_logs(run_id, phase, created_at DESC);
`;

type GlobalWithDexterDb = typeof globalThis & {
  __dexterDb?: Database.Database;
};

function ensureDirForDb(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDbPath(): string {
  return process.env.DEXTER_DB_PATH?.trim() || DEFAULT_DB_PATH;
}

function createDb(): Database.Database {
  const dbPath = getDbPath();
  ensureDirForDb(dbPath);
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  migrateRunsTableDropMode(db);
  migrateMemoryCardFts(db);
}

function hasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  const columns = db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return columns.some((column) => column.name === columnName);
}

function migrateRunsTableDropMode(db: Database.Database): void {
  if (!hasColumn(db, "runs", "mode")) {
    return;
  }

  try {
    db.exec(`ALTER TABLE runs DROP COLUMN mode;`);
  } catch {
    db.exec(`PRAGMA foreign_keys = OFF;`);
    try {
      db.exec(`BEGIN TRANSACTION;`);
      try {
        db.exec(`
          CREATE TABLE runs__new (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            trigger_message_id TEXT NOT NULL,
            status TEXT NOT NULL,
            model TEXT NOT NULL,
            error TEXT,
            created_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
            FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
            FOREIGN KEY (trigger_message_id) REFERENCES messages(id) ON DELETE CASCADE
          );

          INSERT INTO runs__new (
            id,
            project_id,
            thread_id,
            trigger_message_id,
            status,
            model,
            error,
            created_at,
            started_at,
            finished_at
          )
          SELECT
            id,
            project_id,
            thread_id,
            trigger_message_id,
            status,
            model,
            error,
            created_at,
            started_at,
            finished_at
          FROM runs;

          DROP TABLE runs;
          ALTER TABLE runs__new RENAME TO runs;
          CREATE INDEX IF NOT EXISTS idx_runs_project_created ON runs(project_id, created_at DESC);
        `);
        db.exec(`COMMIT;`);
      } catch (migrationError) {
        db.exec(`ROLLBACK;`);
        throw migrationError;
      }
    } finally {
      db.exec(`PRAGMA foreign_keys = ON;`);
    }
  }
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type IN ('table', 'view') AND name = ?`
    )
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function migrateMemoryCardFts(db: Database.Database): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_cards_fts
      USING fts5(card_id UNINDEXED, project_id UNINDEXED, type UNINDEXED, text, tokenize='unicode61');

      CREATE TRIGGER IF NOT EXISTS memory_cards_ai AFTER INSERT ON memory_cards BEGIN
        INSERT INTO memory_cards_fts(card_id, project_id, type, text)
        VALUES (new.id, new.project_id, new.type, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS memory_cards_ad AFTER DELETE ON memory_cards BEGIN
        DELETE FROM memory_cards_fts WHERE card_id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS memory_cards_au AFTER UPDATE ON memory_cards BEGIN
        DELETE FROM memory_cards_fts WHERE card_id = old.id;
        INSERT INTO memory_cards_fts(card_id, project_id, type, text)
        VALUES (new.id, new.project_id, new.type, new.text);
      END;
    `);
  } catch {
    // FTS is optional in local SQLite builds. Retrieval falls back to non-FTS queries.
    return;
  }

  if (!tableExists(db, "memory_cards")) {
    return;
  }

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM memory_cards) AS cards,
         (SELECT COUNT(*) FROM memory_cards_fts) AS indexed`
    )
    .get() as { cards?: number; indexed?: number } | undefined;

  const cardCount = Number(counts?.cards ?? 0);
  const indexedCount = Number(counts?.indexed ?? 0);
  if (cardCount === 0 || indexedCount >= cardCount) {
    return;
  }

  db.exec(`
    INSERT INTO memory_cards_fts(card_id, project_id, type, text)
    SELECT m.id, m.project_id, m.type, m.text
    FROM memory_cards m
    LEFT JOIN memory_cards_fts f ON f.card_id = m.id
    WHERE f.card_id IS NULL;
  `);
}

export function getDb(): Database.Database {
  const globalRef = globalThis as GlobalWithDexterDb;
  if (!globalRef.__dexterDb) {
    globalRef.__dexterDb = createDb();
  }
  return globalRef.__dexterDb;
}
