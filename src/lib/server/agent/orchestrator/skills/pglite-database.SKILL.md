---
name: pglite-database
description: PGlite/PostgreSQL database patterns and anti-patterns for correct SQL dialect usage
---

# PGlite Database Skill

PGlite is an **embedded PostgreSQL engine** compiled to WebAssembly. It runs PostgreSQL (not SQLite) inside the browser. All SQL must follow PostgreSQL syntax.

## Correct Schema Patterns

```sql
-- ✅ PostgreSQL (PGlite) syntax
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);
```

## Data Type Mappings

| Use Case | ✅ PostgreSQL (PGlite) | ❌ SQLite (NEVER use) |
|---|---|---|
| Auto-incrementing ID | `SERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` |
| Boolean | `BOOLEAN` / `TRUE` / `FALSE` | `INTEGER` / `1` / `0` |
| Timestamp | `TIMESTAMPTZ` / `NOW()` / `CURRENT_TIMESTAMP` | `datetime('now')` |
| JSON | `JSONB` | `TEXT` (with JSON functions) |
| Decimal | `NUMERIC(p,s)` or `DECIMAL(p,s)` | `REAL` |
| Variable text | `TEXT` or `VARCHAR(n)` | `TEXT` |

## Parameterized Queries

Always use `$1, $2, ...` placeholders with `db.query()`:

```javascript
// ✅ Correct: parameterized query
const result = await db.query(
  'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id',
  [name, email]
);

// ✅ Correct: SELECT with params
const users = await db.query(
  'SELECT * FROM users WHERE is_active = $1 AND balance > $2',
  [true, 100.00]
);

// ❌ NEVER: string interpolation
await db.exec(`INSERT INTO users (name) VALUES ('${name}')`);
```

## Schema Introspection (Migration Guards)

```javascript
// ✅ PostgreSQL: check existing columns
const cols = await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
  [tableName]
);

// ❌ NEVER: SQLite PRAGMA
await db.query(`PRAGMA table_info("${tableName}")`);
```

## Boolean Operations

```sql
-- ✅ PostgreSQL boolean toggle
UPDATE items SET completed = NOT completed WHERE id = $1;

-- ❌ SQLite integer toggle
UPDATE items SET completed = CASE WHEN completed = 1 THEN 0 ELSE 1 END WHERE id = $1;
```

## Forbidden SQLite Syntax

Never use these in PGlite code:
- `AUTOINCREMENT` → use `SERIAL` or `BIGSERIAL`
- `PRAGMA` → use `information_schema` views
- `datetime('now')` → use `NOW()` or `CURRENT_TIMESTAMP`
- `GLOB` → use `LIKE` or `~` regex
- `typeof()` → use `pg_typeof()`
- `IFNULL()` → use `COALESCE()`
- `GROUP_CONCAT()` → use `STRING_AGG()`
- `RANDOM()` → use `RANDOM()` (same, but seeding differs)

## PGlite Initialization Pattern

```javascript
import { PGlite } from "@electric-sql/pglite";

const BASE_DATA_DIR = "idb://my-app-db";
let dbPromise = null;

async function openDatabase(dataDir) {
  const db = new PGlite(dataDir);
  await db.waitReady;  // ← promise property, NOT a function call
  return db;
}

async function getDb() {
  if (!dbPromise) {
    dbPromise = openDatabase(BASE_DATA_DIR);
  }
  return dbPromise;
}

export const db = getDb();
```
