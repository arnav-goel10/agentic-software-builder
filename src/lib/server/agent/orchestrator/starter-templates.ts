import type { GeneratedFile } from "@/lib/server/types";
import type { SpecResponse } from "./types";

export type StarterTemplateProfileId = "frontend-core" | "frontend-pglite";

export type StarterTemplateSelection = {
  id: StarterTemplateProfileId;
  reason: string;
  seed: TemplateDiversitySeed;
};

export type TemplateDiversitySeed = {
  typography: string;
  colorSystem: string;
  layoutRhythm: string;
};

const TYPOGRAPHY_SEEDS = [
  "Modern geometric sans with strong heading contrast.",
  "Editorial serif headlines with clean sans body copy.",
  "Technical mono accents paired with neutral sans typography.",
  "Rounded humanist sans system with high legibility.",
];

const COLOR_SYSTEM_SEEDS = [
  "High-contrast night palette with cyan accents and warm highlights.",
  "Neutral slate base with emerald action colors and amber alerts.",
  "Light editorial palette with ink text and muted brand gradients.",
  "Dark dashboard palette with electric blue and rose accent cues.",
];

const LAYOUT_RHYTHM_SEEDS = [
  "Dense dashboard rhythm with compact cards and tight information hierarchy.",
  "Spacious marketing rhythm with large hero blocks and generous vertical spacing.",
  "Modular grid rhythm with alternating asymmetrical sections.",
  "Narrative scroll rhythm with progressive reveal sections and anchored CTAs.",
];

