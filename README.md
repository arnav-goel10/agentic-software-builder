# Agentic Software Builder

Type a one-line brief. The engine plans the app, writes it file by file, repairs what breaks, and only finishes once the project installs and builds. It builds Vite + React front ends and, when the brief needs a real backend, an Express API on PGlite (PostgreSQL compiled to WebAssembly).

```
brief -> spec -> plan -> skeleton DAG -> parallel fill -> validate + repair -> npm install + build -> QA -> snapshot
```

A run only finishes when its gates pass: deterministic validators, the engine's own `npm install` and `npm run build`, a backend smoke test for Express apps, and an LLM QA review. Anything that fails goes to a repair loop that sees the real failing sources.

**Benchmark.** `npm run bench` runs a set of briefs and counts a task as passed only when a separate harness, starting from the saved files, gets the app to install, build and answer HTTP (for Express apps, its API routes too). With the stub model, 2 of 2 tasks pass ([`bench-results/stub-2026-11-09`](bench-results/stub-2026-11-09/summary.md)). That checks the pipeline, not model quality. The 30-task live run is not done yet. It is estimated at $0.62 to $4.19 on the configured model, or free on Gemini's free tier. Method, cost working and the story of an old 0/30 report are in [docs/benchmark.md](docs/benchmark.md).

```bash
npm ci
npm run bench:stub        # 2 briefs through the real engine and real npm, no keys, about 15 s
npm run test:loop         # 4 mock-provider scenarios, 62 assertions
npm run dev               # the dashboard at localhost:3000
```

## How it works

- **Spec and plan.** The brief becomes a spec with acceptance criteria, then a task graph. The spec also picks a stack profile and a design language (below).
- **Skeleton, then fill.** The planner writes a skeleton DAG of files and the contracts between them. Skeleton files get typed fill regions, and coder calls fill them in parallel, each seeing its siblings' real source.
- **Ownership.** Tasks own disjoint write sets, so parallel work cannot collide. Engine-owned files (entry points, build config, the server bootstrap) are generated deterministically and never left to the model.
- **Validation and repair.** Deterministic validators and autofixes run first. Remaining issues become a fix DAG of repair tasks that own both sides of a broken import or export.
- **Build gate and QA.** The engine runs `npm install` and `npm run build` on the working tree (plus `npm run check:server` for Express apps), then an LLM QA pass with its own repair loop.
- **Persistence.** Runs, steps, artifacts and snapshots live in SQLite, so every run can be inspected and any snapshot restored.

### Follow-up runs

The first message in a project always runs the full pipeline above from a neutral scaffold. Every message after that starts from the previous snapshot's working tree, and before planning begins the engine classifies the request with a small model call: `{ mode, scope, reasoning, targetPaths }`. `mode` (`feature_mode` / `followup_fix_mode`) sets task-count caps, and `scope` sets how much may change: `full_rebuild` treats the whole app as in play, `targeted_edit` means only an identifiable set of existing files should change. A failed or malformed classification call never fails the run: it falls back to a regex heuristic and defaults to `full_rebuild`, so worst case a follow-up just gets the old broad-rebuild behavior.

When scope comes back `targeted_edit`, the skeleton DAG is built as usual but seeded with an explicit rule that unaffected existing files must not appear as nodes. Any DAG node whose path already exists in the working tree then skips skeleton generation and the region-fill pipeline entirely. Those are for scaffolding new files from scratch, not editing ones that already work. Instead, the existing file's current full content is sent to a dedicated edit call that returns the complete updated file, which flows through the same operations/validation/fix-DAG machinery as everything else. The net effect: a "add a dark mode toggle" style follow-up regenerates only the file(s) it actually touches, and every other file in the project comes out of the run byte-identical to how it went in.

### Stack profiles

Every spec call also decides a `stackProfile`, defaulting to `vite-spa` unless the brief clearly needs a real backend:

- **`vite-spa`**: a browser-only Vite + React SPA. Persistence, if any, runs client-side via `@electric-sql/pglite` in the browser (`idb://` storage).
- **`express-fullstack`**: chosen when the brief needs server-authoritative APIs, auth with server-held sessions, persistence shared across multiple clients/devices, webhooks, or background jobs. Adds a Node/Express API beside the same Vite frontend: `server/app.js` (model-owned, exports the Express app), `server/routes/*.js` and `server/db.js` (model-owned), and one engine-owned file, `server/index.js`: a tiny bootstrap that creates `./data` for PGlite, imports `server/app.js`, and only calls `.listen()` outside a smoke test. PGlite runs server-side (`server/db.js`, a plain filesystem path, never `idb://`) instead of in the browser; the frontend talks to it over `fetch("/api/...")`, proxied to the API port by Vite in dev (`vite.config.js`'s `server.proxy`) and served statically by Express in production.

`express-fullstack` package.json gets `express` + `@electric-sql/pglite` dependencies and five scripts: `dev` (Vite), `dev:server` (`node --watch server/index.js`), `build` (`vite build`, frontend only), `start` (`node server/index.js`), and `check:server`: the terminal build gate's deterministic backend smoke test. It runs after `npm run build` passes, as `SMOKE_TEST=1 node server/index.js`: since `server/index.js` only calls `.listen()` when `SMOKE_TEST` is unset, this exercises every route/db module the model wrote (import-time errors, missing exports, bad wiring) without ever binding a port. A handful of validators (React Hook rules, PGlite browser/`idb://` heuristics, the "is this import browser-compatible" check) are scoped away from anything under `server/`, and a small server-side check set requires `server/app.js` to export the app and forbids React imports or `window`/`document` references anywhere under `server/`.

Follow-up runs never re-decide the profile. It's inferred from the existing snapshot (an `express` dependency or `check:server` script in `package.json`, or a `server/` directory) so a project can't flip shape mid-thread.

### Design languages

Each spec call also picks a `designLanguage` instead of leaving the aesthetic direction fully freeform every run:

- **`minimal-light`**: Apple-like restraint: quiet neutral palette, one accent, generous whitespace.
- **`editorial-bold`**: magazine energy: big serif/display headlines, high contrast, strict grid, minimal chrome.
- **`dense-dashboard`**: data-first: compact grids, muted palette, small efficient type, built for scanning numbers.
- **`playful-rounded`**: vivid and springy: large radii, saturated accent colors, bouncy motion.
- **`dark-glass`**: dark surfaces with frosted layered panels and one restrained glow accent.

The model is prompted to vary its choice by brief rather than defaulting to the same language every time. The pre-existing typography/color/layout diversity-seed hashing still applies on top, as variation within whichever language gets picked.

## Stack

The engine is a Next.js (TypeScript) app with SQLite (better-sqlite3) for run state. Model providers: OpenRouter or any OpenAI-compatible server, Google Gemini, and a mock provider that replays recorded fixtures. Docker scripts for isolated builds are in `scripts/dev/`.

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

## Credits

Started in February 2026 as Hateable, with [Prakprogrammer](https://github.com/Prakprogrammer), who wrote the project plan, the Next.js scaffold and the first workspace and sandbox UI. [Arnav Goel](https://github.com/arnav-goel10) built the agent engine (`src/lib/server/`: orchestrator, validators, model providers, run API) and everything in this repository's history. The original repository is private.

## Licence

No licence has been chosen yet, so the default applies: all rights reserved by the authors.
