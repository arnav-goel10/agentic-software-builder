import type { GeneratedFile } from "@/lib/server/types";
import type { FileOperation } from "@/lib/server/agent/validation";
import { normalizePath } from "@/lib/server/agent/validation";
import { getEngineOwnedEntrypointFiles } from "@/lib/server/agent/orchestrator/starter-templates";
import {
  buildServerBootstrapFile,
  DEFAULT_STACK_PROFILE,
  ENGINE_SERVER_BOOTSTRAP_PATH,
  type StackProfile,
} from "@/lib/server/agent/orchestrator/stack-profiles";

export const PACKAGE_JSON_PATH = "package.json";
const VITE_CONFIG_PATH = "vite.config.js";
const POSTCSS_CONFIG_PATH = "postcss.config.js";
const TAILWIND_CONFIG_PATH = "tailwind.config.js";
const INDEX_HTML_PATH = "index.html";
const MAIN_JSX_PATH = "src/main.jsx";
const INDEX_CSS_PATH = "src/index.css";

const DEFAULT_PACKAGE_NAME = "dexter-project";

const DEFAULT_SCRIPTS: Record<string, string> = {
  dev: "vite",
  build: "vite build",
  preview: "vite preview",
  start: "vite --host 0.0.0.0 --port 4173",
};

// express-fullstack scripts: "dev" still just runs Vite (the proxy config
// forwards /api to the API server); "dev:server" runs the Express API with
// --watch; "build" stays frontend-only (vite build); "start" runs the
// production server (which serves dist/ + /api/* from server/app.js); and
// "check:server" is the terminal build gate's deterministic backend smoke
// test — see stack-profiles.ts's buildServerBootstrapFile for the
// SMOKE_TEST contract it depends on.
const EXPRESS_FULLSTACK_SCRIPTS: Record<string, string> = {
  dev: "vite",
  "dev:server": "node --watch server/index.js",
  build: "vite build",
  preview: "vite preview",
  start: "node server/index.js",
  "check:server": "SMOKE_TEST=1 node server/index.js",
};

const DEFAULT_DEPENDENCIES: Record<string, string> = {
  react: "^18.2.0",
  "react-dom": "^18.2.0",
};

const EXPRESS_FULLSTACK_EXTRA_DEPENDENCIES: Record<string, string> = {
  express: "^4.19.2",
  "@electric-sql/pglite": "^0.2.0",
};

const DEFAULT_DEV_DEPENDENCIES: Record<string, string> = {
  vite: "^5.1.5",
  "@vitejs/plugin-react": "^4.2.1",
  tailwindcss: "^3.4.1",
  postcss: "^8.4.35",
  autoprefixer: "^10.4.18",
};

const KNOWN_VERSIONS: Record<string, string> = {
  ...DEFAULT_DEPENDENCIES,
  ...DEFAULT_DEV_DEPENDENCIES,
  "@types/react": "^18.2.66",
  "@types/react-dom": "^18.2.22",
  "react-router-dom": "^6.22.3",
  "framer-motion": "^10.16.4",
  "lucide-react": "^0.344.0",
  clsx: "^2.1.0",
  "tailwind-merge": "^2.2.1",
  "class-variance-authority": "^0.7.0",
  "date-fns": "^3.3.1",
  "@electric-sql/pglite": "^0.2.0",
  express: "^4.19.2",
  tailwindcss: "^3.4.1",
  postcss: "^8.4.35",
  autoprefixer: "^10.4.18",
};

const DEV_PACKAGE_NAMES = new Set<string>([
  ...Object.keys(DEFAULT_DEV_DEPENDENCIES),
  "@types/react",
  "@types/react-dom",
  "typescript",
  "eslint",
  "prettier",
]);

const NODE_BUILTINS = new Set<string>([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "os",
  "path",
  "stream",
  "timers",
  "url",
  "util",
  "zlib",
]);

const SUSPICIOUS_POLYFILL_REPEAT_PATTERN =
  /^polyfill-(assert|buffer|crypto|events|fs|http|https|os|path|stream|timers|url|util|zlib)-\1$/;

