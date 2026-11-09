# Architecture notes

More detail on three parts of the engine summarised in the README.

## Follow-up runs

The first message in a project always runs the full pipeline from a neutral scaffold. Every message after that starts from the previous snapshot's working tree, and before planning begins the engine classifies the request with a small model call: `{ mode, scope, reasoning, targetPaths }`. `mode` (`feature_mode` / `followup_fix_mode`) sets task-count caps, and `scope` sets how much may change: `full_rebuild` treats the whole app as in play, `targeted_edit` means only an identifiable set of existing files should change. A failed or malformed classification call never fails the run: it falls back to a regex heuristic and defaults to `full_rebuild` so the worst case is a broad rebuild.

When scope comes back `targeted_edit`, the skeleton DAG is built as usual but seeded with an explicit rule that unaffected existing files must not appear as nodes. Any DAG node whose path already exists in the working tree then skips skeleton generation and the region-fill pipeline entirely. Those are for scaffolding new files from scratch, not editing ones that already work. Instead, the existing file's current full content is sent to a dedicated edit call that returns the complete updated file, which flows through the same operations/validation/fix-DAG machinery as everything else. So an "add a dark mode toggle" follow-up regenerates only the file(s) it actually touches, and every other file in the project comes out of the run byte-identical to how it went in (checked by scenario 3 of `npm run test:loop`).

## Stack profiles

Every spec call also decides a `stackProfile`, defaulting to `vite-spa` unless the brief clearly needs a real backend:

- **`vite-spa`**: a browser-only Vite + React SPA. Persistence, if any, runs client-side via `@electric-sql/pglite` in the browser (`idb://` storage).
- **`express-fullstack`**: chosen when the brief needs server-authoritative APIs, auth with server-held sessions, persistence shared across multiple clients/devices, webhooks, or background jobs. Adds a Node/Express API beside the same Vite frontend: `server/app.js` (model-owned, exports the Express app), `server/routes/*.js` and `server/db.js` (model-owned), and one engine-owned file, `server/index.js`: a tiny bootstrap that creates `./data` for PGlite, imports `server/app.js`, and only calls `.listen()` outside a smoke test. PGlite runs server-side (`server/db.js`, a plain filesystem path, never `idb://`) instead of in the browser; the frontend talks to it over `fetch("/api/...")`, proxied to the API port by Vite in dev (`vite.config.js`'s `server.proxy`) and served statically by Express in production.

`express-fullstack` package.json gets `express` + `@electric-sql/pglite` dependencies and five scripts: `dev` (Vite), `dev:server` (`node --watch server/index.js`), `build` (`vite build`, frontend only), `start` (`node server/index.js`), and `check:server`: the terminal build gate's deterministic backend smoke test. It runs after `npm run build` passes, as `SMOKE_TEST=1 node server/index.js`: since `server/index.js` only calls `.listen()` when `SMOKE_TEST` is unset, this exercises every route/db module the model wrote (import-time errors, missing exports, bad wiring) without ever binding a port. A handful of validators (React Hook rules, PGlite browser/`idb://` heuristics, the "is this import browser-compatible" check) are scoped away from anything under `server/`, and a small server-side check set requires `server/app.js` to export the app and forbids React imports or `window`/`document` references anywhere under `server/`.

Follow-up runs never re-decide the profile. It's inferred from the existing snapshot (an `express` dependency or `check:server` script in `package.json`, or a `server/` directory) so a project can't flip shape mid-thread.

## Design languages

Each spec call also picks a `designLanguage` instead of leaving the aesthetic direction fully freeform every run:

- **`minimal-light`**: Apple-like restraint: quiet neutral palette, one accent, generous whitespace.
- **`editorial-bold`**: magazine energy: big serif/display headlines, high contrast, strict grid, minimal chrome.
- **`dense-dashboard`**: data-first: compact grids, muted palette, small efficient type, built for scanning numbers.
- **`playful-rounded`**: vivid and springy: large radii, saturated accent colors, bouncy motion.
- **`dark-glass`**: dark surfaces with frosted layered panels and one restrained glow accent.

The model is prompted to vary its choice by brief rather than defaulting to the same language every time. A hash of the brief also seeds typography, colour and layout choices within the chosen language.
