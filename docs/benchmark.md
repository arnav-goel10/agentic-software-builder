# Benchmark

The benchmark asks one question: given a brief, does the engine produce an app that really works? A task passes only if all four hold:

1. the engine finishes the run with status `completed` (every internal gate on: skeleton validation, final validation, its own `npm install` and `npm run build`, QA);
2. the harness, starting again from the files the engine saved, gets `npm install` to exit 0;
3. `npm run build` exits 0;
4. a smoke test passes. For a Vite + React app, `vite preview` serves `index.html` and every script and stylesheet it links with HTTP 200. For an Express + PGlite app, `npm run check:server` passes too, then the server starts on a free port, no `/api` path found in its code returns 5xx, and at least one returns 2xx.

The harness does not trust the engine's own report. Steps 2 to 4 repeat its build from the saved snapshot and add a runtime check the engine does not do.

## Running it

```bash
npm ci

# Stub model, no keys, no cost, about 15 s. Replays the recorded fixtures
# in scripts/test/fixtures through the real engine and real npm.
npm run bench:stub

# Free tier: Gemini (GEMINI_API_KEY in .env)
npm run bench -- --provider google --limit 3

# Local model on any OpenAI-compatible server (Ollama, llama.cpp, LM Studio)
npm run bench -- --provider local --base-url http://127.0.0.1:11434/v1 --model qwen2.5-coder:14b

# The configured paid model (OpenRouter, models from .env)
npm run bench -- --provider openrouter --price-in 0.30 --price-out 1.20

# Check configuration only, run nothing
npm run bench -- --provider openrouter --preflight-only

# Tests for the pass/fail judge itself: two good apps and three broken ones
npm run test:bench-judge
```

Tasks live in `scripts/bench/tasks.json` (30 briefs, 10 each of marketing sites, CRUD dashboards and data-heavy apps) and `scripts/bench/tasks-stub.json` (the two briefs that have recorded fixtures). `--only site-01,crud-03` and `--limit N` pick a subset.

Each task runs the engine in its own process under a hard time limit (30 min live, 5 min stub). Results go to `bench-results/<provider>-<timestamp>/`:

| File | What it holds |
| --- | --- |
| `summary.md`, `summary.json` | pass count, outcome per task, model-call and token totals, cost if prices are given |
| `<task>/engine.log` | the engine process's output |
| `<task>/engine.json` | run status, error, every step, and one record per model call (phase, model, prompt and response size, provider-reported tokens) |
| `<task>/verify.log` | the independent npm install, build and smoke test output |
| `<task>/result.json` | the outcome: `pass`, `engine_failed`, `timeout`, `harness_error`, `install_failed`, `build_failed` or `smoke_failed` |
| `<task>/app/` | the generated app (not committed) |

Before any task runs, a preflight checks that the provider is configured and reachable and that every configured model still exists. If not, the script exits with code 2 and writes nothing.

## Results so far

| Run | Model | Pass | Source |
| --- | --- | --- | --- |
| Stub, 2 tasks, 9 Nov 2026 | recorded fixtures | 2 / 2 | `bench-results/stub-2026-11-09/summary.md` |
| Full 30 tasks | minimax-m2.5 or Gemini | not run yet | |

The stub run checks the harness, the engine's control flow and the npm and smoke steps. It does not measure model quality, because the model's answers are recorded. The 30-task number needs a live model.

## Why the February report said 0 of 30

The report that used to sit in `artifacts/benchmarks/` (removed in this change, still in git history) recorded 30 failures, all with the error `fetch failed`. The run never reached the engine or a model:

- All 30 entries have `projectId: null` and `durationMs: 0`, and the whole run took 42 ms (`createdAt` 1770882297003 to `finishedAt` 1770882297045). `fetch failed` is what Node's `fetch` throws when nothing is listening. The first request of each task, `POST /api/projects` to `http://localhost:3000`, was refused because the Next.js server was not running.
- The old harness (`scripts/bench/run-v35-benchmark.mjs`) drove the engine over HTTP, so it needed a separately started server. It had no preflight. It caught the connection error per task and recorded it as a run with status `failed`, so a dead endpoint looked like 30 engine failures.
- Its success test was the run's status string alone. It never installed, built or ran the generated app.

So the 0 of 30 said nothing about the engine, the model or timeouts. It was a harness bug. The new harness fixes it at the root: the engine runs in-process (no server to forget), a failed preflight records nothing, harness errors get their own outcome, and success means the app works.

Two more problems came up while rebuilding it. Both would have failed real runs today:

- **A retired model in the default config.** `.env.example` set the coder phase to `minimax/minimax-m2.1:nitro`, which OpenRouter no longer lists. Every coder call would have failed. The preflight now catches this (`OpenRouter no longer lists: minimax/minimax-m2.1:nitro`), and the default is `minimax/minimax-m2.5:nitro`.
- **Express apps crashed on their first database query.** The engine tells the model to store server-side PGlite data in `./data/<name>`. PGlite creates only the last directory, so on a fresh checkout the first query failed with `ENOENT: mkdir .../data/standup-db` and the API returned 500. The engine's `check:server` gate only imports the server modules, so it missed this. The new smoke test calls the API and caught it (`GET /api/updates -> 500`). The fix is in the engine-owned `server/index.js` bootstrap, which now creates `./data` before loading the app. After the fix the same run passes (`/api/health 200, /api/updates 200`).

## Cost of a full 30-task run

Measured from the stub run with `node scripts/bench/estimate-cost.mjs bench-results/stub-2026-11-09/summary.json`, saved in `bench-results/cost-estimate-minimax-m2.5.json`.

- The prompts in a stub run are real. The engine builds them from the brief, plan and sibling files. They average 197,615 characters per task over 12 calls, about 56,000 input tokens at 3.5 characters per token. The responses are small recorded fixtures.
- Price: `minimax/minimax-m2.5`, the configured model for every phase. The most expensive OpenRouter endpoint on 9 Nov 2026 was $0.30 per million input tokens and $1.20 per million output tokens.
- Low end: the stub's volume as is, $0.021 per task, **$0.62 for 30 tasks**.
- High end: 4x the prompt volume (larger apps, repair passes) and 60,000 output tokens per task (code plus reasoning), $0.14 per task, **$4.19 for 30 tasks**.

This is an estimate, not a measurement. The first live run will replace it, since `engine.json` records provider-reported tokens for every call and `--price-in` and `--price-out` turn them into dollars. On Gemini's free tier the run costs nothing, but its daily request caps mean 30 tasks may take more than one day.
