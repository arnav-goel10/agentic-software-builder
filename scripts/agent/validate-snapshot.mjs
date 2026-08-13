#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const IMPORT_WITH_FROM_PATTERN = /import\s+([\s\S]*?)\s+from\s*["'`]([^"'`]+)["'`]/g;
const EXPORT_DECLARATION_PATTERN =
  /export\s+(?:async\s+function|function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_NAMED_BLOCK_PATTERN = /export\s*{\s*([^}]+)\s*}(?:\s*from\s*["'`][^"'`]+["'`])?/g;
const EXPORT_ALL_PATTERN = /export\s+\*\s+from\s*["'`][^"'`]+["'`]/;
const ROOT_APP_FILE_PATTERN = /^App\.(jsx|tsx|js|ts)$/;
const SRC_APP_FILE_PATTERN = /^src\/App\.(jsx|tsx|js|ts)$/;
const ROOT_MAIN_FILE_PATTERN = /^main\.(jsx|tsx|js|ts)$/;
const SRC_MAIN_FILE_PATTERN = /^src\/main\.(jsx|tsx|js|ts)$/;
const ROOT_INDEX_FILE_PATTERN = /^index\.(jsx|tsx|js|ts)$/;
const SRC_INDEX_FILE_PATTERN = /^src\/index\.(jsx|tsx|js|ts)$/;
const PROCESS_ENV_PATTERN = /\bprocess\s*\.\s*env\b/;
const NATIVE_DIALOG_PATTERN = /\b(?:window\.)?(?:alert|prompt|confirm)\s*\(/;
const TAILWIND_CSS_INVALID_DIRECTIVE_PATTERN = /@import\s+['"]tailwindcss['"]/i;
const POSTCSS_CONFIG_FILE_PATTERN = /^postcss\.config\.(js|ts|mjs|cjs)$/;
const CSS_FILE_PATTERN = /\.css$/i;
const PGLITE_INIT_CALL_PATTERN = /\bnew\s+PGlite\s*\(/;
const VITE_CONFIG_FILE_PATTERN = /^vite\.config\.(js|ts|mjs|cjs)$/;
const HOOK_IN_BLOCK_PATTERN =
  /\.(map|forEach|filter|reduce)\s*\(\s*(?:[^=>]*=>\s*{?|function\s*[^)]*\)\s*{?)(?:[^{}]*{[^{}]*})*[^}]*\buse[A-Z]\w*\b/;
const HOOK_IN_IF_PATTERN = /\bif\s*\([^)]*\)\s*{[^{}]*\buse[A-Z]\w*\b/;
const SHADCN_SEMANTIC_UTILITY_PATTERN =
  /\b(?:border-border|bg-background|text-foreground|ring-ring|border-input|bg-card|text-card-foreground|bg-popover|text-popover-foreground|bg-muted|text-muted-foreground|bg-primary|text-primary-foreground|bg-secondary|text-secondary-foreground|bg-accent|text-accent-foreground|bg-destructive|text-destructive-foreground)\b/;

function parseArgs(argv) {
  const args = {
    dbPath: process.env.DEXTER_DB_PATH?.trim() || path.resolve("data/dexter.sqlite"),
    projectId: "",
    snapshotId: "",
    allowEmpty: false,
    json: false,
    failOnSoft: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === "--db" && next) {
      args.dbPath = path.resolve(next);
      index += 1;
      continue;
    }
    if (token === "--project-id" && next) {
      args.projectId = next.trim();
      index += 1;
      continue;
    }
    if (token === "--snapshot-id" && next) {
      args.snapshotId = next.trim();
      index += 1;
      continue;
    }
    if (token === "--allow-empty") {
      args.allowEmpty = true;
      continue;
    }
    if (token === "--json") {
      args.json = true;
      continue;
    }
    if (token === "--fail-on-soft") {
      args.failOnSoft = true;
      continue;
    }
  }
  return args;
}

function normalizePath(rawName) {
  return String(rawName || "")
    .replace(/\\+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .trim();
}

function looksLikeCodeFile(fileName) {
  return /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(fileName);
}

function isBrowserSourceFile(fileName) {
  if (ROOT_APP_FILE_PATTERN.test(fileName)) return true;
  if (SRC_APP_FILE_PATTERN.test(fileName)) return true;
  if (ROOT_MAIN_FILE_PATTERN.test(fileName)) return true;
  if (SRC_MAIN_FILE_PATTERN.test(fileName)) return true;
  if (ROOT_INDEX_FILE_PATTERN.test(fileName)) return true;
  if (SRC_INDEX_FILE_PATTERN.test(fileName)) return true;
  if (/^src\/.+\.(js|jsx|ts|tsx)$/.test(fileName)) return true;
  return false;
}

function parseFilesJson(filesJson) {
  try {
    const parsed = JSON.parse(filesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((file) => {
        if (!file || typeof file !== "object") return null;
        const name = normalizePath(file.name);
        const code = typeof file.code === "string" ? file.code : "";
        if (!name || !code) return null;
        return { name, code };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stripStringsAndComments(source) {
  let output = "";
  let index = 0;
  let state = "code";
  let quote = "";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1] ?? "";

    if (state === "code") {
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        state = char === "`" ? "template" : "string";
        output += " ";
        index += 1;
        continue;
      }
      if (char === "/" && next === "/") {
        state = "line_comment";
        output += "  ";
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block_comment";
        output += "  ";
        index += 2;
        continue;
      }
      output += char;
      index += 1;
      continue;
    }

    if (state === "line_comment") {
      output += char === "\n" ? "\n" : " ";
      if (char === "\n") {
        state = "code";
      }
      index += 1;
      continue;
    }

    if (state === "block_comment") {
      if (char === "*" && next === "/") {
        output += "  ";
        index += 2;
        state = "code";
        continue;
      }
      output += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    if (state === "string" || state === "template") {
      if (char === "\\") {
        output += "  ";
        index += 2;
        continue;
      }
      if (char === quote) {
        output += " ";
        index += 1;
        state = "code";
        continue;
      }
      output += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
  }

  return output;
}

function resolveLocalModulePath(importerPath, specifier, fileNames) {
  const basePath = specifier.startsWith("/")
    ? specifier.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));
  const normalizedBase = basePath.replace(/^\.?\//, "");
  if (!normalizedBase || normalizedBase.startsWith("../")) return null;

  const hasExtension = /\.[A-Za-z0-9]+$/.test(normalizedBase);
  const extensionCandidates = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
  const candidates = [];
  if (hasExtension) {
    candidates.push(normalizedBase);
  } else {
    candidates.push(normalizedBase);
    for (const extension of extensionCandidates) candidates.push(`${normalizedBase}${extension}`);
    for (const extension of extensionCandidates) candidates.push(`${normalizedBase}/index${extension}`);
  }
  for (const candidate of candidates) {
    if (fileNames.has(candidate)) return candidate;
  }
  return null;
}

function parseNamedImportSpecifiers(importClause) {
  const namedBlockMatch = importClause.match(/{([^}]*)}/);
  if (!namedBlockMatch) return [];
  return namedBlockMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^type\s+/, ""))
    .map((part) => part.split(/\s+as\s+/i)[0]?.trim())
    .filter(Boolean);
}

function parseDefaultImportSpecifier(importClause) {
  const trimmed = importClause.trim();
  if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("*")) return null;
  const firstSegment = trimmed.split(",")[0]?.trim();
  if (!firstSegment) return null;
  const candidate = firstSegment.replace(/^type\s+/, "").trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(candidate)) return null;
  return candidate;
}

function parseModuleExports(fileCode) {
  const names = new Set();
  const counts = new Map();
  const register = (rawName) => {
    const name = rawName?.trim();
    if (!name) return;
    names.add(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };

  EXPORT_DECLARATION_PATTERN.lastIndex = 0;
  let declarationMatch;
  while ((declarationMatch = EXPORT_DECLARATION_PATTERN.exec(fileCode)) !== null) {
    register(declarationMatch[1]);
  }

  EXPORT_NAMED_BLOCK_PATTERN.lastIndex = 0;
  let blockMatch;
  while ((blockMatch = EXPORT_NAMED_BLOCK_PATTERN.exec(fileCode)) !== null) {
    const tokens = blockMatch[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const token of tokens) {
      const withoutType = token.replace(/^type\s+/, "");
      const parts = withoutType.split(/\s+as\s+/i);
      const exportedName = parts[1]?.trim() ?? parts[0]?.trim();
      register(exportedName);
    }
  }

  const duplicateNames = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  return {
    names,
    hasExportAll: EXPORT_ALL_PATTERN.test(fileCode),
    hasDefaultExport: /\bexport\s+default\b/.test(fileCode),
    duplicateNames,
  };
}

function collectIssues(files) {
  const hard = [];
  const soft = [];
  const fileNames = new Set(files.map((file) => file.name));
  const packageFile = files.find((file) => file.name === "package.json");
  let declaredDeps = new Set();
  if (packageFile) {
    try {
      const parsed = JSON.parse(packageFile.code);
      declaredDeps = new Set([
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ]);
    } catch {
      hard.push({
        code: "deps.invalid_package_json",
        message: "package.json is invalid JSON",
        file: "package.json",
      });
    }
  }

  const exportCache = new Map();
  const getExportsForFile = (filePath) => {
    if (exportCache.has(filePath)) return exportCache.get(filePath);
    const source = files.find((file) => file.name === filePath);
    const parsed = source ? parseModuleExports(source.code) : parseModuleExports("");
    exportCache.set(filePath, parsed);
    return parsed;
  };

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) continue;
    const parsed = getExportsForFile(file.name);
    if (parsed.duplicateNames.length > 0) {
      hard.push({
        code: "exports.duplicate_named_export",
        message: `Duplicate named exports: ${parsed.duplicateNames.join(", ")}`,
        file: file.name,
      });
    }
  }

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) continue;
    IMPORT_WITH_FROM_PATTERN.lastIndex = 0;
    let importMatch;
    while ((importMatch = IMPORT_WITH_FROM_PATTERN.exec(file.code)) !== null) {
      const importClause = (importMatch[1] ?? "").trim();
      const specifier = (importMatch[2] ?? "").trim();
      if (!importClause || !specifier) continue;
      if (!(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/"))) {
        continue;
      }
      const namedImports = parseNamedImportSpecifiers(importClause);
      const defaultImport = parseDefaultImportSpecifier(importClause);
      const resolved = resolveLocalModulePath(file.name, specifier, fileNames);
      if (!resolved) {
        hard.push({
          code: "imports.local_missing_module",
          message: `Cannot resolve local module "${specifier}"`,
          file: file.name,
        });
        continue;
      }
      const moduleExports = getExportsForFile(resolved);
      if (defaultImport && !moduleExports.hasDefaultExport) {
        hard.push({
          code: "imports.local_missing_default_export",
          message: `Missing default export in "${resolved}" for import "${defaultImport}"`,
          file: file.name,
        });
      }
      if (!moduleExports.hasExportAll) {
        for (const importedName of namedImports) {
          if (!moduleExports.names.has(importedName)) {
            hard.push({
              code: "imports.local_missing_export",
              message: `Missing named export "${importedName}" in "${resolved}"`,
              file: file.name,
            });
          }
        }
      }
    }
  }

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) continue;
    const sanitizedCode = stripStringsAndComments(file.code);
    if (HOOK_IN_BLOCK_PATTERN.test(sanitizedCode)) {
      hard.push({
        code: "react.hook_in_loop",
        message: "React hook appears inside iterator callback",
        file: file.name,
      });
    } else if (HOOK_IN_IF_PATTERN.test(sanitizedCode)) {
      hard.push({
        code: "react.hook_in_conditional",
        message: "React hook appears inside conditional block",
        file: file.name,
      });
    }
  }

  for (const file of files) {
    if (isBrowserSourceFile(file.name) && PROCESS_ENV_PATTERN.test(file.code)) {
      hard.push({
        code: "env.process_undefined_in_browser",
        message: "process.env used in browser file; use import.meta.env",
        file: file.name,
      });
    }
  }

  for (const file of files) {
    if (isBrowserSourceFile(file.name) && NATIVE_DIALOG_PATTERN.test(file.code)) {
      soft.push({
        code: "ui.native_dialog_api",
        message: "Native dialog API used (alert/prompt/confirm)",
        file: file.name,
      });
    }
  }

  for (const file of files) {
    if (!CSS_FILE_PATTERN.test(file.name)) continue;
    if (TAILWIND_CSS_INVALID_DIRECTIVE_PATTERN.test(file.code)) {
      hard.push({
        code: "tailwind.css_invalid_directive",
        message: "Invalid '@import \"tailwindcss\";' directive in CSS (Tailwind v4 unsupported in WebContainers)",
        file: file.name,
      });
    }
    if (file.code.includes("@apply")) {
      const lines = file.code.split("\n");
      for (const line of lines) {
        if (line.includes("@apply") && SHADCN_SEMANTIC_UTILITY_PATTERN.test(line)) {
          soft.push({
            code: "tailwind.css_apply_semantic_token",
            message: "Semantic shadcn token used in @apply without explicit theme tokens",
            file: file.name,
          });
          break;
        }
      }
    }
  }

  for (const file of files) {
    if (!POSTCSS_CONFIG_FILE_PATTERN.test(file.name)) continue;
    const lower = file.code.toLowerCase();
    const referencesTailwind = lower.includes("tailwindcss");
    const usesTailwindPostcss = lower.includes("@tailwindcss/postcss");
    if (usesTailwindPostcss) {
      hard.push({
        code: "tailwind.postcss_plugin_v4_unsafe",
        message: "Tailwind v4 postcss plugin is unsupported in WebContainers",
        file: file.name,
      });
    }
    if (referencesTailwind && !usesTailwindPostcss && !declaredDeps.has("tailwindcss")) {
      hard.push({
        code: "tailwind.postcss_plugin_missing_dependency",
        message: "tailwindcss missing from dependencies",
        file: "package.json",
      });
    }
  }

  const codeFiles = files.filter((file) => looksLikeCodeFile(file.name));
  const usesPglite = codeFiles.some((file) => {
    return /@electric-sql\/pglite/.test(file.code) || PGLITE_INIT_CALL_PATTERN.test(file.code);
  });

  for (const file of codeFiles) {
    const hasDefaultPgliteImport =
      /import\s+[A-Za-z_$][\w$]*(?:\s*,\s*{[^}]*})?\s+from\s*["'`]@electric-sql\/pglite["'`]/.test(
        file.code
      );
    if (hasDefaultPgliteImport) {
      hard.push({
        code: "pglite.invalid_default_import",
        message: "Default import used for @electric-sql/pglite",
        file: file.name,
      });
    }
  }

  if (usesPglite) {
    const viteConfig = files.find((file) => VITE_CONFIG_FILE_PATTERN.test(file.name));
    if (!viteConfig) {
      hard.push({
        code: "pglite.vite_config_missing",
        message: "PGlite used without vite config",
      });
    } else {
      const hasExclude = /optimizeDeps\s*:\s*{[\s\S]*exclude\s*:\s*\[[^\]]*@electric-sql\/pglite[^\]]*\]/i.test(
        viteConfig.code
      );
      if (!hasExclude) {
        hard.push({
          code: "pglite.vite_optimize_deps_missing",
          message: "Missing optimizeDeps.exclude for @electric-sql/pglite",
          file: viteConfig.name,
        });
      }
    }
  }

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) continue;
    if (/\btotalValue\.toFixed\(/.test(file.code) && !/\btotalValue\?\.\s*toFixed\(/.test(file.code)) {
      soft.push({
        code: "runtime.risky_total_value_tofixed",
        message: "totalValue.toFixed() without optional chaining/fallback may crash at runtime",
        file: file.name,
      });
    }
  }

  const dedupe = (list) => {
    const seen = new Set();
    return list.filter((item) => {
      const key = `${item.code}|${item.file || ""}|${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    hard: dedupe(hard),
    soft: dedupe(soft),
  };
}

function tableExists(db, tableName) {
  const row = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type IN ('table', 'view') AND name = ?`
    )
    .get(tableName);
  return Boolean(row?.name);
}

function loadSnapshotRow(db, args) {
  if (args.snapshotId) {
    return db
      .prepare(
        `SELECT id, project_id, summary, files_json, created_at
         FROM snapshots
         WHERE id = ?`
      )
      .get(args.snapshotId);
  }

  if (args.projectId) {
    const project = db
      .prepare(
        `SELECT current_snapshot_id
         FROM projects
         WHERE id = ?`
      )
      .get(args.projectId);
    if (project?.current_snapshot_id) {
      const snapshot = db
        .prepare(
          `SELECT id, project_id, summary, files_json, created_at
           FROM snapshots
           WHERE id = ?`
        )
        .get(project.current_snapshot_id);
      if (snapshot) return snapshot;
    }
    return db
      .prepare(
        `SELECT id, project_id, summary, files_json, created_at
         FROM snapshots
         WHERE project_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(args.projectId);
  }

  return db
    .prepare(
      `SELECT id, project_id, summary, files_json, created_at
       FROM snapshots
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get();
}

function formatIssue(issue) {
  return issue.file ? `${issue.file}: ${issue.message}` : issue.message;
}

function run() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.dbPath)) {
    const message = `DB not found: ${args.dbPath}`;
    if (args.allowEmpty) {
      console.log(`SKIP ${message}`);
      process.exit(0);
    }
    console.error(`FAIL ${message}`);
    process.exit(2);
  }

  const db = new Database(args.dbPath, { readonly: true });
  if (!tableExists(db, "snapshots")) {
    const message = `DB has no snapshots table: ${args.dbPath}`;
    if (args.allowEmpty) {
      console.log(`SKIP ${message}`);
      process.exit(0);
    }
    console.error(`FAIL ${message}`);
    process.exit(2);
  }

  const snapshot = loadSnapshotRow(db, args);
  if (!snapshot) {
    const message = "No snapshot found for the provided selector";
    if (args.allowEmpty) {
      console.log(`SKIP ${message}`);
      process.exit(0);
    }
    console.error(`FAIL ${message}`);
    process.exit(2);
  }

  const files = parseFilesJson(snapshot.files_json);
  const issues = collectIssues(files);
  const output = {
    snapshotId: snapshot.id,
    projectId: snapshot.project_id,
    summary: snapshot.summary,
    createdAt: snapshot.created_at,
    fileCount: files.length,
    hardCount: issues.hard.length,
    softCount: issues.soft.length,
    hard: issues.hard,
    soft: issues.soft,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log("Snapshot Validation Audit");
    console.log(`DB: ${args.dbPath}`);
    console.log(`Snapshot: ${snapshot.id}`);
    console.log(`Project: ${snapshot.project_id}`);
    console.log(`Files: ${files.length}`);
    console.log(`Hard blockers: ${issues.hard.length}`);
    console.log(`Soft blockers: ${issues.soft.length}`);
    if (issues.hard.length > 0) {
      console.log("\nHard blockers:");
      for (const issue of issues.hard.slice(0, 25)) {
        console.log(`- [${issue.code}] ${formatIssue(issue)}`);
      }
    }
    if (issues.soft.length > 0) {
      console.log("\nSoft blockers:");
      for (const issue of issues.soft.slice(0, 25)) {
        console.log(`- [${issue.code}] ${formatIssue(issue)}`);
      }
    }
  }

  if (issues.hard.length > 0 || (args.failOnSoft && issues.soft.length > 0)) {
    process.exit(1);
  }
}

run();