const IMPORT_SPECIFIER_PATTERN =
  /(?:import\s+[^'"]*from\s*['"]([^'"]+)['"])|(?:export\s+[^'"]*from\s*['"]([^'"]+)['"])|(?:import\(\s*['"]([^'"]+)['"]\s*\))|(?:require\(\s*['"]([^'"]+)['"]\s*\))/g;

type ParsedPackageJson = {
  name?: unknown;
  private?: unknown;
  version?: unknown;
  type?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
};

type PackageBucket = "dependencies" | "devDependencies";

export function isEngineOwnedConfigPath(
  path: string,
  stackProfile: StackProfile = DEFAULT_STACK_PROFILE
): boolean {
  const baseOwned =
    path === PACKAGE_JSON_PATH ||
    /^vite\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    /^postcss\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    /^tailwind\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    path === INDEX_HTML_PATH ||
    path === MAIN_JSX_PATH ||
    path === INDEX_CSS_PATH;
  if (baseOwned) return true;

  // server/index.js is the only additional engine-owned file the
  // express-fullstack profile adds — see stack-profiles.ts. Everything else
  // under server/ (server/app.js, routes, db) is model territory.
  return stackProfile === "express-fullstack" && path === ENGINE_SERVER_BOOTSTRAP_PATH;
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) continue;
    if (typeof raw !== "string" || !raw.trim()) continue;
    output[key] = raw.trim();
  }
  return output;
}

function parsePackageJson(files: GeneratedFile[]): ParsedPackageJson | null {
  const packageFile = files.find((file) => normalizePath(file.name) === PACKAGE_JSON_PATH);
  if (!packageFile) return null;

  try {
    const parsed = JSON.parse(packageFile.code);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ParsedPackageJson;
  } catch {
    return null;
  }
}

function extractPackageName(specifier: string): string | null {
  const trimmed = specifier.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(".") || trimmed.startsWith("/") || trimmed.startsWith("@/")) {
    return null;
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return null;
  }
  if (trimmed.startsWith("node:")) {
    return null;
  }

  if (trimmed.startsWith("@")) {
    const parts = trimmed.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  const [name] = trimmed.split("/");
  return name || null;
}

function looksLikeConfigFile(path: string): boolean {
  return (
    /^vite\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    /^tailwind\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    /^postcss\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    /^eslint\.config\.(js|ts|mjs|cjs)$/.test(path) ||
    /^.*\.config\.(js|ts|mjs|cjs)$/.test(path)
  );
}

function inferBucket(filePath: string, packageName: string): PackageBucket {
  if (DEV_PACKAGE_NAMES.has(packageName) || looksLikeConfigFile(filePath)) {
    return "devDependencies";
  }
  return "dependencies";
}

function collectImportedPackages(files: GeneratedFile[]): Map<string, PackageBucket> {
  const packages = new Map<string, PackageBucket>();

  for (const file of files) {
    const normalizedPath = normalizePath(file.name);
    if (normalizedPath === PACKAGE_JSON_PATH) continue;

    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPECIFIER_PATTERN.exec(file.code)) !== null) {
      const specifier = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!specifier) continue;

      const packageName = extractPackageName(specifier);
      if (!packageName) continue;
      if (NODE_BUILTINS.has(packageName)) continue;

      const nextBucket = inferBucket(normalizedPath, packageName);
      const existingBucket = packages.get(packageName);
      if (!existingBucket) {
        packages.set(packageName, nextBucket);
        continue;
      }

      if (existingBucket === "devDependencies" && nextBucket === "dependencies") {
        packages.set(packageName, "dependencies");
      }
    }
  }

  return packages;
}

function looksLikeTailwindUtilityUsage(code: string): boolean {
  if (!/(className|class)\s*=/.test(code)) {
    return false;
  }

  return /\b(?:bg|text|rounded|px|py|pt|pb|pl|pr|mx|my|mt|mb|min-h|max-h|min-w|max-w|w|h|flex|grid|items|justify|gap|space-x|space-y|font|leading|tracking|shadow|border|hover:|focus:|sm:|md:|lg:|xl:|2xl:|dark:)[-:\w[\]/%.]+/i.test(
    code
  );
}

