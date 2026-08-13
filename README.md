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

## Stack

Next.js (TypeScript), SQLite via better-sqlite3 for run state, Docker harness for isolated builds and checks (`scripts/dev/`).

## Running

```bash
npm ci
npm run dev        # engine dashboard
npm run build      # production build (CI runs this on every push)
```

Runtime state lives in `data/` (gitignored). Provider keys load from environment variables.

## Benchmark status

A benchmark harness is included. Following the evidence policy used across this account: no benchmark numbers are published here until a run is reproducible end to end. The build and typecheck gates run in CI on every push.
