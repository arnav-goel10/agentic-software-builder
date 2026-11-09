# Agentic Software Builder

Type a one-line brief. The engine plans the app, writes it file by file, repairs what breaks, and only finishes once the project installs and builds. It builds Vite + React front ends and, when the brief needs a real backend, an Express API on PGlite (PostgreSQL compiled to WebAssembly).

```
brief -> spec -> plan -> skeleton DAG -> parallel fill -> validate + repair -> npm install + build -> QA -> snapshot
```

A run only finishes when its gates pass: deterministic validators, the engine's own `npm install` and `npm run build`, a backend smoke test for Express apps, and an LLM QA review. Anything that fails goes to a repair loop that sees the real failing sources.

**Benchmark.** 30 briefs ([`scripts/bench/tasks.json`](scripts/bench/tasks.json)), each judged by a separate harness that installs, builds and serves the saved app and calls its API. The live 30-task run is pending, estimated at $0.62 to $4.19 on the configured model or free on Gemini's free tier. CI replays 2 recorded briefs through the real engine and real npm on every push to keep the harness working. Building the harness turned up two engine bugs that would have broken real runs. Both are fixed, see [docs/benchmark.md](docs/benchmark.md).

```bash
npm ci
npm run bench:stub        # 2 briefs through the real engine and real npm, no keys, about 20 s
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

### Follow-ups, stacks and design

- **Follow-up messages** start from the previous snapshot. A small model call decides whether the request is a full rebuild or a targeted edit. Targeted edits regenerate only the files they touch, and the mock loop's follow-up scenario checks that every other file comes out byte-identical.
- **Stack profiles.** `vite-spa` is a browser-only Vite + React app (PGlite in IndexedDB if it needs storage). `express-fullstack` adds an Express API with server-side PGlite, an engine-owned `server/index.js` bootstrap, and a `check:server` smoke test in the build gate.
- **Design languages.** Each spec picks one of five visual directions (`minimal-light`, `editorial-bold`, `dense-dashboard`, `playful-rounded`, `dark-glass`) so apps do not all look alike.

Details: [docs/architecture.md](docs/architecture.md).

## Stack

The engine (internal name Dexter, hence the `DEXTER_*` settings) is a Next.js (TypeScript) app with SQLite (better-sqlite3) for run state. Model providers: OpenRouter or any OpenAI-compatible server, Google Gemini, and a mock provider that replays recorded fixtures. Docker scripts for isolated builds are in `scripts/dev/`.

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

Started in February 2026 as Hateable, with [Prakprogrammer](https://github.com/Prakprogrammer), who wrote the project plan, the Next.js scaffold and the first workspace and sandbox UI. [Arnav Goel](https://github.com/arnav-goel10) built the agent engine (`src/lib/server/`: orchestrator, validators, model providers, run API) and the later work on follow-up edits, stack profiles, repair loops and the benchmark. The original repository is private.

## Licence

All rights reserved by the authors.
