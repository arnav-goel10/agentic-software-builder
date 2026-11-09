# Benchmark 2026-11-09T14:41:43.821Z

- Provider: mock (stub model replays recorded fixtures)
- Tasks: scripts/bench/tasks-stub.json, 2 run
- Pass (completed + npm install + npm run build + smoke test): **2 / 2**
- Outcomes: pass 2
- Model calls: 24 (0 failed), prompt 395229 chars, response 21923 chars
- Provider-reported tokens: 0 in, 0 out (0 calls reported usage)
- Cost: not computed (pass --price-in and --price-out, USD per million tokens)
- Wall time: 17s

| Task | Category | Outcome | Engine | Engine time | Files | Calls | Reason |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| stub-todo | stub | pass | completed | 6s | 9 | 9 | installed, built and served |
| stub-standup-fullstack | stub | pass | completed | 3s | 13 | 15 | installed, built and served |