function hashSignal(signal: string): number {
  let hash = 2166136261;
  for (let index = 0; index < signal.length; index += 1) {
    hash ^= signal.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildDiversitySeed(signal: string): TemplateDiversitySeed {
  const hash = hashSignal(signal);
  const typography = TYPOGRAPHY_SEEDS[hash % TYPOGRAPHY_SEEDS.length];
  const colorSystem = COLOR_SYSTEM_SEEDS[(hash >>> 3) % COLOR_SYSTEM_SEEDS.length];
  const layoutRhythm = LAYOUT_RHYTHM_SEEDS[(hash >>> 7) % LAYOUT_RHYTHM_SEEDS.length];
  return {
    typography,
    colorSystem,
    layoutRhythm,
  };
}

const SHARED_FILES: GeneratedFile[] = [
  {
    name: "package.json",
    language: "json",
    code: `{
  "name": "dexter-project",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview",
    "start": "vite --host 0.0.0.0 --port 4173"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.22.3"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.2.1",
    "autoprefixer": "^10.4.18",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.1",
    "vite": "^5.1.5"
  }
}
`,
  },
  {
    name: "index.html",
    language: "html",
    code: `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dexter Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  },
  {
    name: "vite.config.js",
    language: "javascript",
    code: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
`,
  },
  {
    name: "postcss.config.js",
    language: "javascript",
    code: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
  },
  {
    name: "tailwind.config.js",
    language: "javascript",
    code: `/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
`,
  },
  {
    name: "src/main.jsx",
    language: "javascript",
    code: `import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
`,
  },
  {
    name: "src/index.css",
    language: "css",
    code: `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color: #e2e8f0;
  background: #020617;
  font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  min-height: 100%;
}

body {
  margin: 0;
}
`,
  },
];

function cloneTemplateFiles(files: GeneratedFile[]): GeneratedFile[] {
  return files.map((file) => ({ ...file }));
}

const ENGINE_OWNED_ENTRYPOINT_PATHS = new Set(["index.html", "src/main.jsx", "src/index.css"]);

/**
 * The bootstrap files SHARED_TECHNICAL_CONSTRAINTS promises models are already
 * provided (index.html, src/main.jsx, src/index.css). Exposed separately from
 * getStarterTemplateFiles() so package-manifest.ts can seed just these three
 * deterministically, independent of whether full starter templates are enabled.
 */
export function getEngineOwnedEntrypointFiles(): GeneratedFile[] {
  return cloneTemplateFiles(SHARED_FILES.filter((file) => ENGINE_OWNED_ENTRYPOINT_PATHS.has(file.name)));
}

function withTemplateAppAndExtras(params: {
  appCode: string;
  extras?: GeneratedFile[];
}): GeneratedFile[] {
  const baseWithoutApp = SHARED_FILES.slice();
  baseWithoutApp.push({
    name: "src/App.jsx",
    language: "javascript",
    code: params.appCode,
  });
  if (params.extras && params.extras.length > 0) {
    baseWithoutApp.push(...params.extras);
  }
  return baseWithoutApp;
}

const PGLITE_DB_BASE_FILE: GeneratedFile = {
  name: "src/lib/db.js",
  language: "javascript",
  code: `import { PGlite } from "@electric-sql/pglite";

const BASE_DATA_DIR = "idb://dexter-app-db";
let dbPromise = null;
let recoveryAttempt = 0;

function isFsBundleError(error) {
  const message = String(error?.message ?? "");
  return /invalid fs bundle size|fs bundle/i.test(message);
}

async function openDatabase(dataDir) {
  const db = new PGlite(dataDir);
  await db.waitReady;
  return db;
}

async function openInMemoryDatabase() {
  const db = new PGlite();
  await db.waitReady;
  return db;
}

async function createWithRecovery() {
  try {
    return await openDatabase(BASE_DATA_DIR);
  } catch (error) {
    recoveryAttempt += 1;
    const fallbackDir = \`\${BASE_DATA_DIR}-recovery-\${Date.now()}-\${recoveryAttempt}\`;
    try {
      return await openDatabase(fallbackDir);
    } catch (fallbackError) {
      if (isFsBundleError(error) || isFsBundleError(fallbackError)) {
        return openInMemoryDatabase();
      }
      throw fallbackError;
    }
  }
}

export async function getDb() {
  if (!dbPromise) {
    dbPromise = createWithRecovery();
  }
  return dbPromise;
}

export const db = getDb();

export async function verifyDbConnection() {
  const inst = await getDb();
  const result = await inst.query("SELECT 1 AS ok");
  return Boolean(result?.rows?.[0]?.ok);
}
`,
};

const FRONTEND_CORE_FILES = withTemplateAppAndExtras({
  appCode: `import React from "react";

export default function App() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-8 shadow-xl shadow-slate-950/40">
          <h1 className="text-3xl font-semibold tracking-tight">Frontend scaffold is ready</h1>
          <p className="mt-3 max-w-2xl text-slate-300">
            Routing and Tailwind are set up. Shape this into the exact UI requested by the user.
          </p>
        </div>
      </div>
    </main>
  );
}
`,
});

const FRONTEND_PGLITE_FILES = withTemplateAppAndExtras({
  appCode: `import React, { useEffect, useState } from "react";
import { verifyDbConnection } from "./lib/db";

export default function App() {
  const [status, setStatus] = useState("Checking local database...");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const ok = await verifyDbConnection();
        if (cancelled) return;
        if (ok) {
          setIsReady(true);
          setStatus("PGlite is ready. Build requested data flows and UI.");
        } else {
          setStatus("Database check returned an unexpected result.");
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(\`Database init failed: \${String(error?.message ?? error)}\`);
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <div className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-8 shadow-xl shadow-slate-950/40">
          <h1 className="text-3xl font-semibold tracking-tight">PGlite scaffold is ready</h1>
          <p className="mt-3 max-w-2xl text-slate-300">{status}</p>
          <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-slate-700/80 px-4 py-2 text-sm">
            <span
              className={
                isReady
                  ? "inline-block h-2.5 w-2.5 rounded-full bg-emerald-400"
                  : "inline-block h-2.5 w-2.5 rounded-full bg-amber-400"
              }
            />
            {isReady ? "Database Connected" : "Bootstrapping"}
          </div>
        </div>
      </div>
    </main>
  );
}
`,
  extras: [PGLITE_DB_BASE_FILE],
});

const STARTER_PROFILE_FILES: Record<StarterTemplateProfileId, GeneratedFile[]> = {
  "frontend-core": FRONTEND_CORE_FILES,
  "frontend-pglite": FRONTEND_PGLITE_FILES,
};

export const DEFAULT_STARTER_TEMPLATE_PROFILE: StarterTemplateProfileId = "frontend-core";

export const STARTER_TEMPLATE_FILES: GeneratedFile[] = FRONTEND_CORE_FILES;

export function getStarterTemplateFiles(
  profile: StarterTemplateProfileId = DEFAULT_STARTER_TEMPLATE_PROFILE
): GeneratedFile[] {
  return cloneTemplateFiles(
    STARTER_PROFILE_FILES[profile] ?? STARTER_PROFILE_FILES[DEFAULT_STARTER_TEMPLATE_PROFILE]
  );
}

const PGLITE_STRONG_SIGNAL_PATTERN =
  /\b(database|db|postgres|sqlite|sql|table|schema|migration|pglite|auth|authentication|login|sign[\s-]?in|sign[\s-]?up|account|session|backend|api|endpoint|crud|persist|persistence|indexeddb|local\s+storage)\b/i;
const PGLITE_NEGATION_PATTERN =
  /\b(?:no|without|avoid|skip|not needed|not required|do not need|don't need|unnecessary|instead of)\b[\s\S]{0,50}\b(?:database|db|backend|server|api|auth|authentication|accounts?|session|persistence|storage|postgres|sqlite|sql|pglite|crud|indexeddb)\b|\b(?:database|db|backend|server|api|auth|authentication|accounts?|session|persistence|storage|postgres|sqlite|sql|pglite|crud|indexeddb)\b[\s\S]{0,50}\b(?:is not needed|isn't needed|is not required|isn't required|is unnecessary|are not needed|aren't needed|are unnecessary|is overkill|are overkill)\b/i;
const STATIC_FRONTEND_PATTERN =
  /\b(static data|landing page|marketing site|brochure site|content site|portfolio site)\b/i;

function stripNegatedPersistenceLines(signal: string): string {
  return signal
    .split(/\r?\n/g)
    .filter((rawLine) => {
      const line = rawLine.trim();
      if (!line) return false;
      if (!PGLITE_NEGATION_PATTERN.test(line)) return true;
      return !PGLITE_STRONG_SIGNAL_PATTERN.test(line);
    })
    .join("\n");
}

function needsPgliteStarter(signal: string): boolean {
  const normalized = signal.toLowerCase();
  const normalizedForPositiveScore = stripNegatedPersistenceLines(normalized);
  let score = 0;

  if (/\b(database|db|postgres|sqlite|sql|schema|table|migration|pglite)\b/.test(normalizedForPositiveScore)) {
    score += 3;
  }
  if (/\b(auth|authentication|login|sign[\s-]?in|sign[\s-]?up|account|session)\b/.test(normalizedForPositiveScore)) {
    score += 3;
  }
  if (/\b(backend|api|endpoint|crud)\b/.test(normalizedForPositiveScore)) {
    score += 2;
  }
  if (/\b(persist|persistence|indexeddb|local\s+storage|offline)\b/.test(normalizedForPositiveScore)) {
    score += 2;
  }

  if (PGLITE_NEGATION_PATTERN.test(normalized)) {
    score -= 5;
  }
  if (STATIC_FRONTEND_PATTERN.test(normalized)) {
    score -= 3;
  }

  if (!PGLITE_STRONG_SIGNAL_PATTERN.test(normalizedForPositiveScore)) {
    return false;
  }
  return score >= 3;
}

export function selectStarterTemplateProfile(input: {
  userPrompt: string;
  spec: SpecResponse;
}): StarterTemplateSelection {
  const signal = [
    input.userPrompt,
    input.spec.summary,
    ...input.spec.requirements,
    ...input.spec.acceptanceCriteria,
    ...input.spec.nonGoals,
    ...input.spec.testChecklist,
  ]
    .filter(Boolean)
    .join("\n");

  const seed = buildDiversitySeed(signal);

  if (needsPgliteStarter(signal)) {
    return {
      id: "frontend-pglite",
      reason:
        "Spec/request signals persistence or backend-like requirements, so the run starts from the PGlite-enabled baseline scaffold.",
      seed,
    };
  }

  return {
    id: "frontend-core",
    reason:
      "Using the general frontend baseline scaffold with routing and Tailwind preconfigured.",
    seed,
  };
}
