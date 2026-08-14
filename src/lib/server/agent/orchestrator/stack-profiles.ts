// orchestrator/stack-profiles.ts — Stack profile selection.
//
// Dexter builds against one of two profiles, chosen by the model during the
// SPEC phase and carried on SpecResponse for the rest of the pipeline:
//
// - "vite-spa" (default): a browser-only Vite + React SPA. Persistence, if
//   any, runs client-side via @electric-sql/pglite in the browser.
// - "express-fullstack": adds a Node/Express API (server/app.js, model-owned)
//   alongside the same Vite frontend, with PGlite running server-side
//   (server/db.js) instead of in the browser. The frontend calls /api/* via
//   fetch; in dev, Vite proxies /api to the Express server; in production,
//   Express serves the Vite build's dist/ output statically.
//
// This module owns the profile type, the spec-phase guidance text, the one
// engine-owned server file the profile adds (server/index.js), and best-
// effort inference of a project's existing profile from its files (needed
// for follow-up runs, where the profile was already committed to before the
// current run's spec call happens).
import type { GeneratedFile } from "@/lib/server/types";
import { normalizePath } from "@/lib/server/agent/validation";

export type StackProfile = "vite-spa" | "express-fullstack";

export const DEFAULT_STACK_PROFILE: StackProfile = "vite-spa";

export const STACK_PROFILE_IDS: StackProfile[] = ["vite-spa", "express-fullstack"];

/** Injected into the spec-generation prompt so the model can decide. */
export const STACK_PROFILE_SPEC_GUIDANCE = `Stack profile selection:
Choose exactly one "stackProfile" for this project, plus a one/two-sentence "stackProfileReasoning".
- "vite-spa" (default — prefer this unless the brief clearly needs more): a browser-only single-page app. Any persistence needed runs client-side via @electric-sql/pglite in the browser.
- "express-fullstack": choose ONLY when the brief genuinely needs a real backend the browser cannot provide alone — server-authoritative APIs, auth flows with server-held sessions/secrets, persistence that must be shared/consistent across multiple clients or devices, webhooks/callbacks from third parties, or scheduled/background jobs. This adds a Node/Express API (server/app.js) beside the Vite frontend, with PGlite running server-side instead of in the browser.
Do not choose "express-fullstack" just because the app has "data" or "state" — that is what vite-spa + client-side PGlite is for. Reserve it for requests that name a server-side concern outright.
NON-NEGOTIABLE: if the request explicitly asks for a server, an API, a backend, or data shared across a team/users/devices, stackProfile MUST be "express-fullstack". Never satisfy an explicitly requested server with client-side storage, and never describe client-side persistence as "simulating" a server.`;

// ─── Engine-owned server bootstrap (express-fullstack only) ─────────────
//
// server/index.js is engine-owned, mirroring how src/main.jsx is
// engine-owned on the frontend: it is the one deterministic seam the
// terminal gate's smoke test depends on. It imports the model-owned
// server/app.js (which must export the Express app) and only calls
// .listen() when NOT running under the check:server smoke test, so the
// smoke test can import the entire server module tree — exercising every
// route/db module the model wrote — without ever binding a port.
export const ENGINE_SERVER_BOOTSTRAP_PATH = "server/index.js";
export const MODEL_SERVER_APP_PATH = "server/app.js";

export function buildServerBootstrapFile(): GeneratedFile {
  return {
    name: ENGINE_SERVER_BOOTSTRAP_PATH,
    language: "javascript",
    code: `import { app } from "./app.js";

const port = process.env.PORT ? Number(process.env.PORT) : 3001;

// SMOKE_TEST=1 is set by "npm run check:server" (the terminal build gate's
// deterministic backend check): importing this module must fully construct
// the app and every route/db module it depends on without binding a port.
if (!process.env.SMOKE_TEST) {
  app.listen(port, () => {
    console.log(\`Server listening on port \${port}\`);
  });
}

export { app };
export default app;
`,
  };
}

export function isServerOwnedPath(rawPath: string): boolean {
  try {
    return /^server\//.test(normalizePath(rawPath));
  } catch {
    return false;
  }
}

export function isEngineServerBootstrapPath(rawPath: string): boolean {
  try {
    return normalizePath(rawPath) === ENGINE_SERVER_BOOTSTRAP_PATH;
  } catch {
    return false;
  }
}

export function isModelServerAppPath(rawPath: string): boolean {
  try {
    return normalizePath(rawPath) === MODEL_SERVER_APP_PATH;
  } catch {
    return false;
  }
}

/**
 * Every generator's cached system prompt bakes in SHARED_TECHNICAL_CONSTRAINTS
 * (prompts.ts), which flatly forbids Express — correct for vite-spa, wrong
 * for express-fullstack. Rather than branch the cached system prompt per
 * run (losing the cache), this returns a small, explicit override appended
 * to the (uncached) user prompt whenever stackProfile is express-fullstack;
 * empty string for vite-spa, where no override is needed.
 */
export function buildStackProfileGuidance(stackProfile: StackProfile): string {
  if (stackProfile !== "express-fullstack") {
    return "";
  }
  return `Stack profile: express-fullstack.
- This OVERRIDES the default "never use Express" constraint for this project only: server/app.js (Express, ESM) is the sanctioned backend entrypoint and is model-owned; import and configure express there, mount /api/* routes, and export the app (e.g. "export const app = express();").
- PGlite still applies but runs SERVER-SIDE inside server/db.js — use a plain filesystem directory path (e.g. new PGlite("./data/app-db")), never idb:// (that scheme is browser-only IndexedDB and does not exist in Node).
- The frontend (src/**) must NOT import express or PGlite directly, and must NOT read an env var for a base API URL — call the backend via same-origin fetch("/api/...") only. The dev-time Vite proxy and the production Express static-serve both make /api same-origin.
- server/**/*.js files are plain Node ESM: no JSX, no React/React-DOM imports, no window/document references, no TypeScript syntax even though the extension is .js.
- ${ENGINE_SERVER_BOOTSTRAP_PATH} already exists and is engine-owned (imports server/app.js and calls app.listen() outside the check:server smoke test) — do not create or edit it.`;
}

/**
 * Best-effort inference of the stack profile an EXISTING snapshot was built
 * with. Only used for follow-up runs: the working tree has to be seeded
 * before the current run's spec call decides anything, so a prior run's
 * committed profile is read back from its files instead of re-decided.
 * Cross-profile migration mid-project is out of scope — once a project has
 * an express-fullstack snapshot, follow-up runs stay on that profile
 * regardless of what a fresh spec call proposes.
 */
export function inferStackProfileFromFiles(files: GeneratedFile[]): StackProfile {
  const packageFile = files.find((file) => {
    try {
      return normalizePath(file.name) === "package.json";
    } catch {
      return false;
    }
  });

  if (packageFile) {
    try {
      const parsed = JSON.parse(packageFile.code) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
        scripts?: Record<string, unknown>;
      };
      const deps: Record<string, unknown> = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {}),
      };
      if (Object.prototype.hasOwnProperty.call(deps, "express")) {
        return "express-fullstack";
      }
      if (parsed.scripts && typeof parsed.scripts["check:server"] === "string") {
        return "express-fullstack";
      }
    } catch {
      // Fall through to structural detection below.
    }
  }

  if (files.some((file) => isServerOwnedPath(file.name))) {
    return "express-fullstack";
  }

  return DEFAULT_STACK_PROFILE;
}