function collectToolingPackages(files: GeneratedFile[]): Map<string, PackageBucket> {
  const packages = new Map<string, PackageBucket>();

  for (const file of files) {
    const normalizedPath = normalizePath(file.name);
    const lowerCode = file.code.toLowerCase();
    const hasTailwindImport = /@import\s+['"]tailwindcss['"]/.test(lowerCode);
    const hasTailwindAtRule = /@tailwind\s+(base|components|utilities)/.test(lowerCode);
    const hasTailwindUtilityUsage = looksLikeTailwindUtilityUsage(file.code);

    const usesTailwindTooling =
      /^tailwind\.config\.(js|ts|mjs|cjs)$/.test(normalizedPath) ||
      /^postcss\.config\.(js|ts|mjs|cjs)$/.test(normalizedPath) ||
      hasTailwindAtRule ||
      hasTailwindImport ||
      hasTailwindUtilityUsage;

    if (usesTailwindTooling) {
      packages.set("tailwindcss", "devDependencies");
      packages.set("postcss", "devDependencies");
      packages.set("autoprefixer", "devDependencies");
    }
  }

  return packages;
}


function buildViteConfigCode(options: { excludePglite: boolean; apiProxy: boolean }): string {
  const optimizeDepsBlock = options.excludePglite
    ? `
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
  },`
    : "";
  // express-fullstack: dev-time /api proxy so the frontend can call fetch
  // ("/api/...") uniformly in dev and production, without needing separate
  // origins. server/index.js listens on 3001 by default (see stack-profiles.ts).
  const proxyBlock = options.apiProxy
    ? `
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },`
    : "";

  return `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],${optimizeDepsBlock}
  server: {
    host: "0.0.0.0",
    port: 5173,${proxyBlock}
  },
});
`;
}

function needsPgliteViteGuard(files: GeneratedFile[]): boolean {
  return files.some((file) => {
    const code = file.code;
    return (
      /@electric-sql\/pglite/.test(code) ||
      /\bnew\s+PGlite\s*\(/.test(code) ||
      /idb:\/\//i.test(code)
    );
  });
}

function ensureBaselineBuildConfigs(
  files: GeneratedFile[],
  stackProfile: StackProfile
): GeneratedFile[] {
  const next = [...files];
  const pgliteViteGuard = needsPgliteViteGuard(next);
  const apiProxy = stackProfile === "express-fullstack";
  const names = new Set(next.map((file) => normalizePath(file.name)));

  const viteConfigIndices: number[] = [];
  next.forEach((file, index) => {
    const normalizedPath = normalizePath(file.name);
    if (/^vite\.config\.(js|ts|mjs|cjs)$/.test(normalizedPath)) {
      viteConfigIndices.push(index);
    }
  });
  if (viteConfigIndices.length === 0) {
    next.push({
      name: VITE_CONFIG_PATH,
      language: "javascript",
      code: buildViteConfigCode({ excludePglite: pgliteViteGuard, apiProxy }),
    });
  } else {
    for (const index of viteConfigIndices) {
      const existing = next[index];
      next[index] = {
        ...existing,
        code: buildViteConfigCode({ excludePglite: pgliteViteGuard, apiProxy }),
      };
    }
  }

  const hasPostcssConfig = Array.from(names).some((name) =>
    /^postcss\.config\.(js|ts|mjs|cjs)$/.test(name)
  );
  if (!hasPostcssConfig) {
    next.push({
      name: POSTCSS_CONFIG_PATH,
      language: "javascript",
      code: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
    });
  }

  const hasTailwindConfig = Array.from(names).some((name) =>
    /^tailwind\.config\.(js|ts|mjs|cjs)$/.test(name)
  );
  if (!hasTailwindConfig) {
    next.push({
      name: TAILWIND_CONFIG_PATH,
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
    });
  }

  return next;
}

function ensureBaselineEntrypointFiles(
  files: GeneratedFile[],
  stackProfile: StackProfile
): GeneratedFile[] {
  const next = [...files];
  const names = new Set(next.map((file) => normalizePath(file.name)));

  for (const entrypointFile of getEngineOwnedEntrypointFiles()) {
    if (!names.has(normalizePath(entrypointFile.name))) {
      next.push(entrypointFile);
    }
  }

  // express-fullstack's one engine-owned server file: a tiny bootstrap that
  // imports the model-owned server/app.js and only listens outside smoke
  // mode. See stack-profiles.ts for the full rationale.
  if (stackProfile === "express-fullstack" && !names.has(ENGINE_SERVER_BOOTSTRAP_PATH)) {
    next.push(buildServerBootstrapFile());
  }

  return next;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = record[key];
  }
  return sorted;
}

function getVersion(
  packageName: string,
  existingDeps: Record<string, string>,
  existingDevDeps: Record<string, string>
): string {
  if (existingDeps[packageName]) return existingDeps[packageName];
  if (existingDevDeps[packageName]) return existingDevDeps[packageName];
  return KNOWN_VERSIONS[packageName] ?? "latest";
}

function shouldSkipImportedPackage(
  packageName: string,
  existingDeps: Record<string, string>,
  existingDevDeps: Record<string, string>
): boolean {
  if (existingDeps[packageName] || existingDevDeps[packageName]) {
    return false;
  }
  if (KNOWN_VERSIONS[packageName]) {
    return false;
  }
  if (SUSPICIOUS_POLYFILL_REPEAT_PATTERN.test(packageName)) {
    return true;
  }
  return false;
}

export function ensureDeterministicPackageManifest(
  files: GeneratedFile[],
  stackProfile: StackProfile = DEFAULT_STACK_PROFILE
): GeneratedFile[] {
  const existingPackage = parsePackageJson(files);
  const existingDependencies = toStringRecord(existingPackage?.dependencies);
  const existingDevDependencies = toStringRecord(existingPackage?.devDependencies);
  const existingScripts = toStringRecord(existingPackage?.scripts);

  const dependencies: Record<string, string> = {
    ...DEFAULT_DEPENDENCIES,
    ...(stackProfile === "express-fullstack" ? EXPRESS_FULLSTACK_EXTRA_DEPENDENCIES : {}),
  };
  const devDependencies: Record<string, string> = {
    ...DEFAULT_DEV_DEPENDENCIES,
  };

  const importedPackages = collectImportedPackages(files);
  const toolingPackages = collectToolingPackages(files);
  for (const [packageName, bucket] of toolingPackages.entries()) {
    importedPackages.set(packageName, bucket);
  }

  for (const [packageName, bucket] of importedPackages.entries()) {
    if (shouldSkipImportedPackage(packageName, existingDependencies, existingDevDependencies)) {
      continue;
    }

    const version = getVersion(packageName, existingDependencies, existingDevDependencies);
    if (bucket === "devDependencies") {
      devDependencies[packageName] = version;
      if (packageName in dependencies) {
        delete dependencies[packageName];
      }
      continue;
    }

    dependencies[packageName] = version;
    if (packageName in devDependencies && !DEV_PACKAGE_NAMES.has(packageName)) {
      delete devDependencies[packageName];
    }
  }

  const scripts = {
    ...existingScripts,
    ...(stackProfile === "express-fullstack" ? EXPRESS_FULLSTACK_SCRIPTS : DEFAULT_SCRIPTS),
  };

  const packageJson = {
    name:
      typeof existingPackage?.name === "string" && existingPackage.name.trim()
        ? existingPackage.name.trim()
        : DEFAULT_PACKAGE_NAME,
    private:
      typeof existingPackage?.private === "boolean" ? existingPackage.private : true,
    version:
      typeof existingPackage?.version === "string" && existingPackage.version.trim()
        ? existingPackage.version.trim()
        : "0.0.0",
    type:
      typeof existingPackage?.type === "string" && existingPackage.type.trim()
        ? existingPackage.type.trim()
        : "module",
    scripts: sortRecord(scripts),
    dependencies: sortRecord(dependencies),
    devDependencies: sortRecord(devDependencies),
  };

  const normalizedFiles = ensureBaselineEntrypointFiles(
    ensureBaselineBuildConfigs(
      files.filter((file) => normalizePath(file.name) !== PACKAGE_JSON_PATH),
      stackProfile
    ),
    stackProfile
  );
  normalizedFiles.push({
    name: PACKAGE_JSON_PATH,
    language: "json",
    code: `${JSON.stringify(packageJson, null, 2)}\n`,
  });

  return normalizedFiles;
}

export function stripPackageManifestOperations(
  operations: FileOperation[],
  stackProfile: StackProfile = DEFAULT_STACK_PROFILE
): {
  filtered: FileOperation[];
  strippedCount: number;
} {
  const filtered: FileOperation[] = [];
  let strippedCount = 0;

  for (const operation of operations) {
    const normalizedPath = normalizePath(operation.path);
    if (isEngineOwnedConfigPath(normalizedPath, stackProfile)) {
      strippedCount += 1;
      continue;
    }
    filtered.push(operation);
  }

  return { filtered, strippedCount };
}
