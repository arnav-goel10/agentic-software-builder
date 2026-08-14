# Agentic Software Builder (Hateable / Dexter)

An agentic software-building system: give it a natural-language brief, and it takes a project through explicit specification, planning, task execution, deterministic validation, QA, and finalisation phases.

> **Team project.** Original repository: [Prakprogrammer/Hateable](https://github.com/Prakprogrammer/Hateable). This is a cleaned mirror maintained by [Arnav Goel](https://github.com/arnav-goel10): runtime databases and generated artifacts removed from tracking, scripts organised, CI added. Code rights remain with the authors.

## How it works

The engine drives a full-stack Next.js build through phases, each with hard gates:

- **Specification and planning**: the brief becomes an explicit spec, then a task graph.
- **Task execution**: structured file operations under task ownership contracts; dependency-tier scheduling; disjoint write-set parallelism so tasks cannot collide.
- **Context**: a repo map keeps agents oriented; engine-owned configuration regeneration prevents drift.
- **Validation and QA**: deterministic checks, final build and runtime gates, repair-candidate selection when a gate fails.
- **Persistence**: telemetry, snapshot persistence, and filesystem round-trip synchronisation.

### Follow-up runs

The first message in a project always runs the full pipeline above from a neutral scaffold. Every message after that starts from the previous snapshot's working tree, and before planning begins the engine classifies the request with a small model call: `{ mode, scope, reasoning, targetPaths }`. `mode` (`feature_mode` / `followup_fix_mode`) still governs task-count caps the way it always has; `scope` is new — `full_rebuild` treats the whole app as in play, `targeted_edit` means only an identifiable set of existing files should change. A failed or malformed classification call never fails the run: it falls back to a regex heuristic and defaults to `full_rebuild`, so worst case a follow-up just gets the old broad-rebuild behavior.

When scope comes back `targeted_edit`, the skeleton DAG is built as usual but seeded with an explicit rule that unaffected existing files must not appear as nodes. Any DAG node whose path already exists in the working tree then skips skeleton generation and the region-fill pipeline entirely — those are for scaffolding new files from scratch, not editing ones that already work. Instead, the existing file's current full content is sent to a dedicated edit call that returns the complete updated file, which flows through the same operations/validation/fix-DAG machinery as everything else. The net effect: a "add a dark mode toggle" style follow-up regenerates only the file(s) it actually touches, and every other file in the project comes out of the run byte-identical to how it went in.

### Stack profiles

Every spec call also decides a `stackProfile`, defaulting to `vite-spa` unless the brief clearly needs a real backend:

- **`vite-spa`** — a browser-only Vite + React SPA. Persistence, if any, runs client-side via `@electric-sql/pglite` in the browser (`idb://` storage).
- **`express-fullstack`** — chosen when the brief needs server-authoritative APIs, auth with server-held sessions, persistence shared across multiple clients/devices, webhooks, or background jobs. Adds a Node/Express API beside the same Vite frontend: `server/app.js` (model-owned, exports the Express app), `server/routes/*.js` and `server/db.js` (model-owned), and one engine-owned file, `server/index.js` — a tiny bootstrap that imports `server/app.js` and only calls `.listen()` outside a smoke test. PGlite runs server-side (`server/db.js`, a plain filesystem path, never `idb://`) instead of in the browser; the frontend talks to it over `fetch("/api/...")`, proxied to the API port by Vite in dev (`vite.config.js`'s `server.proxy`) and served statically by Express in production.

`express-fullstack` package.json gets `express` + `@electric-sql/pglite` dependencies and five scripts: `dev` (Vite), `dev:server` (`node --watch server/index.js`), `build` (`vite build`, frontend only), `start` (`node server/index.js`), and `check:server` — the terminal build gate's deterministic backend smoke test. It runs after `npm run build` passes, as `SMOKE_TEST=1 node server/index.js`: since `server/index.js` only calls `.listen()` when `SMOKE_TEST` is unset, this exercises every route/db module the model wrote (import-time errors, missing exports, bad wiring) without ever binding a port. A handful of validators (React Hook rules, PGlite browser/`idb://` heuristics, the "is this import browser-compatible" check) are scoped away from anything under `server/`, and a small server-side check set requires `server/app.js` to export the app and forbids React imports or `window`/`document` references anywhere under `server/`.

Follow-up runs never re-decide the profile — it's inferred from the existing snapshot (an `express` dependency or `check:server` script in `package.json`, or a `server/` directory) so a project can't flip shape mid-thread.

### Design languages

Each spec call also picks a `designLanguage` instead of leaving the aesthetic direction fully freeform every run:

- **`minimal-light`** — Apple-like restraint: quiet neutral palette, one accent, generous whitespace.
- **`editorial-bold`** — magazine energy: big serif/display headlines, high contrast, strict grid, minimal chrome.
- **`dense-dashboard`** — data-first: compact grids, muted palette, small efficient type, built for scanning numbers.
- **`playful-rounded`** — vivid and springy: large radii, saturated accent colors, bouncy motion.
- **`dark-glass`** — dark surfaces with frosted layered panels and one restrained glow accent.

The model is prompted to vary its choice by brief rather than defaulting to the same language every time. The pre-existing typography/color/layout diversity-seed hashing still applies on top, as variation within whichever language gets picked.

## Stack

Next.js (TypeScript), SQLite via better-sqlite3 for run state, Docker harness for isolated builds and checks (`scripts/dev/`).

## Running

```bash
npm ci
npm run dev        # engine dashboard
npm run build      # production build (CI runs this on every push)
```

Runtime state lives in `data/` (gitignored). Provider keys load from environment variables.

## Hosting the demo

Demo mode runs the full pipeline UX against the deterministic mock provider: no API keys, no cost, instant phases. Set:

```bash
DEXTER_MODEL_PROVIDER=mock
DEXTER_MOCK_FIXTURES=./scripts/test/fixtures/todo-app
DEXTER_ENABLE_SKELETON_VALIDATION=false
DEXTER_ENABLE_FINAL_VALIDATION=false
DEXTER_ENABLE_QA=false
```

The validation gates stay off in demo mode because fixtures are pre-validated; a live provider (`DEXTER_MODEL_PROVIDER=google` with `GEMINI_API_KEY`) runs with every gate on. The UI shows a "Demo mode" pill automatically when the mock provider is active.

## Benchmark status

A benchmark harness is included. Following the evidence policy used across this account: no benchmark numbers are published here until a run is reproducible end to end. The build and typecheck gates run in CI on every push.
