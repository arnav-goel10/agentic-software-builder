import path from "node:path";
import { createHash } from "node:crypto";
import type { GeneratedFile } from "@/lib/server/types";
import type { FileContract, StructureLock } from "./orchestrator/types";

export type FileOperation =
  | {
    op: "upsert";
    path: string;
    code: string;
    language?: string;
  }
  | {
    op: "delete";
    path: string;
  }
  | {
    op: "json_manifest_update";
    path: string;
    merge: Record<string, unknown>;
  };

type ApplyOperationContext = {
  phase?: string;
  taskId?: string;
};

export type ValidationIssue = {
  code: string;
  message: string;
  file?: string;
  regionId?: string;
};

export type SkeletonValidationOptions = {
  routeOwnedPaths?: string[];
  enforceSignatureHeuristics?: boolean;
};

const SKELETON_FILL_REGION_START_PATTERN = /\/\/\s*BEGIN_FILL:[A-Za-z0-9_-]+/g;
const SKELETON_TODO_PATTERN = /\/\/\s*TODO:\s*FILL_IN/;
const SKELETON_EXECUTABLE_FILE_PATTERN = /\.(jsx?|tsx?)$/i;
const SKELETON_CODE_FILE_PATTERN = /\.(?:jsx?|tsx?|mjs|cjs)$/i;
const SKELETON_CONFIG_FILE_PATTERN =
  /(?:^|\/)(?:tailwind|postcss|vite)\.config\.(?:js|ts|mjs|cjs)$/i;
const SKELETON_FUNCTION_SIGNATURE_HINT_PATTERN =
  /\bfunction\b|=>|\([^\)]*\)\s*=>?|\b[A-Z][A-Za-z0-9_]*\s*\(/;
const IMPORT_SIDE_EFFECT_PATTERN = /import\s*["'`]([^"'`]+)["'`]/g;
const STYLE_IMPORT_SOURCE_PATTERN = /\.(?:css|scss|sass|less|styl|pcss)$/i;
const ROUTE_HANDLER_EXPORT_PATTERN =
  /\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/;
const ROUTE_NAMED_OWNERSHIP_PATTERN =
  /\bexport\s+(?:async\s+)?(?:const|let|var|function)\s+(?:loader|action|router|routes)\b/;

function isSkeletonExecutableFile(pathName: string): boolean {
  return SKELETON_EXECUTABLE_FILE_PATTERN.test(pathName);
}

function isSkeletonEntrypointFile(pathName: string): boolean {
  return /^(?:src\/)?(?:main|index)\.(?:jsx?|tsx?)$/i.test(pathName);
}

function isSkeletonCodeFile(pathName: string): boolean {
  return SKELETON_CODE_FILE_PATTERN.test(pathName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDefaultExportObjectKey(code: string, key: string): boolean {
  if (!/export\s+default\s*{/.test(code)) {
    return false;
  }
  const escaped = escapeRegExp(key);
  const keyPattern = new RegExp(`(?:['"\`]${escaped}['"\`]|${escaped})\\s*:`);
  return keyPattern.test(code);
}

function hasConfigDefaultExportKey(code: string, key: string): boolean {
  if (!/export\s+default\b/.test(code)) {
    return false;
  }
  const escaped = escapeRegExp(key);
  const keyPattern = new RegExp(`(?:['"\`]${escaped}['"\`]|${escaped})\\s*:`);
  return keyPattern.test(code);
}

function hasLiteralSourceReference(code: string, source: string): boolean {
  const escaped = escapeRegExp(source);
  return new RegExp(`["'\`]${escaped}["'\`]`).test(code);
}

function shouldRequireSkeletonFillMarkers(
  contract: FileContract,
  normalizedPath: string,
  code: string
): boolean {
  if (SKELETON_TODO_PATTERN.test(code)) {
    return true;
  }

  if (!isSkeletonExecutableFile(normalizedPath)) {
    return false;
  }

  // Entrypoints like src/main.jsx and src/index.jsx often only wire app bootstrapping
  // and may not contain function-body TODO regions.
  if (isSkeletonEntrypointFile(normalizedPath)) {
    return false;
  }

  return contract.exports.some((exp) => {
    if (exp.kind === "function" || exp.kind === "class") {
      return true;
    }
    if (exp.kind !== "default") {
      return false;
    }
    const signature = exp.signature.trim();
    if (!signature) {
      return true;
    }
    return SKELETON_FUNCTION_SIGNATURE_HINT_PATTERN.test(signature);
  });
}

type ParsedImportClause = {
  defaultImport: string | null;
  namedImports: Set<string>;
  namespaceImport: string | null;
};

function collectImportClausesBySource(code: string): Map<string, ParsedImportClause[]> {
  const clausesBySource = new Map<string, ParsedImportClause[]>();
  IMPORT_WITH_FROM_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_WITH_FROM_PATTERN.exec(code)) !== null) {
    const importClause = (match[1] ?? "").trim();
    const source = (match[2] ?? "").trim();
    if (!source) continue;

    const namespaceImportMatch = importClause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    const parsed: ParsedImportClause = {
      defaultImport: parseDefaultImportSpecifier(importClause),
      namedImports: new Set(parseNamedImportSpecifiers(importClause)),
      namespaceImport: namespaceImportMatch?.[1] ?? null,
    };
    const entries = clausesBySource.get(source) ?? [];
    entries.push(parsed);
    clausesBySource.set(source, entries);
  }

  IMPORT_SIDE_EFFECT_PATTERN.lastIndex = 0;
  while ((match = IMPORT_SIDE_EFFECT_PATTERN.exec(code)) !== null) {
    const source = (match[1] ?? "").trim();
    if (!source) continue;
    const entries = clausesBySource.get(source) ?? [];
    entries.push({
      defaultImport: null,
      namedImports: new Set<string>(),
      namespaceImport: null,
    });
    clausesBySource.set(source, entries);
  }

  return clausesBySource;
}

export function validateSkeletonWorkingTree(
  files: GeneratedFile[],
  contracts: FileContract[],
  options?: SkeletonValidationOptions
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fileMap = new Map(files.map((f) => [normalizePath(f.name), f]));
  const routeOwnedPaths = new Set(
    (options?.routeOwnedPaths ?? [])
      .map((rawPath) => {
        try {
          return normalizePath(rawPath);
        } catch {
          return null;
        }
      })
      .filter((rawPath): rawPath is string => Boolean(rawPath))
  );

  const resolveLocalImportTargets = (ownerPath: string, source: string): string[] => {
    const normalizedSource = source.trim();
    if (!normalizedSource) return [];
    if (!(normalizedSource.startsWith(".") || normalizedSource.startsWith("src/"))) {
      return [];
    }
    const ownerDir = path.posix.dirname(ownerPath);
    const withoutSrcPrefix = normalizedSource.startsWith("src/")
      ? normalizedSource.slice(4)
      : normalizedSource;
    const base = normalizedSource.startsWith(".")
      ? path.posix.normalize(path.posix.join(ownerDir, normalizedSource))
      : withoutSrcPrefix;
    const candidates = new Set<string>([
      normalizePath(base),
      normalizePath(`${base}.ts`),
      normalizePath(`${base}.tsx`),
      normalizePath(`${base}.js`),
      normalizePath(`${base}.jsx`),
      normalizePath(`${base}/index.ts`),
      normalizePath(`${base}/index.tsx`),
      normalizePath(`${base}/index.js`),
      normalizePath(`${base}/index.jsx`),
      normalizePath(base.startsWith("src/") ? base : `src/${base}`),
    ]);
    return Array.from(candidates);
  };

  for (const contract of contracts) {
    const normalizedContractPath = normalizePath(contract.path);
    const file = fileMap.get(normalizedContractPath);
    if (!file) {
      issues.push({
        code: "skeleton.missing_file",
        message: `Missing skeleton file for contract path ${normalizedContractPath}`,
        file: normalizedContractPath,
      });
      continue;
    }

    const code = file.code;
    const isCodeFile = isSkeletonCodeFile(normalizedContractPath);
    const isConfigFile = SKELETON_CONFIG_FILE_PATTERN.test(normalizedContractPath);
    const isEntrypointFile = isSkeletonEntrypointFile(normalizedContractPath);
    const fillRegionMatches = code.match(SKELETON_FILL_REGION_START_PATTERN) ?? [];
    if (
      fillRegionMatches.length === 0 &&
      shouldRequireSkeletonFillMarkers(contract, normalizedContractPath, code)
    ) {
      issues.push({
        code: "skeleton.missing_fill_marker",
        message: `File ${normalizedContractPath} has no BEGIN_FILL/END_FILL markers.`,
        file: normalizedContractPath,
      });
    }

    // Entrypoint files are intentionally lenient in skeleton phase because contract
    // generation frequently over-specifies exports for main/index bootstraps.
    if (isCodeFile && !isEntrypointFile) {
      const moduleExports = parseModuleExports(code);
      for (const exp of contract.exports) {
        const exportSatisfied =
          (exp.kind === "default"
            ? moduleExports.hasDefaultExport || moduleExports.names.has("default")
            : moduleExports.names.has(exp.name) ||
            (exp.kind === "type" &&
              new RegExp(`export\\s+(?:type|interface|enum)\\s+${escapeRegExp(exp.name)}\\b`).test(
                code
              ))) ||
          (isConfigFile &&
            exp.kind !== "default" &&
            (hasDefaultExportObjectKey(code, exp.name) || hasConfigDefaultExportKey(code, exp.name)));
        if (!exportSatisfied) {
          issues.push({
            code: "skeleton.missing_export",
            message: `File ${normalizedContractPath} is missing required export: ${exp.name}`,
            file: normalizedContractPath,
          });
          continue;
        }
        if (options?.enforceSignatureHeuristics) {
          const signatureFragment = exp.signature
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60);
          const shouldCheckSignature =
            exp.kind === "function" ||
            exp.kind === "class" ||
            (exp.kind === "default" &&
              SKELETON_FUNCTION_SIGNATURE_HINT_PATTERN.test(exp.signature));
          if (shouldCheckSignature && signatureFragment.length > 18 && !code.includes(signatureFragment)) {
            issues.push({
              code: "skeleton.signature_mismatch",
              message: `Export ${exp.name} in ${normalizedContractPath} does not appear to match contract signature.`,
              file: normalizedContractPath,
            });
          }
        }
      }
    }

    const importsBySource = collectImportClausesBySource(code);

    const findContractImportClauses = (source: string): ParsedImportClause[] => {
      const exact = importsBySource.get(source);
      if (exact && exact.length > 0) {
        return exact;
      }
      if (!(source.startsWith(".") || source.startsWith("src/"))) {
        return [];
      }
      const expectedTargets = new Set(
        resolveLocalImportTargets(normalizedContractPath, source)
      );
      if (expectedTargets.size === 0) {
        return [];
      }
      const matched: ParsedImportClause[] = [];
      for (const [actualSource, clauses] of importsBySource.entries()) {
        const actualTargets = resolveLocalImportTargets(
          normalizedContractPath,
          actualSource
        );
        if (actualTargets.some((target) => expectedTargets.has(target))) {
          matched.push(...clauses);
        }
      }
      return matched;
    };

    if (!isEntrypointFile) {
      for (const imp of contract.imports) {
        const isLocalSource = imp.source.startsWith(".") || imp.source.startsWith("src/");
        const configLiteralReferenceSatisfied =
          isConfigFile && !isLocalSource && hasLiteralSourceReference(code, imp.source);
        const clauses = findContractImportClauses(imp.source);
        if (clauses.length === 0) {
          if (configLiteralReferenceSatisfied) {
            continue;
          }
          issues.push({
            code: "skeleton.missing_import_source",
            message: `File ${normalizedContractPath} is missing import from ${imp.source}`,
            file: normalizedContractPath,
          });
          continue;
        }
        if (isConfigFile && !isLocalSource) {
          continue;
        }
        for (const name of imp.names) {
          const hasName =
            name === "default"
              ? STYLE_IMPORT_SOURCE_PATTERN.test(imp.source)
                ? clauses.length > 0
                : clauses.some((clause) => Boolean(clause.defaultImport))
              : name === "*"
                ? clauses.some((clause) => Boolean(clause.namespaceImport))
                : clauses.some(
                  (clause) => clause.namedImports.has(name) || clause.defaultImport === name
                );
          if (!hasName) {
            issues.push({
              code: "skeleton.missing_import_name",
              message: `File ${normalizedContractPath} import ${imp.source} missing symbol ${name}`,
              file: normalizedContractPath,
            });
          }
        }
      }
    }

    for (const importSource of importsBySource.keys()) {
      const localTargets = resolveLocalImportTargets(normalizedContractPath, importSource);
      if (localTargets.length === 0) continue;
      const resolved = localTargets.some((candidate) => fileMap.has(candidate));
      if (!resolved) {
        issues.push({
          code: "skeleton.unresolved_local_import",
          message: `File ${normalizedContractPath} has unresolved local import: ${importSource}`,
          file: normalizedContractPath,
        });
      }
    }

    const routeLikePath =
      !isSkeletonEntrypointFile(normalizedContractPath) &&
      (routeOwnedPaths.size > 0
        ? routeOwnedPaths.has(normalizedContractPath)
        : /(^|\/)(routes?|pages?)\//i.test(normalizedContractPath) ||
        /(^|\/)app\.(jsx|tsx|js|ts)$/i.test(normalizedContractPath));
    if (routeLikePath) {
      const hasRouteSignals =
        /export\s+default\b/.test(code) ||
        /\bcreateBrowserRouter\s*\(/.test(code) ||
        /<\s*Route\b/.test(code) ||
        ROUTE_HANDLER_EXPORT_PATTERN.test(code) ||
        ROUTE_NAMED_OWNERSHIP_PATTERN.test(code);
      if (!hasRouteSignals) {
        issues.push({
          code: "skeleton.route_contract_missing",
          message: `Route-like file ${normalizedContractPath} is missing route ownership structure.`,
          file: normalizedContractPath,
        });
      }
    }
  }

  return issues;
}

export function validateSkeletonConformance(
  files: GeneratedFile[],
  contracts: FileContract[],
  options?: SkeletonValidationOptions
): ValidationIssue[] {
  return validateSkeletonWorkingTree(files, contracts, options);
}

const FILL_REGION_BLOCK_PATTERN =
  /\/\/\s*BEGIN_FILL:\s*([A-Za-z0-9_-]+)[^\n]*\n([\s\S]*?)\/\/\s*END_FILL:\s*\1/g;

type FillRegionBlock = {
  id: string;
  fullText: string;
};

function extractFillRegionBlocks(code: string): FillRegionBlock[] {
  const regions: FillRegionBlock[] = [];
  for (const match of code.matchAll(FILL_REGION_BLOCK_PATTERN)) {
    const id = (match[1] ?? "").trim();
    const fullText = match[0] ?? "";
    if (!id || !fullText) continue;
    regions.push({ id, fullText });
  }
  return regions;
}

function stripFillRegionBodies(code: string): string {
  return code.replace(FILL_REGION_BLOCK_PATTERN, (_raw, id: string) => {
    return `// BEGIN_FILL:${id}\n// FILL_REGION\n// END_FILL:${id}`;
  });
}

function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildStructureLocks(files: GeneratedFile[]): StructureLock[] {
  return files
    .map((file) => {
      const pathName = normalizePath(file.name);
      const blocks = extractFillRegionBlocks(file.code);
      if (blocks.length === 0) {
        return null;
      }
      return {
        path: pathName,
        regionIds: blocks.map((block) => block.id).sort((left, right) =>
          left.localeCompare(right)
        ),
        templateHash: hashString(stripFillRegionBodies(file.code)),
      } satisfies StructureLock;
    })
    .filter((lock): lock is StructureLock => Boolean(lock));
}

function applyFillRegionsWithLock(
  baseCode: string,
  candidateCode: string
): { code: string; violations: ValidationIssue[] } {
  const violations: ValidationIssue[] = [];
  const baseBlocks = extractFillRegionBlocks(baseCode);
  const candidateBlocks = extractFillRegionBlocks(candidateCode);
  const candidateById = new Map(candidateBlocks.map((block) => [block.id, block]));
  let mergedCode = baseCode;

  for (const baseBlock of baseBlocks) {
    const candidate = candidateById.get(baseBlock.id);
    if (!candidate) {
      violations.push({
        code: "skeleton.fill_region_missing",
        message: `Filled output omitted required fill region ${baseBlock.id}.`,
        regionId: baseBlock.id,
      });
      continue;
    }
    mergedCode = mergedCode.replace(baseBlock.fullText, candidate.fullText);
  }

  const baseTemplate = stripFillRegionBodies(baseCode);
  const candidateTemplate = stripFillRegionBodies(candidateCode);
  if (baseTemplate !== candidateTemplate) {
    violations.push({
      code: "skeleton.fill_structure_changed",
      message:
        "Fill output modified structure outside BEGIN_FILL/END_FILL regions; enforcing locked structure.",
    });
  }

  return { code: mergedCode, violations };
}

export function enforceStructureLockedFillOperations(
  baseFiles: GeneratedFile[],
  operations: FileOperation[]
): { operations: FileOperation[]; violations: ValidationIssue[] } {
  const baseByPath = new Map(baseFiles.map((file) => [normalizePath(file.name), file]));
  const locks = new Map(buildStructureLocks(baseFiles).map((lock) => [lock.path, lock]));
  const nextOperations: FileOperation[] = [];
  const violations: ValidationIssue[] = [];

  for (const operation of operations) {
    if (operation.op !== "upsert" || !locks.has(normalizePath(operation.path))) {
      nextOperations.push(operation);
      continue;
    }
    const normalizedPath = normalizePath(operation.path);
    const baseFile = baseByPath.get(normalizedPath);
    if (!baseFile) {
      nextOperations.push(operation);
      continue;
    }
    const lock = locks.get(normalizedPath);
    if (!lock) {
      nextOperations.push(operation);
      continue;
    }

    const { code, violations: fileViolations } = applyFillRegionsWithLock(
      baseFile.code,
      operation.code
    );
    const candidateTemplateHash = hashString(stripFillRegionBodies(code));
    if (candidateTemplateHash !== lock.templateHash) {
      fileViolations.push({
        code: "skeleton.fill_template_hash_mismatch",
        message: `Structure lock hash mismatch for ${normalizedPath}.`,
        file: normalizedPath,
      });
    }
    for (const issue of fileViolations) {
      violations.push({ ...issue, file: normalizedPath });
    }
    nextOperations.push({
      op: "upsert",
      path: normalizedPath,
      code,
      language: operation.language,
    });
  }

  return { operations: nextOperations, violations };
}

const NON_BLOCKING_VALIDATION_CODES = new Set<string>([
  // Skeleton conformance issues are critical
  // "skeleton.missing_export", 
  "skeleton.route_contract_missing",
  "skeleton.missing_fill_marker",

  // UX policy issue: should be fixed, but does not by itself break build/runtime.
  "ui.native_dialog_api",
  // UX/navigation policy issue that does not directly break app boot.
  "router.internal_anchor",
  // JSX semantics/style rule that is not always fatal at runtime.
  "router.invalid_index_tag",
  // Style completeness issue; should be fixed but not a runtime blocker.
  "assets.missing_index_css",
  // Placeholder content is product-quality risk, not a runtime/build failure.
  "app.placeholder_starter_template",
  // Hook-shape quality guard: risky, but not guaranteed crash in every render path.
  "react.hook_in_conditional",
  "react.hook_in_loop",
  // React Query data-shape guards: correctness risks, but not definitive boot/build failures.
  "react_query.cache_shape_mismatch",
  "react_query.on_mutate_unsafe_previous_data",
  "react_query.unsafe_data_destructure",
  // SQL heuristics are best-effort safety checks, not deterministic compile/runtime failures.
  "sql.update_param_order_likely_wrong",
  // PGlite resilience checks improve robustness but are not always immediate blockers.
  "pglite.db_not_exported",
  "pglite.init_ctor_noncanonical",
  "pglite.init_in_ui_layer",
  "pglite.init_missing_singleflight",
  "pglite.missing_bundle_recovery",
  "pglite.multiple_initializers",
  "pglite.retry_missing_singleflight",
  "pglite.static_fallback_dir",
  "pglite.vite_config_missing",
  "pglite.vite_optimize_deps_missing",
]);

export function isBlockingValidationIssue(issue: ValidationIssue): boolean {
  return !NON_BLOCKING_VALIDATION_CODES.has(issue.code);
}

export type ValidationResult = {
  files: GeneratedFile[];
  issues: ValidationIssue[];
  runtimeDiagnostics: string[];
  importClassification: {
    serverOnlyImports: string[];
    browserCompatibleImports: string[];
  };
  previewRisk: PreviewRiskReport;
};

export type PreviewRiskMode = "local";

export type PreviewRiskReport = {
  mode: PreviewRiskMode;
  score: number;
  reasons: string[];
  blockers: string[];
};

const ROUTE_INDEX_TAG_PATTERN = /<\s*index\b/i;
const INTERNAL_ANCHOR_PATTERN =
  /<a\b[^>]*\bhref\s*=\s*(?:\{?\s*["'`](?:\/(?!\/)|\.\.?\/)[^"'`]*["'`]\s*\}?)[^>]*>/i;
const ROUTER_HOOK_PATTERN = /\buse(?:Navigate|Location|Params|SearchParams|Match)\b/;
const ROUTER_PROVIDER_PATTERN =
  /<\s*(BrowserRouter|Router|HashRouter|MemoryRouter|RouterProvider)\b|createBrowserRouter\s*\(/i;
const ROUTER_WRAPPER_TAG_PATTERN = /<\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\b/i;
const ROUTER_WRAPPER_CLOSE_TAG_SINGLE_PATTERN = /<\/\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\s*>/i;
const ROUTER_WRAPPER_OPEN_TAG_PATTERN = /<\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\b[^>]*>/gi;
const ROUTER_WRAPPER_CLOSE_TAG_PATTERN = /<\/\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\s*>/gi;
const ROUTER_PROVIDER_TAG_PATTERN = /<\s*RouterProvider\b/i;
const ROUTER_CREATOR_PATTERN = /\bcreateBrowserRouter\s*\(/i;
const USE_FRAME_CALL_PATTERN = /\buseFrame\s*\(/;
const R3F_IMPORT_NAMED_PATTERN =
  /import\s*{([^}]*)}\s*from\s*["'`]@react-three\/fiber["'`]/g;
const ROOT_APP_FILE_PATTERN = /^App\.(jsx|tsx|js|ts)$/;
const SRC_APP_FILE_PATTERN = /^src\/App\.(jsx|tsx|js|ts)$/;
const ROOT_MAIN_FILE_PATTERN = /^main\.(jsx|tsx|js|ts)$/;
const SRC_MAIN_FILE_PATTERN = /^src\/main\.(jsx|tsx|js|ts)$/;
const ROOT_INDEX_FILE_PATTERN = /^index\.(jsx|tsx|js|ts)$/;
const SRC_INDEX_FILE_PATTERN = /^src\/index\.(jsx|tsx|js|ts)$/;
const PROCESS_ENV_PATTERN = /\bprocess\s*\.\s*env\b/;
const NATIVE_DIALOG_PATTERN = /\b(?:window\.)?(?:alert|prompt|confirm)\s*\(/;
const CVA_CALL_PATTERN = /(?<![.\w$])cva\s*\(/;
const CVA_IMPORT_PATTERN =
  /import\s*{[^}]*\bcva\b[^}]*}\s*from\s*["'`]class-variance-authority["'`]|const\s*{[^}]*\bcva\b[^}]*}\s*=\s*require\(\s*["'`]class-variance-authority["'`]\s*\)/;
const CVA_LOCAL_DECL_PATTERN = /\b(?:function|const|let|var|class)\s+cva\b/;
const LOCK_MANAGER_PATTERN = /\bnavigator\s*\.\s*locks\b|\bLockManager\b/i;
const CROSS_ORIGIN_FETCH_PATTERN =
  /\bfetch\s*\(\s*["'`](https?:\/\/[^"'`]+)["'`]/gi;
const WEBSOCKET_PATTERN = /\bnew\s+WebSocket\s*\(/i;
const FIREBASE_AUTH_IMPORT_PATTERN = /firebase\/auth/i;
const IMPORT_SPECIFIER_PATTERN =
  /import\s+[^'"`]*?from\s*["'`]([^"'`]+)["'`]|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const POSTCSS_CONFIG_FILE_PATTERN = /^postcss\.config\.(js|ts|mjs|cjs)$/;
const CSS_FILE_PATTERN = /\.css$/i;
const TAILWIND_CSS_INVALID_DIRECTIVE_PATTERN = /@import\s+['"]tailwindcss['"]/i;
const TAILWIND_INVALID_APPLY_UTILITY_PATTERN =
  /\b(?:border-gradient-to-(?:r|l|t|b|tr|tl|br|bl)|border-from-[^\s;]+|border-via-[^\s;]+|border-to-[^\s;]+)\b/;
const SHADCN_SEMANTIC_UTILITY_PATTERN =
  /\b(?:border-border|bg-background|text-foreground|ring-ring|border-input|bg-card|text-card-foreground|bg-popover|text-popover-foreground|bg-muted|text-muted-foreground|bg-primary|text-primary-foreground|bg-secondary|text-secondary-foreground|bg-accent|text-accent-foreground|bg-destructive|text-destructive-foreground)\b/;
const CSS_CLASS_SELECTOR_PATTERN = /\.([A-Za-z_-][\w-]*)\s*(?:\{|,)/g;
const PGLITE_INIT_CALL_PATTERN = /\bnew\s+PGlite\s*\(/;
const PGLITE_DB_DECLARATION_PATTERN =
  /\b(?:const|let|var)\s+db\s*=\s*new\s+PGlite\s*\(/;
const PGLITE_EXPORTED_DB_DECLARATION_PATTERN =
  /\bexport\s+(?:const|let|var)\s+db\s*=\s*new\s+PGlite\s*\(/;
const PGLITE_EXPORTED_DB_NAMED_PATTERN = /\bexport\s*{\s*[^}]*\bdb\b[^}]*}/;
const PGLITE_UI_LAYER_FILE_PATTERN =
  /^(?:src\/)?(?:App|main|index)\.(?:js|jsx|ts|tsx)$|^(?:src\/)?(?:components|pages|hooks)\//i;
const VITE_CONFIG_FILE_PATTERN = /^vite\.config\.(js|ts|mjs|cjs)$/;
const SQL_CREATE_TABLE_IF_NOT_EXISTS_PATTERN =
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+((?:"[^"]+")|(?:`[^`]+`)|(?:[A-Za-z_][\w$]*))\s*\(([\s\S]*?)\)\s*;?/gi;
const SQL_COLUMN_CONSTRAINT_PATTERN =
  /^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i;
const SQL_TYPE_STOP_TOKENS = new Set([
  "PRIMARY",
  "NOT",
  "NULL",
  "DEFAULT",
  "UNIQUE",
  "CHECK",
  "REFERENCES",
  "CONSTRAINT",
  "COLLATE",
  "GENERATED",
  "AS",
]);
const IMPORT_WITH_FROM_PATTERN = /import\s+([\s\S]*?)\s+from\s*["'`]([^"'`]+)["'`]/g;
const EXPORT_NAMED_BLOCK_PATTERN = /export\s*{\s*([^}]+)\s*}(?:\s*from\s*["'`][^"'`]+["'`])?/g;
const EXPORT_DECLARATION_PATTERN =
  /export\s+(?:async\s+function|function|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_ALL_PATTERN = /export\s+\*\s+from\s*["'`][^"'`]+["'`]/;
const EXPORTED_QUERY_HOOK_PATTERN =
  /export\s+function\s+(use[A-Z]\w*)\s*\([^)]*\)\s*{[\s\S]{0,5000}?return\s+use(?:Query|Mutation|InfiniteQuery|SuspenseQuery)\s*\(/g;
const HOOK_DESTRUCTURE_PATTERN =
  /const\s*{\s*([^}]+)\s*}\s*=\s*(use[A-Z]\w*)\s*\([^)]*\)\s*;?/g;
const CANNOT_FIND_NAME_PATTERN = /Cannot find name ['"`]([A-Za-z_$][\w$]*)['"`]/i;
const REACT_QUERY_IMPORT_PATTERN = /@tanstack\/react-query/;
const REACT_QUERY_PROVIDER_PATTERN = /<\s*QueryClientProvider\b/;
const REACT_QUERY_CLIENT_INIT_PATTERN = /\bnew\s+QueryClient\s*\(/;
const REACT_QUERY_DIRECT_HOOK_PATTERN = /\buse(?:Query|Mutation|QueryClient|InfiniteQuery|SuspenseQuery)\s*\(/;
const REACT_ROOT_RENDER_PATTERN = /\bcreateRoot\s*\(|ReactDOM\s*\.\s*render\s*\(/;
const QUERY_PROVIDER_OPEN_TAG_PATTERN = /<\s*QueryClientProvider\b[^>]*>/gi;
const QUERY_PROVIDER_CLOSE_TAG_PATTERN = /<\/\s*QueryClientProvider\s*>/gi;
const PGLITE_QUERY_OBJECT_TEXT_VALUES_PATTERN =
  /\.query\s*\(\s*{\s*text\s*:\s*([\s\S]*?)\s*,\s*values\s*:\s*([\s\S]*?)\s*,?\s*}\s*\)/g;
const PGLITE_QUERY_OBJECT_VALUES_TEXT_PATTERN =
  /\.query\s*\(\s*{\s*values\s*:\s*([\s\S]*?)\s*,\s*text\s*:\s*([\s\S]*?)\s*,?\s*}\s*\)/g;
const PGLITE_QUERY_OBJECT_TEXT_ONLY_PATTERN =
  /\.query\s*\(\s*{\s*text\s*:\s*([\s\S]*?)\s*,?\s*}\s*\)/g;
// Generic (not table-specific) heuristic: a parameterized `UPDATE <table> ...
// WHERE id = ?` call whose bind-array looks like [id, value] instead of the
// [value, id] order the placeholders imply.
const SQL_UPDATE_ID_VALUE_PARAM_ORDER_PATTERN =
  /\b(?:db|database|conn|connection)\s*\.\s*(?:query|exec|run|execute)\s*\(\s*(["'`])\s*UPDATE\s+([A-Za-z_][\w$]*)[\s\S]{0,260}?WHERE[\s\S]{0,120}?id\s*=\s*\?\s*\1\s*,\s*\[\s*([A-Za-z_$][\w$.]*)\s*,\s*([A-Za-z_$][\w$.]*)\s*\]\s*\)/gi;
const QUERY_RESULT_FIELDS = new Set([
  "data",
  "error",
  "status",
  "fetchStatus",
  "refetch",
  "remove",
  "failureCount",
  "failureReason",
  "dataUpdatedAt",
  "errorUpdatedAt",
  "isError",
  "isFetched",
  "isFetchedAfterMount",
  "isFetching",
  "isInitialLoading",
  "isLoading",
  "isPending",
  "isPlaceholderData",
  "isRefetchError",
  "isRefetching",
  "isStale",
  "isSuccess",
]);

type DeterministicImportSpec = {
  source: string;
  kind: "named" | "default";
  importedName?: string;
};

const DETERMINISTIC_IDENTIFIER_IMPORTS: Record<string, DeterministicImportSpec> = {
  cva: { source: "class-variance-authority", kind: "named" },
  clsx: { source: "clsx", kind: "default" },
  twMerge: { source: "tailwind-merge", kind: "named" },
  PGlite: { source: "@electric-sql/pglite", kind: "named" },
  useState: { source: "react", kind: "named" },
  useEffect: { source: "react", kind: "named" },
  useMemo: { source: "react", kind: "named" },
  useCallback: { source: "react", kind: "named" },
  useRef: { source: "react", kind: "named" },
  useContext: { source: "react", kind: "named" },
  useReducer: { source: "react", kind: "named" },
  BrowserRouter: { source: "react-router-dom", kind: "named" },
  Routes: { source: "react-router-dom", kind: "named" },
  Route: { source: "react-router-dom", kind: "named" },
  Link: { source: "react-router-dom", kind: "named" },
  Navigate: { source: "react-router-dom", kind: "named" },
  useNavigate: { source: "react-router-dom", kind: "named" },
  useLocation: { source: "react-router-dom", kind: "named" },
  useParams: { source: "react-router-dom", kind: "named" },
  useSearchParams: { source: "react-router-dom", kind: "named" },
  QueryClient: { source: "@tanstack/react-query", kind: "named" },
  QueryClientProvider: { source: "@tanstack/react-query", kind: "named" },
  useQuery: { source: "@tanstack/react-query", kind: "named" },
  useMutation: { source: "@tanstack/react-query", kind: "named" },
  useQueryClient: { source: "@tanstack/react-query", kind: "named" },
};

const SERVER_ONLY_IMPORTS = new Set([
  "node:fs",
  "node:path",
  "node:os",
  "node:crypto",
  "node:child_process",
  "node:net",
  "node:tls",
  "node:http",
  "node:https",
  "fs",
  "path",
  "os",
  "crypto",
  "child_process",
  "net",
  "tls",
  "http",
  "https",
  "next/server",
  "express",
  "koa",
  "fastify",
]);

let typeScriptLoader:
  | Promise<typeof import("typescript") | null>
  | null = null;

export function normalizePath(rawName: string): string {
  const slashNormalized = rawName.replace(/\\+/g, "/");
  const withoutLeadingDot = slashNormalized.replace(/^\.\//, "");
  const compacted = withoutLeadingDot.replace(/\/+/g, "/").trim();

  if (!compacted) {
    throw new Error("File path cannot be empty");
  }

  if (compacted.startsWith("/") || compacted.startsWith("~")) {
    throw new Error(`File path must be workspace-relative: ${rawName}`);
  }

  const segments = compacted.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Invalid file path segment in: ${rawName}`);
    }
  }

  return compacted;
}

function classifyImports(files: GeneratedFile[]): ValidationResult["importClassification"] {
  const serverOnly = new Set<string>();
  const browserCompatible = new Set<string>();

  for (const file of files) {
    let match: RegExpExecArray | null;
    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
    while ((match = IMPORT_SPECIFIER_PATTERN.exec(file.code)) !== null) {
      const specifier = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!specifier) continue;
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
        continue;
      }

      if (SERVER_ONLY_IMPORTS.has(specifier)) {
        serverOnly.add(specifier);
      } else {
        browserCompatible.add(specifier);
      }
    }
  }

  return {
    serverOnlyImports: Array.from(serverOnly).sort(),
    browserCompatibleImports: Array.from(browserCompatible).sort(),
  };
}

function extractPackageName(specifier: string): string | null {
  if (!specifier) return null;
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    return null;
  }
  if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
    return null;
  }
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    return null;
  }

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  }

  const [name] = specifier.split("/");
  return name || null;
}

function validateDeclaredDependencies(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const packageFile = files.find((file) => file.name === "package.json");
  if (!packageFile) {
    issues.push({
      code: "deps.missing_package_json",
      file: "package.json",
      message:
        "Missing package.json. The project must declare dependencies for all third-party imports.",
    });
    return issues;
  }

  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(packageFile.code) as Record<string, unknown>;
  } catch {
    issues.push({
      code: "deps.invalid_package_json",
      file: "package.json",
      message: "Invalid package.json JSON syntax.",
    });
    return issues;
  }

  const dependencies = packageJson.dependencies;
  const devDependencies = packageJson.devDependencies;
  const declared = new Set<string>([
    ...Object.keys((dependencies as Record<string, unknown>) ?? {}),
    ...Object.keys((devDependencies as Record<string, unknown>) ?? {}),
  ]);

  const seen = new Set<string>();
  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }

    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_SPECIFIER_PATTERN.exec(file.code)) !== null) {
      const specifier = (match[1] ?? match[2] ?? match[3] ?? "").trim();
      if (!specifier) continue;
      if (SERVER_ONLY_IMPORTS.has(specifier)) continue;

      const packageName = extractPackageName(specifier);
      if (!packageName) continue;
      if (declared.has(packageName)) continue;

      const dedupeKey = `${file.name}:${packageName}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      issues.push({
        code: "deps.missing_declared_dependency",
        file: file.name,
        message: `Import "${specifier}" requires "${packageName}" to be declared in package.json dependencies/devDependencies.`,
      });
    }
  }

  return issues;
}

function validateTailwindPostcssCompatibility(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const packageFile = files.find((file) => file.name === "package.json");
  let declared = new Set<string>();

  if (packageFile) {
    try {
      const parsed = JSON.parse(packageFile.code) as Record<string, unknown>;
      declared = new Set<string>([
        ...Object.keys((parsed.dependencies as Record<string, unknown>) ?? {}),
        ...Object.keys((parsed.devDependencies as Record<string, unknown>) ?? {}),
      ]);
    } catch {
      // Dependency syntax issues are already reported by validateDeclaredDependencies.
    }
  }

  for (const file of files) {
    if (!POSTCSS_CONFIG_FILE_PATTERN.test(file.name)) {
      continue;
    }

    const lower = file.code.toLowerCase();
    const referencesTailwind = lower.includes("tailwindcss");
    const usesTailwindPostcss = lower.includes("@tailwindcss/postcss");

    if (usesTailwindPostcss) {
      issues.push({
        code: "tailwind.postcss_plugin_v4_unsafe",
        file: file.name,
        message:
          "Tailwind v4 (@tailwindcss/postcss) is unsupported in WebContainers. Use the \"tailwindcss\" plugin instead.",
      });
    }

    if (referencesTailwind && !usesTailwindPostcss && !declared.has("tailwindcss")) {
      issues.push({
        code: "tailwind.postcss_plugin_missing_dependency",
        file: file.name,
        message:
          "PostCSS config references \"tailwindcss\" but it is not declared in package.json dependencies/devDependencies.",
      });
    }
  }

  return issues;
}

function validateTailwindCssSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!CSS_FILE_PATTERN.test(file.name)) {
      continue;
    }

    if (TAILWIND_CSS_INVALID_DIRECTIVE_PATTERN.test(file.code)) {
      issues.push({
        code: "tailwind.css_invalid_directive",
        file: file.name,
        message:
          "Invalid CSS directive '@import \"tailwindcss\";' found. Tailwind v4 is unsupported in WebContainers. Use `@tailwind base; @tailwind components; @tailwind utilities;` instead.",
      });
    }

    const declaredClassNames = new Set<string>();
    for (const selectorMatch of file.code.matchAll(CSS_CLASS_SELECTOR_PATTERN)) {
      const className = selectorMatch[1]?.trim();
      if (className) {
        declaredClassNames.add(className);
      }
    }

    const applyLines = file.code.split("\n");
    for (const line of applyLines) {
      if (!line.includes("@apply")) {
        continue;
      }
      if (TAILWIND_INVALID_APPLY_UTILITY_PATTERN.test(line)) {
        issues.push({
          code: "tailwind.css_invalid_apply_utility",
          file: file.name,
          message:
            "Found invalid gradient utility in `@apply` (e.g. border-gradient-to-r / border-from-* / border-to-*). Use bg-gradient-to-* with from-*/via-*/to-* tokens instead.",
        });
        break;
      }
      if (!SHADCN_SEMANTIC_UTILITY_PATTERN.test(line)) {
        continue;
      }
      issues.push({
        code: "tailwind.css_apply_semantic_token",
        file: file.name,
        message:
          "Found shadcn-style semantic utility in `@apply` (e.g. border-border/bg-background). Use concrete Tailwind utilities (for example border-slate-700, bg-slate-950, text-slate-100) unless full semantic theme tokens are explicitly configured.",
      });
      break;
    }

    if (declaredClassNames.size === 0) {
      continue;
    }

    let foundCustomApplyClass = false;
    for (const line of applyLines) {
      if (!line.includes("@apply")) {
        continue;
      }
      const applyMatch = line.match(/@apply\s+([^;]+)/);
      if (!applyMatch) {
        continue;
      }
      const applyTokens = applyMatch[1]
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      for (const token of applyTokens) {
        const normalizedToken = token.replace(/^!+/, "").split(":").pop()?.trim() ?? "";
        if (!normalizedToken || !normalizedToken.includes("-")) {
          continue;
        }
        if (!declaredClassNames.has(normalizedToken)) {
          continue;
        }
        issues.push({
          code: "tailwind.css_apply_custom_class",
          file: file.name,
          message:
            `Found custom class \`${normalizedToken}\` used inside \`@apply\`. Tailwind \`@apply\` accepts utility classes only; move reusable styles into regular CSS selectors or replace with concrete utility tokens.`,
        });
        foundCustomApplyClass = true;
        break;
      }
      if (foundCustomApplyClass) {
        break;
      }
    }
  }

  return issues;
}

function validatePgliteResilience(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scriptFiles = files.filter((file) => /\.(js|jsx|ts|tsx)$/.test(file.name));
  const usesPglite = scriptFiles.some(
    (file) =>
      /@electric-sql\/pglite/.test(file.code) ||
      PGLITE_INIT_CALL_PATTERN.test(file.code) ||
      /idb:\/\//i.test(file.code)
  );
  if (usesPglite) {
    const viteConfigs = files.filter((file) => VITE_CONFIG_FILE_PATTERN.test(normalizePath(file.name)));
    if (viteConfigs.length === 0) {
      issues.push({
        code: "pglite.vite_config_missing",
        message:
          "PGlite is used but vite.config is missing. Add Vite config with optimizeDeps.exclude for @electric-sql/pglite.",
      });
    } else {
      const hasRequiredOptimizeExclude = viteConfigs.some((file) =>
        /optimizeDeps\s*:\s*{[\s\S]*exclude\s*:\s*\[[^\]]*@electric-sql\/pglite[^\]]*\]/i.test(
          file.code
        )
      );
      if (!hasRequiredOptimizeExclude) {
        issues.push({
          code: "pglite.vite_optimize_deps_missing",
          file: normalizePath(viteConfigs[0]?.name ?? "vite.config.js"),
          message:
            "Vite config is missing `optimizeDeps.exclude: [\"@electric-sql/pglite\"]`. PGlite docs require excluding this package from optimizeDeps to avoid prebundle/runtime init corruption errors.",
        });
      }
    }
  }

  const pgliteInitFiles = scriptFiles
    .filter((file) => PGLITE_INIT_CALL_PATTERN.test(file.code))
    .map((file) => normalizePath(file.name));

  const pickCanonicalModulePath = (): string | null => {
    if (pgliteInitFiles.length === 0) return null;
    const sorted = [...pgliteInitFiles].sort((left, right) => left.localeCompare(right));
    const preferred = sorted.find((name) =>
      /^(?:src\/)?lib\/db\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(name)
    );
    return preferred ?? sorted[0] ?? null;
  };

  const canonicalModulePath = pickCanonicalModulePath();
  if (canonicalModulePath) {
    const canonicalFile = scriptFiles.find((file) => normalizePath(file.name) === canonicalModulePath);
    if (
      canonicalFile &&
      PGLITE_INIT_CALL_PATTERN.test(canonicalFile.code) &&
      PGLITE_DB_DECLARATION_PATTERN.test(canonicalFile.code) &&
      !PGLITE_EXPORTED_DB_DECLARATION_PATTERN.test(canonicalFile.code) &&
      !PGLITE_EXPORTED_DB_NAMED_PATTERN.test(canonicalFile.code)
    ) {
      issues.push({
        code: "pglite.db_not_exported",
        file: canonicalModulePath,
        message:
          "Canonical DB module initializes PGlite but does not export `db`. Export `db` from that module so other files can import shared state instead of initializing duplicate DB instances.",
      });
    }
  }

  if (pgliteInitFiles.length > 1) {
    issues.push({
      code: "pglite.multiple_initializers",
      message:
        `Found multiple PGlite initializers (${pgliteInitFiles.join(", ")}). ` +
        "Use exactly one dedicated DB module (for example src/lib/db.js) and import that module everywhere else to avoid idb:// bundle corruption or false init failures.",
    });
  }

  const uiLayerInitFiles = pgliteInitFiles.filter((name) => PGLITE_UI_LAYER_FILE_PATTERN.test(name));
  if (uiLayerInitFiles.length > 0) {
    issues.push({
      code: "pglite.init_in_ui_layer",
      file: uiLayerInitFiles[0],
      message:
        `PGlite initializer found in UI layer (${uiLayerInitFiles.join(", ")}). ` +
        "Move DB initialization to a single dedicated module (for example src/lib/db.js) and call exported functions from UI code.",
    });
  }

  for (const file of scriptFiles) {
    const code = file.code;
    const hasDefaultPgliteImport =
      /import\s+[A-Za-z_$][\w$]*(?:\s*,\s*{[^}]*})?\s+from\s*["'`]@electric-sql\/pglite["'`]/.test(
        code
      );
    if (hasDefaultPgliteImport) {
      issues.push({
        code: "pglite.invalid_default_import",
        file: file.name,
        message:
          "@electric-sql/pglite does not provide a default export. Use a named import: `import { PGlite } from \"@electric-sql/pglite\"`.",
      });
    }

    if (!PGLITE_INIT_CALL_PATTERN.test(code) || !/idb:\/\//i.test(code)) {
      continue;
    }

    const hasDirectIdbCtor = /\bnew\s+PGlite\s*\(\s*['"`]idb:\/\//i.test(code);
    const hasVariableCtor = /\bnew\s+PGlite\s*\(\s*[A-Za-z_$][\w$]*\s*\)/.test(code);
    const hasIdbLiteralInFile = /['"`]idb:\/\//i.test(code);
    const hasCompatibleCtor = hasDirectIdbCtor || (hasVariableCtor && hasIdbLiteralInFile);

    if (!hasCompatibleCtor) {
      issues.push({
        code: "pglite.init_ctor_noncanonical",
        file: file.name,
        message:
          "PGlite init should pass an idb:// dataDir to constructor (direct literal or variable resolved from idb://) for WebContainer compatibility.",
      });
    }

    const hasBundleRecovery =
      /invalid fs bundle size/i.test(code) ||
      /fs bundle/i.test(code);

    if (!hasBundleRecovery) {
      issues.push({
        code: "pglite.missing_bundle_recovery",
        file: file.name,
        message:
          "PGlite init with idb:// persistence is missing recovery for corrupted FS bundle errors (e.g. \"Invalid FS bundle size\").",
      });
    }

    const hasStaticFallbackDir = /idb:\/\/[A-Za-z0-9_-]*(?:fallback|recovery)[A-Za-z0-9_-]*/i.test(code);
    const hasDynamicFallbackEvidence =
      /recoveryAttempt|retryCount|attempt|Date\.now\s*\(|Math\.random\s*\(|randomUUID\s*\(/i.test(code);
    if (hasBundleRecovery && hasStaticFallbackDir && !hasDynamicFallbackEvidence) {
      issues.push({
        code: "pglite.static_fallback_dir",
        file: file.name,
        message:
          "PGlite recovery appears to use a static fallback idb:// dataDir. Use a unique fallback directory per retry attempt (for example include retry counter and/or Date.now()) to avoid repeated bundle-corruption reuse.",
      });
    }

    const hasSingleFlightInit =
      /\b(initPromise|dbPromise|dbInitPromise|initializingPromise)\b/.test(code) ||
      /if\s*\(\s*![A-Za-z_$][\w$]*Promise\s*\)\s*{[\s\S]*=\s*.*async/i.test(code);
    if (!hasSingleFlightInit) {
      issues.push({
        code: "pglite.init_missing_singleflight",
        file: file.name,
        message:
          "PGlite init path should use a shared single-flight promise/lock to prevent parallel initialization races (common in React StrictMode and concurrent hook usage).",
      });
    }

    const hasRetryUi =
      /retry initialization|handleRetry|onRetry|retryInitialization|retryInit/i.test(code) ||
      /\b<button\b[^>]*>\s*retry/i.test(code) ||
      /onClick\s*=\s*\{[^}]*retry/i.test(code);
    const hasRetryLock = /isRetrying|retryInFlight|retrying|retryLocked|retryPending/i.test(code);
    if (hasRetryUi && !hasRetryLock) {
      issues.push({
        code: "pglite.retry_missing_singleflight",
        file: file.name,
        message:
          "Database retry flow should be single-flight (disable retry while in progress) to avoid rapid retry loops and UI lag.",
      });
    }

    if (/^[ \t]+export\s+(?:const|let|var)\s+db\s*=\s*new\s+PGlite\s*\(/m.test(code)) {
      issues.push({
        code: "pglite.invalid_nested_export",
        file: file.name,
        message:
          "Detected `export const db = new PGlite(...)` inside a nested block. Export statements must be top-level; use `export let db` at module scope and assign `db = new PGlite(...)` inside init.",
      });
    }

    if (/\.waitReady\s*\(\s*\)/.test(code)) {
      issues.push({
        code: "pglite.wait_ready_invocation_invalid",
        file: file.name,
        message:
          "Detected `dbInstance.waitReady()` call. PGlite exposes `waitReady` as a promise property; use `await dbInstance.waitReady` (no parentheses).",
      });
    }

    const parsedSchemas = extractPgliteCreateTableSchemas(code);
    if (parsedSchemas.length > 0 && !hasPgliteColumnMigrationGuard(code)) {
      issues.push({
        code: "pglite.missing_column_migration_guard",
        file: file.name,
        message:
          "PGlite schema uses CREATE TABLE IF NOT EXISTS without column migration guards. Persisted idb:// databases do not auto-add new columns; query information_schema.columns + ALTER TABLE ADD COLUMN migration logic in init.",
      });
    }
  }

  return issues;
}

function normalizePgliteQueryObjectSignature(code: string): string {
  let next = code;
  next = next.replace(
    PGLITE_QUERY_OBJECT_TEXT_VALUES_PATTERN,
    (_full, textExpr: string, valuesExpr: string) => `.query(${textExpr.trim()}, ${valuesExpr.trim()})`
  );
  next = next.replace(
    PGLITE_QUERY_OBJECT_VALUES_TEXT_PATTERN,
    (_full, valuesExpr: string, textExpr: string) => `.query(${textExpr.trim()}, ${valuesExpr.trim()})`
  );
  next = next.replace(
    PGLITE_QUERY_OBJECT_TEXT_ONLY_PATTERN,
    (_full, textExpr: string) => `.query(${textExpr.trim()})`
  );
  return next;
}

function normalizePgliteWaitReadyInvocation(code: string): string {
  return code.replace(/\.waitReady\s*\(\s*\)/g, ".waitReady");
}

function validatePgliteQuerySignatures(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }
    if (!/\b(?:db|database|conn|connection)\s*\.\s*query\s*\(\s*{/.test(file.code)) {
      continue;
    }
    issues.push({
      code: "pglite.query_object_signature_unsupported",
      file: file.name,
      message:
        "Detected object-style db.query({ text, values }) call. PGlite expects db.query(sql, params?) with SQL string first; object query signatures can throw runtime charCodeAt errors.",
    });
  }
  return issues;
}

function validatePgliteQueryResultShape(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scriptFiles = files.filter((file) => /\.(js|jsx|ts|tsx)$/.test(file.name));
  const usesPglite = scriptFiles.some(
    (file) =>
      /@electric-sql\/pglite/.test(file.code) ||
      PGLITE_INIT_CALL_PATTERN.test(file.code) ||
      /idb:\/\//i.test(file.code)
  );
  if (!usesPglite) return issues;

  for (const file of scriptFiles) {
    if (!looksLikeCodeFile(file.name) || !/\bquery\s*\(/.test(file.code)) {
      continue;
    }

    const queryAssignmentPattern =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?query\s*\(/g;
    let assignmentMatch: RegExpExecArray | null;
    let flagged = false;
    while ((assignmentMatch = queryAssignmentPattern.exec(file.code)) !== null) {
      const resultVar = assignmentMatch[1];
      if (!resultVar) continue;

      const hasDirectReturn = new RegExp(`\\breturn\\s+${resultVar}\\s*(?:;|\\|\\|\\s*\\[\\s*\\]\\s*;)`).test(
        file.code
      );
      const hasArrayMethodUsage = new RegExp(
        `\\b${resultVar}\\s*\\.\\s*(?:map|filter|reduce|forEach|find|some|every|flatMap)\\s*\\(`
      ).test(file.code);
      const hasSpreadUsage = new RegExp(`\\[\\s*\\.\\.\\.\\s*${resultVar}\\s*\\]`).test(file.code);
      const hasForOfUsage = new RegExp(
        `for\\s*\\(\\s*(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s+of\\s+${resultVar}\\s*\\)`
      ).test(file.code);
      const hasUnsafeArrayAssumption =
        hasDirectReturn || hasArrayMethodUsage || hasSpreadUsage || hasForOfUsage;
      if (!hasUnsafeArrayAssumption) continue;

      const hasShapeNormalization =
        new RegExp(`\\b${resultVar}\\s*\\.\\s*rows\\b`).test(file.code) ||
        new RegExp(`Array\\.isArray\\s*\\(\\s*${resultVar}\\s*\\)`).test(file.code);
      if (hasShapeNormalization) {
        continue;
      }

      issues.push({
        code: "pglite.query_result_shape_unsafe",
        file: file.name,
        message:
          `PGlite query result \`${resultVar}\` is consumed with array assumptions without normalization. ` +
          "Normalize query output to an array first (for example `const rows = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : []`) before returning or iterating.",
      });
      flagged = true;
      break;
    }

    if (flagged) {
      continue;
    }
  }

  return issues;
}

function validatePgliteSqlDialect(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scriptFiles = files.filter((file) => /\.(js|jsx|ts|tsx)$/.test(file.name));
  const usesPglite = scriptFiles.some(
    (file) =>
      /@electric-sql\/pglite/.test(file.code) ||
      PGLITE_INIT_CALL_PATTERN.test(file.code) ||
      /idb:\/\//i.test(file.code)
  );
  if (!usesPglite) return issues;

  const sqliteDialectPatterns: Array<{
    pattern: RegExp;
    code: string;
    message: string;
  }> = [
      {
        pattern: /\bAUTOINCREMENT\b/i,
        code: "pglite.sqlite_autoincrement",
        message:
          "Detected SQLite-only AUTOINCREMENT keyword. PGlite uses PostgreSQL syntax; use SERIAL or BIGSERIAL for auto-incrementing primary keys.",
      },
      {
        pattern: /\bPRAGMA\s+\w/i,
        code: "pglite.sqlite_pragma",
        message:
          "Detected SQLite-only PRAGMA statement. PGlite uses PostgreSQL; use information_schema.columns for table introspection.",
      },
      {
        pattern: /\bdatetime\s*\(\s*['"`]now['"`]\s*\)/i,
        code: "pglite.sqlite_datetime_now",
        message:
          "Detected SQLite-only datetime('now') function. PGlite uses PostgreSQL; use NOW() or CURRENT_TIMESTAMP instead.",
      },
      {
        pattern: /\bGLOB\s+['"`]/i,
        code: "pglite.sqlite_glob",
        message:
          "Detected SQLite-only GLOB operator. PGlite uses PostgreSQL; use LIKE or regex ~ operator instead.",
      },
    ];

  for (const file of scriptFiles) {
    for (const check of sqliteDialectPatterns) {
      if (check.pattern.test(file.code)) {
        issues.push({
          code: check.code,
          file: file.name,
          message: check.message,
        });
      }
    }
  }

  return issues;
}

function validatePglitePlaceholderStyle(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const scriptFiles = files.filter((file) => /\.(js|jsx|ts|tsx)$/.test(file.name));
  const usesPglite = scriptFiles.some(
    (file) =>
      /@electric-sql\/pglite/.test(file.code) ||
      PGLITE_INIT_CALL_PATTERN.test(file.code) ||
      /idb:\/\//i.test(file.code)
  );
  if (!usesPglite) return issues;

  for (const file of scriptFiles) {
    if (!looksLikeCodeFile(file.name) || !/\bquery\s*\(/.test(file.code)) {
      continue;
    }

    const queryLiteralPattern = /\.query\s*\(\s*([`'"])([\s\S]*?)\1\s*,\s*\[/g;
    let queryMatch: RegExpExecArray | null;
    while ((queryMatch = queryLiteralPattern.exec(file.code)) !== null) {
      const sql = queryMatch[2] ?? "";
      if (!/\b(select|insert|update|delete|create|alter|drop)\b/i.test(sql)) {
        continue;
      }
      if (!/\?/.test(sql)) {
        continue;
      }
      issues.push({
        code: "pglite.sql_placeholder_style",
        file: file.name,
        message:
          "Detected SQLite-style `?` placeholders in a PGlite query. Use PostgreSQL numbered placeholders (`$1`, `$2`, ...) for parameterized SQL.",
      });
      break;
    }
  }

  return issues;
}

function collectCrossOriginFetchUrls(files: GeneratedFile[]): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    CROSS_ORIGIN_FETCH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CROSS_ORIGIN_FETCH_PATTERN.exec(file.code)) !== null) {
      const url = match[1]?.trim();
      if (url) {
        urls.add(url);
      }
    }
  }
  return Array.from(urls).sort();
}

export function analyzePreviewRisk(input: {
  files: GeneratedFile[];
  importClassification: ValidationResult["importClassification"];
}): PreviewRiskReport {
  let score = 0;
  const reasons: string[] = [];
  const blockers: string[] = [];
  const fileBlob = input.files.map((file) => file.code).join("\n");

  if (LOCK_MANAGER_PATTERN.test(fileBlob)) {
    score += 45;
    blockers.push("Uses Web Locks API, which is commonly denied in iframe sandbox previews.");
  }

  if (WEBSOCKET_PATTERN.test(fileBlob)) {
    score += 15;
    reasons.push("Opens direct WebSocket connections that may fail in strict preview/network contexts.");
  }

  const browserImports = input.importClassification.browserCompatibleImports;
  // PGlite runs locally — no preview risk from Supabase imports
  // (kept for reference if BYOK Supabase is re-added later)

  if (browserImports.some((specifier) => FIREBASE_AUTH_IMPORT_PATTERN.test(specifier))) {
    score += 15;
    reasons.push("Uses Firebase Auth flows that may be unreliable in srcdoc iframes.");
  }

  const fetchUrls = collectCrossOriginFetchUrls(input.files);
  if (fetchUrls.length > 0) {
    score += 18;
    reasons.push("Performs direct cross-origin fetches that can hit CORS/rate-limit restrictions in preview.");
  }

  if (input.importClassification.serverOnlyImports.length > 0) {
    score += 30;
    blockers.push(
      `Contains server-only imports: ${input.importClassification.serverOnlyImports.join(", ")}.`
    );
  }

  const cappedScore = Math.min(100, score);
  const mode: PreviewRiskMode = "local";

  return {
    mode,
    score: cappedScore,
    reasons,
    blockers,
  };
}

function isRuntimeEntrypoint(fileName: string): boolean {
  return (
    ROOT_APP_FILE_PATTERN.test(fileName) ||
    SRC_APP_FILE_PATTERN.test(fileName) ||
    ROOT_MAIN_FILE_PATTERN.test(fileName) ||
    SRC_MAIN_FILE_PATTERN.test(fileName) ||
    ROOT_INDEX_FILE_PATTERN.test(fileName) ||
    SRC_INDEX_FILE_PATTERN.test(fileName)
  );
}

function validateRouteSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const hookFiles: string[] = [];
  const hookEntrypointFiles: string[] = [];
  const providerFiles: string[] = [];
  let hasRouterProvider = false;

  for (const file of files) {
    if (ROUTER_PROVIDER_PATTERN.test(file.code)) {
      hasRouterProvider = true;
      providerFiles.push(file.name);
    }

    if (ROUTER_HOOK_PATTERN.test(file.code)) {
      hookFiles.push(file.name);
      if (isRuntimeEntrypoint(file.name)) {
        hookEntrypointFiles.push(file.name);
      }
    }

    if (ROUTE_INDEX_TAG_PATTERN.test(file.code)) {
      issues.push({
        code: "router.invalid_index_tag",
        file: file.name,
        message:
          "Invalid React Router syntax: found <index .../>. Use <Route index element={...} />.",
      });
    }

    if (INTERNAL_ANCHOR_PATTERN.test(file.code)) {
      issues.push({
        code: "router.internal_anchor",
        file: file.name,
        message:
          "Internal navigation uses <a href=...>. Use a router navigation component instead.",
      });
    }
  }

  if (providerFiles.length > 1) {
    const sorted = [...providerFiles].sort((left, right) => left.localeCompare(right));
    issues.push({
      code: "router.multiple_providers",
      file: sorted[0],
      message: `Multiple Router providers detected (${sorted.join(", ")}). Keep exactly one top-level Router provider in the app.`,
    });
  }

  return issues;
}

function hasNamedR3FImport(fileCode: string, symbol: string): boolean {
  R3F_IMPORT_NAMED_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = R3F_IMPORT_NAMED_PATTERN.exec(fileCode)) !== null) {
    const imports = match[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/i)[0])
      .filter(Boolean);
    if (imports.includes(symbol)) {
      return true;
    }
  }
  return false;
}

function validateReactThreeFiberSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!USE_FRAME_CALL_PATTERN.test(file.code)) {
      continue;
    }

    const hasUseFrameImport = hasNamedR3FImport(file.code, "useFrame");
    if (!hasUseFrameImport) {
      issues.push({
        code: "r3f.missing_useframe_import",
        file: file.name,
        message:
          "useFrame() is used without importing it from @react-three/fiber. Add `import { useFrame } from \"@react-three/fiber\"`.",
      });
    }
  }

  return issues;
}

function isBrowserSourceFile(fileName: string): boolean {
  if (ROOT_APP_FILE_PATTERN.test(fileName)) return true;
  if (SRC_APP_FILE_PATTERN.test(fileName)) return true;
  if (ROOT_MAIN_FILE_PATTERN.test(fileName)) return true;
  if (SRC_MAIN_FILE_PATTERN.test(fileName)) return true;
  if (ROOT_INDEX_FILE_PATTERN.test(fileName)) return true;
  if (SRC_INDEX_FILE_PATTERN.test(fileName)) return true;
  if (/^src\/.+\.(js|jsx|ts|tsx)$/.test(fileName)) return true;
  return false;
}

const ITERATOR_METHOD_NAMES = new Set([
  "map",
  "forEach",
  "filter",
  "reduce",
  "some",
  "every",
  "find",
  "flatMap",
]);

type HookScanContext = {
  inLoop: boolean;
  inConditional: boolean;
};

function resolveTypeScriptScriptKind(
  ts: typeof import("typescript"),
  fileName: string
): import("typescript").ScriptKind {
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (normalized.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (normalized.endsWith(".ts") || normalized.endsWith(".mts") || normalized.endsWith(".cts")) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}

function isHookCallExpression(
  ts: typeof import("typescript"),
  node: import("typescript").CallExpression
): boolean {
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return /^use[A-Z0-9_]/.test(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return /^use[A-Z0-9_]/.test(expression.name.text);
  }
  return false;
}

function nodeContainsHookCall(
  ts: typeof import("typescript"),
  node: import("typescript").Node
): boolean {
  let found = false;
  const visit = (current: import("typescript").Node): void => {
    if (found) return;
    if (ts.isCallExpression(current) && isHookCallExpression(ts, current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function callExpressionContainsIteratorHookUse(
  ts: typeof import("typescript"),
  node: import("typescript").CallExpression
): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }
  const methodName = node.expression.name.text;
  if (!ITERATOR_METHOD_NAMES.has(methodName)) {
    return false;
  }
  return node.arguments.some((arg) => {
    if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
      return nodeContainsHookCall(ts, arg.body);
    }
    return false;
  });
}

function scanHookViolationsInFile(
  ts: typeof import("typescript"),
  fileName: string,
  code: string
): { loopViolation: boolean; conditionalViolation: boolean } {
  const source = ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    resolveTypeScriptScriptKind(ts, fileName)
  );
  const result = {
    loopViolation: false,
    conditionalViolation: false,
  };

  const visit = (node: import("typescript").Node, context: HookScanContext): void => {
    if (result.loopViolation && result.conditionalViolation) {
      return;
    }

    if (ts.isCallExpression(node)) {
      if (isHookCallExpression(ts, node)) {
        if (context.inLoop) {
          result.loopViolation = true;
        }
        if (context.inConditional) {
          result.conditionalViolation = true;
        }
      } else if (callExpressionContainsIteratorHookUse(ts, node)) {
        result.loopViolation = true;
      }
    }

    const nextContext: HookScanContext = {
      inLoop:
        context.inLoop ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node),
      inConditional:
        context.inConditional ||
        ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isSwitchStatement(node) ||
        ts.isCaseClause(node) ||
        ts.isDefaultClause(node) ||
        ts.isCatchClause(node),
    };

    ts.forEachChild(node, (child) => visit(child, nextContext));
  };

  visit(source, { inLoop: false, inConditional: false });
  return result;
}

async function validateReactHookRules(files: GeneratedFile[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const ts = await getTypeScript();
  const fallbackHookInBlockPattern =
    /\.(map|forEach|filter|reduce)\s*\(\s*(?:[^=>]*=>\s*{?|function\s*[^)]*\)\s*{?)(?:[^{}]*{[^{}]*})*[^}]*\buse[A-Z]\w*\b/;
  const fallbackHookInIfPattern = /\bif\s*\([^)]*\)\s*{[^{}]*\buse[A-Z]\w*\b/g;

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) continue;

    if (!ts) {
      if (fallbackHookInBlockPattern.test(file.code)) {
        issues.push({
          code: "react.hook_in_loop",
          file: file.name,
          message: "React Hook violation: Hook called inside a loop/iterator (.map, .forEach, etc). Hooks must be called at the top level of the component.",
        });
      } else if (fallbackHookInIfPattern.test(file.code)) {
        issues.push({
          code: "react.hook_in_conditional",
          file: file.name,
          message: "React Hook violation: Hook called inside a conditional block. Hooks must be called at the top level of the component and consistently across every render.",
        });
      }
      continue;
    }

    const scan = scanHookViolationsInFile(ts, file.name, file.code);
    if (scan.loopViolation) {
      issues.push({
        code: "react.hook_in_loop",
        file: file.name,
        message: "React Hook violation: Hook called inside a loop/iterator (.map, .forEach, etc). Hooks must be called at the top level of the component.",
      });
    }
    if (scan.conditionalViolation) {
      issues.push({
        code: "react.hook_in_conditional",
        file: file.name,
        message: "React Hook violation: Hook called inside a conditional block. Hooks must be called at the top level of the component and consistently across every render.",
      });
    }
  }
  return issues;
}

function collectExportedQueryHookNames(files: GeneratedFile[]): Set<string> {
  const queryHookNames = new Set<string>();
  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }
    EXPORTED_QUERY_HOOK_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EXPORTED_QUERY_HOOK_PATTERN.exec(file.code)) !== null) {
      const hookName = match[1]?.trim();
      if (hookName) {
        queryHookNames.add(hookName);
      }
    }
  }
  return queryHookNames;
}

function scoreReactQueryProviderOwner(file: GeneratedFile): number {
  const fileName = normalizePath(file.name);
  let score = 0;
  if (isRuntimeEntrypoint(fileName)) score += 100;
  if (REACT_ROOT_RENDER_PATTERN.test(file.code)) score += 80;
  if (SRC_MAIN_FILE_PATTERN.test(fileName) || ROOT_MAIN_FILE_PATTERN.test(fileName)) score += 40;
  if (SRC_INDEX_FILE_PATTERN.test(fileName) || ROOT_INDEX_FILE_PATTERN.test(fileName)) score += 30;
  if (SRC_APP_FILE_PATTERN.test(fileName) || ROOT_APP_FILE_PATTERN.test(fileName)) score += 10;
  return score;
}

function pickCanonicalQueryClientProviderOwner(files: GeneratedFile[]): string | null {
  if (files.length === 0) return null;
  const sorted = [...files].sort((left, right) => {
    const scoreDiff = scoreReactQueryProviderOwner(right) - scoreReactQueryProviderOwner(left);
    if (scoreDiff !== 0) return scoreDiff;
    return normalizePath(left.name).localeCompare(normalizePath(right.name));
  });
  return normalizePath(sorted[0]?.name ?? "");
}

function validateReactQueryProviderSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const codeFiles = files.filter((file) => looksLikeCodeFile(file.name));
  const usesReactQuery = codeFiles.some(
    (file) => REACT_QUERY_IMPORT_PATTERN.test(file.code) || REACT_QUERY_DIRECT_HOOK_PATTERN.test(file.code)
  );
  if (!usesReactQuery) {
    return issues;
  }

  const providerFiles = codeFiles.filter((file) => REACT_QUERY_PROVIDER_PATTERN.test(file.code));
  const entrypointProviders = providerFiles.filter((file) => isRuntimeEntrypoint(normalizePath(file.name)));
  const entrypointCandidates = codeFiles.filter((file) => isRuntimeEntrypoint(normalizePath(file.name)));

  if (providerFiles.length === 0) {
    issues.push({
      code: "react_query.missing_provider",
      file: entrypointCandidates[0]?.name,
      message:
        "TanStack Query hooks are used without QueryClientProvider. Wrap app root with QueryClientProvider and a shared QueryClient instance.",
    });
    return issues;
  }

  if (entrypointProviders.length === 0) {
    issues.push({
      code: "react_query.provider_not_in_entrypoint",
      file: providerFiles[0]?.name,
      message:
        "QueryClientProvider is defined outside runtime entrypoint. Put the top-level QueryClientProvider in src/main.* or index.* so all hook consumers render inside it.",
    });
  }

  const exportedQueryHooks = collectExportedQueryHookNames(codeFiles);
  for (const file of providerFiles) {
    const providerIndex = file.code.search(REACT_QUERY_PROVIDER_PATTERN);
    if (providerIndex < 0) continue;

    let violatingCall: string | null = null;

    REACT_QUERY_DIRECT_HOOK_PATTERN.lastIndex = 0;
    let directHookMatch: RegExpExecArray | null;
    while ((directHookMatch = REACT_QUERY_DIRECT_HOOK_PATTERN.exec(file.code)) !== null) {
      const matchIndex = directHookMatch.index ?? -1;
      if (matchIndex >= 0 && matchIndex < providerIndex) {
        violatingCall = directHookMatch[0]?.replace(/\s*\($/, "") ?? "useQuery";
        break;
      }
    }

    if (!violatingCall) {
      for (const hookName of exportedQueryHooks) {
        const hookPattern = new RegExp(`\\b${escapeRegex(hookName)}\\s*\\(`, "g");
        let hookCallMatch: RegExpExecArray | null;
        while ((hookCallMatch = hookPattern.exec(file.code)) !== null) {
          const matchIndex = hookCallMatch.index ?? -1;
          if (matchIndex >= 0 && matchIndex < providerIndex) {
            violatingCall = hookName;
            break;
          }
        }
        if (violatingCall) break;
      }
    }

    if (violatingCall) {
      issues.push({
        code: "react_query.provider_scope_violation",
        file: file.name,
        message:
          `Query hook \`${violatingCall}\` is invoked before QueryClientProvider in the same module. Move QueryClientProvider to runtime entrypoint and keep hook consumers inside that provider tree.`,
      });
      break;
    }
  }

  return issues;
}

function validateReactQueryDataAccess(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const queryHookNames = collectExportedQueryHookNames(files);

  if (queryHookNames.size === 0) {
    return issues;
  }

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }
    HOOK_DESTRUCTURE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = HOOK_DESTRUCTURE_PATTERN.exec(file.code)) !== null) {
      const rawFields = (match[1] ?? "").trim();
      const hookName = (match[2] ?? "").trim();
      if (!rawFields || !hookName) {
        continue;
      }
      if (!queryHookNames.has(hookName)) {
        continue;
      }

      const requestedFields = rawFields
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => part.replace(/^\.{3}/, "").trim())
        .map((part) => part.split(":")[0]?.trim() ?? "")
        .filter(Boolean);
      if (requestedFields.length === 0) {
        continue;
      }

      const unsafeFields = requestedFields.filter((field) => !QUERY_RESULT_FIELDS.has(field));
      if (unsafeFields.length === 0) {
        continue;
      }

      issues.push({
        code: "react_query.unsafe_data_destructure",
        file: file.name,
        message:
          `${hookName} appears to return useQuery() but is destructured with domain fields (${unsafeFields.join(", ")}). ` +
          "Read query payload from `data` with null-safe defaults (for example `const { data } = hook(); const value = data?.value ?? fallback;`).",
      });
    }
  }

  return issues;
}

function validateReactQueryOptimisticUpdates(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }

    const code = file.code;
    if (!/queryClient\s*\.\s*getQueryData\s*\(/.test(code)) {
      continue;
    }

    const assignmentPattern =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*queryClient\s*\.\s*getQueryData\s*\([^)]*\)\s*;?/g;
    let assignmentMatch: RegExpExecArray | null;
    while ((assignmentMatch = assignmentPattern.exec(code)) !== null) {
      const cacheVar = assignmentMatch[1];
      if (!cacheVar) continue;

      const unsafePropertyRead = new RegExp(`\\b${cacheVar}\\.(?:holdings|items|rows|data)\\b`);
      const optionalPropertyRead = new RegExp(`\\b${cacheVar}\\?\\.(?:holdings|items|rows|data)\\b`);
      const nullishFallback = new RegExp(`\\b${cacheVar}\\s*\\?\\?`);
      const andGuard = new RegExp(`\\b${cacheVar}\\s*&&`);

      if (
        unsafePropertyRead.test(code) &&
        !optionalPropertyRead.test(code) &&
        !nullishFallback.test(code) &&
        !andGuard.test(code)
      ) {
        issues.push({
          code: "react_query.on_mutate_unsafe_previous_data",
          file: file.name,
          message:
            `Uncaught TypeError risk in optimistic update: ${cacheVar} from queryClient.getQueryData(...) ` +
            "is read without null-safe fallback (first insert / cold cache path).",
        });
      }
    }

    const queryKeyPattern = /queryKey\s*:\s*([A-Za-z_$][\w$]*|["'`][^"'`]+["'`])/g;
    const setKeyPattern =
      /queryClient\s*\.\s*setQueryData\s*\(\s*([A-Za-z_$][\w$]*|["'`][^"'`]+["'`])\s*,\s*{/g;

    const queryKeys = new Set<string>();
    let queryKeyMatch: RegExpExecArray | null;
    while ((queryKeyMatch = queryKeyPattern.exec(code)) !== null) {
      if (queryKeyMatch[1]) {
        queryKeys.add(queryKeyMatch[1].trim());
      }
    }

    const setKeys = new Set<string>();
    let setKeyMatch: RegExpExecArray | null;
    while ((setKeyMatch = setKeyPattern.exec(code)) !== null) {
      if (setKeyMatch[1]) {
        setKeys.add(setKeyMatch[1].trim());
      }
    }

    const sharedKeys = Array.from(queryKeys).filter((key) => setKeys.has(key));
    const queryFnReturnsArray =
      /useQuery\s*\(\s*{[\s\S]{0,12000}?queryFn\s*:\s*async[\s\S]{0,6000}?return\s+[^;\n]*\.map\s*\(/.test(
        code
      ) ||
      /useQuery\s*\(\s*{[\s\S]{0,12000}?queryFn\s*:\s*async[\s\S]{0,6000}?return\s+\[[\s\S]{0,1200}?]/.test(
        code
      );
    const setQueryWritesObject = /queryClient\s*\.\s*setQueryData\s*\(\s*[^,]+,\s*{/.test(code);

    if (sharedKeys.length > 0 && queryFnReturnsArray && setQueryWritesObject) {
      issues.push({
        code: "react_query.cache_shape_mismatch",
        file: file.name,
        message:
          `Optimistic cache shape mismatch on key ${sharedKeys[0]}: useQuery queryFn appears to return an array, ` +
          "but setQueryData writes an object literal. This can make UI updates no-op or break first-insert flows.",
      });
    }
  }

  return issues;
}

function validateProjectAssets(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fileNames = new Set(files.map((f) => f.name));

  // Check for common design system entry points if referenced or expected
  if (!fileNames.has("src/index.css") && !fileNames.has("index.css")) {
    // Only warn if the app seems to be a Vite/React project
    if (fileNames.has("package.json") && (fileNames.has("index.html") || fileNames.has("src/main.tsx"))) {
      issues.push({
        code: "assets.missing_index_css",
        message: "Missing src/index.css. This file is required for global styles and design system CSS variables.",
      });
    }
  }
  return issues;
}

function validateStarterTemplatePlaceholder(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const appFile =
    files.find((file) => SRC_APP_FILE_PATTERN.test(file.name)) ??
    files.find((file) => ROOT_APP_FILE_PATTERN.test(file.name));

  if (!appFile) {
    return issues;
  }

  const code = appFile.code;
  const looksLikeDexterStarter =
    /Built with Dexter/i.test(code) &&
    /Your project is ready/i.test(code) &&
    /Start Building/i.test(code);

  if (looksLikeDexterStarter) {
    issues.push({
      code: "app.placeholder_starter_template",
      file: appFile.name,
      message:
        "App still contains the default starter placeholder. Replace it with the requested product UI and flows.",
    });
  }

  return issues;
}

function isLocalModuleSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function resolveLocalModulePath(
  importerPath: string,
  specifier: string,
  fileNames: Set<string>
): string | null {
  const basePath = specifier.startsWith("/")
    ? specifier.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), specifier));

  const normalizedBase = basePath.replace(/^\.?\//, "");
  if (!normalizedBase || normalizedBase.startsWith("../")) {
    return null;
  }

  const hasExtension = /\.[A-Za-z0-9]+$/.test(normalizedBase);
  const extensionCandidates = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
  const candidates: string[] = [];

  if (hasExtension) {
    candidates.push(normalizedBase);
  } else {
    candidates.push(normalizedBase);
    for (const extension of extensionCandidates) {
      candidates.push(`${normalizedBase}${extension}`);
    }
    for (const extension of extensionCandidates) {
      candidates.push(`${normalizedBase}/index${extension}`);
    }
  }

  for (const candidate of candidates) {
    if (fileNames.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function parseNamedImportSpecifiers(importClause: string): string[] {
  const namedBlockMatch = importClause.match(/{([^}]*)}/);
  if (!namedBlockMatch) {
    return [];
  }

  const rawParts = namedBlockMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const importedNames: string[] = [];
  for (const rawPart of rawParts) {
    if (rawPart.startsWith("*")) {
      continue;
    }

    const withoutTypePrefix = rawPart.replace(/^type\s+/, "");
    const imported = withoutTypePrefix.split(/\s+as\s+/i)[0]?.trim();
    if (!imported) {
      continue;
    }
    importedNames.push(imported);
  }

  return importedNames;
}

function parseNamedImportEntries(importClause: string): Array<{ imported: string; local: string }> {
  const namedBlockMatch = importClause.match(/{([^}]*)}/);
  if (!namedBlockMatch) {
    return [];
  }

  const rawParts = namedBlockMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const entries: Array<{ imported: string; local: string }> = [];
  for (const rawPart of rawParts) {
    if (rawPart.startsWith("*")) {
      continue;
    }

    const withoutTypePrefix = rawPart.replace(/^type\s+/, "");
    const [rawImported, rawLocal] = withoutTypePrefix.split(/\s+as\s+/i).map((part) => part.trim());
    const imported = rawImported || "";
    if (!imported) {
      continue;
    }
    const local = rawLocal || imported;
    entries.push({ imported, local });
  }

  return entries;
}

function parseDefaultImportSpecifier(importClause: string): string | null {
  const trimmed = importClause.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("*")) {
    return null;
  }

  const firstSegment = trimmed.split(",")[0]?.trim();
  if (!firstSegment) {
    return null;
  }

  const withoutTypePrefix = firstSegment.replace(/^type\s+/, "").trim();
  if (!withoutTypePrefix) {
    return null;
  }

  if (!/^[A-Za-z_$][\w$]*$/.test(withoutTypePrefix)) {
    return null;
  }

  return withoutTypePrefix;
}

function parseModuleExports(fileCode: string): {
  names: Set<string>;
  hasExportAll: boolean;
  hasDefaultExport: boolean;
  duplicateNames: string[];
} {
  const names = new Set<string>();
  const exportCounts = new Map<string, number>();
  const registerName = (rawName: string | undefined) => {
    const name = rawName?.trim();
    if (!name) {
      return;
    }
    names.add(name);
    exportCounts.set(name, (exportCounts.get(name) ?? 0) + 1);
  };

  EXPORT_DECLARATION_PATTERN.lastIndex = 0;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = EXPORT_DECLARATION_PATTERN.exec(fileCode)) !== null) {
    registerName(declarationMatch[1]);
  }

  EXPORT_NAMED_BLOCK_PATTERN.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = EXPORT_NAMED_BLOCK_PATTERN.exec(fileCode)) !== null) {
    const parts = blockMatch[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      const withoutTypePrefix = part.replace(/^type\s+/, "");
      const exportName = withoutTypePrefix.split(/\s+as\s+/i)[1]?.trim()
        ?? withoutTypePrefix.split(/\s+as\s+/i)[0]?.trim();
      registerName(exportName);
    }
  }

  const hasDefaultExport = /\bexport\s+default\b/.test(fileCode);
  const duplicateNames = Array.from(exportCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));

  return {
    names,
    hasExportAll: EXPORT_ALL_PATTERN.test(fileCode),
    hasDefaultExport,
    duplicateNames,
  };
}

function formatNamedImportEntries(
  entries: Array<{ imported: string; local: string }>
): string {
  return entries
    .map((entry) =>
      entry.imported === entry.local
        ? entry.imported
        : `${entry.imported} as ${entry.local}`
    )
    .join(", ");
}

function normalizeLocalImportContractForFile(
  sourceCode: string,
  sourcePath: string,
  fileNames: Set<string>,
  getExportsForFile: (filePath: string) => {
    names: Set<string>;
    hasExportAll: boolean;
    hasDefaultExport: boolean;
    duplicateNames: string[];
  }
): string {
  IMPORT_WITH_FROM_PATTERN.lastIndex = 0;
  let cursor = 0;
  let nextCode = "";
  let didChange = false;
  let match: RegExpExecArray | null;

  while ((match = IMPORT_WITH_FROM_PATTERN.exec(sourceCode)) !== null) {
    const [fullImport] = match;
    const importClause = (match[1] ?? "").trim();
    const specifier = (match[2] ?? "").trim();
    const start = match.index;
    const end = start + fullImport.length;
    nextCode += sourceCode.slice(cursor, start);
    cursor = end;

    if (!importClause || !specifier || !isLocalModuleSpecifier(specifier)) {
      nextCode += fullImport;
      continue;
    }

    const resolvedModulePath = resolveLocalModulePath(sourcePath, specifier, fileNames);
    if (!resolvedModulePath || !looksLikeCodeFile(resolvedModulePath)) {
      nextCode += fullImport;
      continue;
    }

    const moduleExports = getExportsForFile(resolvedModulePath);
    if (moduleExports.hasExportAll) {
      nextCode += fullImport;
      continue;
    }

    const defaultImport = parseDefaultImportSpecifier(importClause);
    if (importClause.startsWith("*")) {
      nextCode += fullImport;
      continue;
    }

    let defaultBinding = defaultImport;
    let namedEntries = parseNamedImportEntries(importClause);
    let localChanged = false;

    if (defaultBinding && !moduleExports.hasDefaultExport) {
      const fallbackNamedExport =
        moduleExports.names.size === 1 ? Array.from(moduleExports.names)[0] : null;
      const replacementImport = moduleExports.names.has(defaultBinding)
        ? defaultBinding
        : fallbackNamedExport;
      if (replacementImport) {
        const exists = namedEntries.some(
          (entry) => entry.imported === replacementImport && entry.local === defaultBinding
        );
        if (!exists) {
          namedEntries = namedEntries.concat([{ imported: replacementImport, local: defaultBinding }]);
        }
        defaultBinding = null;
        localChanged = true;
      }
    }

    const missingNamed = namedEntries.filter((entry) => !moduleExports.names.has(entry.imported));
    if (!defaultBinding && moduleExports.hasDefaultExport && missingNamed.length === 1) {
      const candidate = missingNamed[0];
      namedEntries = namedEntries.filter(
        (entry) =>
          !(entry.imported === candidate.imported && entry.local === candidate.local)
      );
      defaultBinding = candidate.local;
      localChanged = true;
    } else if (
      !moduleExports.hasDefaultExport &&
      missingNamed.length === 1 &&
      namedEntries.length === 1 &&
      moduleExports.names.size === 1
    ) {
      const candidate = missingNamed[0];
      const soleExport = Array.from(moduleExports.names)[0];
      if (soleExport && soleExport !== candidate.imported) {
        namedEntries = namedEntries.map((entry) =>
          entry.imported === candidate.imported && entry.local === candidate.local
            ? { imported: soleExport, local: candidate.local }
            : entry
        );
        localChanged = true;
      }
    }

    if (!localChanged) {
      nextCode += fullImport;
      continue;
    }

    const clauseParts: string[] = [];
    if (defaultBinding) {
      clauseParts.push(defaultBinding);
    }
    if (namedEntries.length > 0) {
      clauseParts.push(`{ ${formatNamedImportEntries(namedEntries)} }`);
    }
    const rebuiltClause = clauseParts.join(", ").trim();
    if (!rebuiltClause) {
      nextCode += fullImport;
      continue;
    }

    const quoteMatch = fullImport.match(/from\s*(["'`])/);
    const quote = quoteMatch?.[1] ?? "\"";
    nextCode += `import ${rebuiltClause} from ${quote}${specifier}${quote}`;
    didChange = true;
  }

  if (!didChange) {
    return sourceCode;
  }

  nextCode += sourceCode.slice(cursor);
  return nextCode;
}

function validateLocalModuleContracts(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIssueKeys = new Set<string>();
  const fileNames = new Set(files.map((file) => file.name));
  const exportCache = new Map<
    string,
    {
      names: Set<string>;
      hasExportAll: boolean;
      hasDefaultExport: boolean;
      duplicateNames: string[];
    }
  >();

  const getExportsForFile = (
    filePath: string
  ): {
    names: Set<string>;
    hasExportAll: boolean;
    hasDefaultExport: boolean;
    duplicateNames: string[];
  } => {
    const cached = exportCache.get(filePath);
    if (cached) {
      return cached;
    }

    const source = files.find((file) => file.name === filePath);
    if (!source || !looksLikeCodeFile(source.name)) {
      const empty = {
        names: new Set<string>(),
        hasExportAll: false,
        hasDefaultExport: false,
        duplicateNames: [] as string[],
      };
      exportCache.set(filePath, empty);
      return empty;
    }

    const parsed = parseModuleExports(source.code);
    exportCache.set(filePath, parsed);
    return parsed;
  };

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }
    const moduleExports = getExportsForFile(file.name);
    if (moduleExports.duplicateNames.length === 0) {
      continue;
    }
    const issueKey = `${file.name}|duplicate-exports|${moduleExports.duplicateNames.join(",")}`;
    if (seenIssueKeys.has(issueKey)) {
      continue;
    }
    seenIssueKeys.add(issueKey);
    issues.push({
      code: "exports.duplicate_named_export",
      file: file.name,
      message: `Multiple exports with the same name detected: ${moduleExports.duplicateNames.join(", ")}. Remove duplicate named exports (for example, avoid exporting a function declaration and re-exporting it again in export { ... }).`,
    });
  }

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }

    IMPORT_WITH_FROM_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_WITH_FROM_PATTERN.exec(file.code)) !== null) {
      const importClause = (match[1] ?? "").trim();
      const specifier = (match[2] ?? "").trim();
      if (!importClause || !specifier || !isLocalModuleSpecifier(specifier)) {
        continue;
      }

      const importedNames = parseNamedImportSpecifiers(importClause);
      const defaultImport = parseDefaultImportSpecifier(importClause);
      if (importedNames.length === 0 && !defaultImport) {
        continue;
      }

      const resolvedModulePath = resolveLocalModulePath(file.name, specifier, fileNames);
      if (!resolvedModulePath) {
        const issueKey = `${file.name}|${specifier}|missing-module`;
        if (!seenIssueKeys.has(issueKey)) {
          seenIssueKeys.add(issueKey);
          issues.push({
            code: "imports.local_missing_module",
            file: file.name,
            message: `Cannot resolve local module "${specifier}" from "${file.name}".`,
          });
        }
        continue;
      }

      if (!looksLikeCodeFile(resolvedModulePath)) {
        continue;
      }

      const moduleExports = getExportsForFile(resolvedModulePath);
      if (moduleExports.hasExportAll) {
        continue;
      }

      if (defaultImport && !moduleExports.hasDefaultExport) {
        const issueKey = `${file.name}|${resolvedModulePath}|default`;
        if (!seenIssueKeys.has(issueKey)) {
          seenIssueKeys.add(issueKey);
          issues.push({
            code: "imports.local_missing_default_export",
            file: file.name,
            message: `Local default import "${defaultImport}" expects default export in "${resolvedModulePath}". Keep import/export contracts synchronized.`,
          });
        }
      }

      for (const importedName of importedNames) {
        if (moduleExports.names.has(importedName)) {
          continue;
        }
        const issueKey = `${file.name}|${resolvedModulePath}|${importedName}`;
        if (seenIssueKeys.has(issueKey)) {
          continue;
        }
        seenIssueKeys.add(issueKey);
        issues.push({
          code: "imports.local_missing_export",
          file: file.name,
          message: `Local import "${importedName}" is missing from "${resolvedModulePath}". Keep import/export contracts synchronized.`,
        });
      }
    }
  }

  return issues;
}

function validateBrowserEnvSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!isBrowserSourceFile(file.name)) {
      continue;
    }

    if (!PROCESS_ENV_PATTERN.test(file.code)) {
      continue;
    }

    issues.push({
      code: "env.process_undefined_in_browser",
      file: file.name,
      message:
        "process.env is not available in Vite browser runtime. Use import.meta.env (for example VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).",
    });
  }

  return issues;
}

function validateNativeDialogUsage(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!isBrowserSourceFile(file.name)) {
      continue;
    }

    if (!NATIVE_DIALOG_PATTERN.test(file.code)) {
      continue;
    }

    issues.push({
      code: "ui.native_dialog_api",
      file: file.name,
      message:
        "Native dialog APIs (alert/prompt/confirm) are not allowed. Replace with an in-app modal/dialog component for consistent UX.",
    });
  }

  return issues;
}

function validateCvaImportSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }

    if (!CVA_CALL_PATTERN.test(file.code)) {
      continue;
    }

    if (CVA_IMPORT_PATTERN.test(file.code) || CVA_LOCAL_DECL_PATTERN.test(file.code)) {
      continue;
    }

    issues.push({
      code: "imports.missing_cva_import",
      file: file.name,
      message:
        "Uses `cva(...)` without importing cva from class-variance-authority. Add `import { cva } from \"class-variance-authority\"`.",
    });
  }

  return issues;
}

function validateSqlUpdateParamOrder(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }

    SQL_UPDATE_ID_VALUE_PARAM_ORDER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SQL_UPDATE_ID_VALUE_PARAM_ORDER_PATTERN.exec(file.code)) !== null) {
      const table = (match[2] ?? "").trim() || "table";
      const firstParam = (match[3] ?? "").trim();
      const secondParam = (match[4] ?? "").trim();
      const firstLower = firstParam.toLowerCase();
      const secondLower = secondParam.toLowerCase();
      const firstLooksId = /(^|[._])id$|(^|[._])holdingid$|(^|[._])assetid$/.test(firstLower) || /\bid\b/.test(firstLower);
      const secondLooksValue =
        /(amount|qty|quantity|price|value|cost|delta|change|new)/.test(secondLower) &&
        !/\bid\b/.test(secondLower);
      if (!firstLooksId || !secondLooksValue) {
        continue;
      }

      issues.push({
        code: "sql.update_param_order_likely_wrong",
        file: file.name,
        message:
          `Likely SQL parameter order mismatch: UPDATE ${table} expects value first and id second, but found [${firstParam}, ${secondParam}].`,
      });
      break;
    }
  }

  return issues;
}

function buildRuntimeDiagnostics(issues: ValidationIssue[]): string[] {
  const diagnostics: string[] = [];
  const push = (line: string) => {
    if (!line) return;
    if (!diagnostics.includes(line)) {
      diagnostics.push(line);
    }
  };

  for (const issue of issues) {
    const location = issue.file ? `${issue.file}: ` : "";
    switch (issue.code) {
      case "transpile.error":
        push(`[vite] ${location}${issue.message}`);
        break;
      case "exports.duplicate_named_export":
        push(`[vite] ${location}${issue.message}`);
        break;
      case "tailwind.css_invalid_apply_utility":
      case "tailwind.css_apply_custom_class":
        push(`[vite] ${location}${issue.message}`);
        break;
      case "imports.local_missing_module":
      case "imports.local_missing_default_export":
      case "imports.local_missing_export":
      case "imports.missing_cva_import":
        push(`[vite] Failed to resolve import: ${location}${issue.message}`);
        break;
      case "router.multiple_providers":
        push(`[runtime] ${location}${issue.message}`);
        break;
      case "react_query.on_mutate_unsafe_previous_data":
      case "react_query.cache_shape_mismatch":
      case "react_query.missing_provider":
      case "react_query.provider_not_in_entrypoint":
      case "react_query.provider_scope_violation":
        push(`[runtime] ${location}${issue.message}`);
        break;
      case "sql.update_param_order_likely_wrong":
        push(`[runtime] ${location}${issue.message}`);
        break;
      case "env.process_undefined_in_browser":
        push(`[runtime] ${location}${issue.message}`);
        break;
      case "pglite.missing_bundle_recovery":
      case "pglite.static_fallback_dir":
      case "pglite.retry_missing_singleflight":
      case "pglite.init_missing_singleflight":
      case "pglite.multiple_initializers":
      case "pglite.init_in_ui_layer":
      case "pglite.db_not_exported":
      case "pglite.invalid_nested_export":
      case "pglite.missing_column_migration_guard":
      case "pglite.query_object_signature_unsupported":
      case "pglite.wait_ready_invocation_invalid":
        push(`[runtime] ${location}${issue.message}`);
        break;
      default:
        break;
    }
  }

  return diagnostics.slice(0, 8);
}

function validateEntryPointSemantics(files: GeneratedFile[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fileNames = files.map((file) => file.name);
  const hasRootApp = fileNames.some((name) => ROOT_APP_FILE_PATTERN.test(name));
  const hasSrcApp = fileNames.some((name) => SRC_APP_FILE_PATTERN.test(name));

  if (hasRootApp && hasSrcApp) {
    issues.push({
      code: "entry.conflicting_app_files",
      message:
        "Conflicting entry strategy: both App.* and src/App.* exist. Keep a single app entry strategy and remove the extra scaffold file.",
    });
  }

  return issues;
}

function looksLikeCodeFile(fileName: string): boolean {
  return /\.(js|jsx|ts|tsx)$/.test(fileName);
}

async function getTypeScript(): Promise<typeof import("typescript") | null> {
  if (!typeScriptLoader) {
    typeScriptLoader = import("typescript").catch(() => null);
  }
  return typeScriptLoader;
}

async function validateTranspile(files: GeneratedFile[]): Promise<ValidationIssue[]> {
  const ts = await getTypeScript();
  if (!ts) {
    return [];
  }

  const issues: ValidationIssue[] = [];

  for (const file of files) {
    if (!looksLikeCodeFile(file.name)) {
      continue;
    }

    const output = ts.transpileModule(file.code, {
      fileName: file.name,
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        allowJs: true,
        allowSyntheticDefaultImports: true,
      },
    });

    const diagnostics = output.diagnostics ?? [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) {
        continue;
      }

      const rawMessage = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
      issues.push({
        code: "transpile.error",
        file: file.name,
        message: rawMessage,
      });

      if (issues.length >= 12) {
        return issues;
      }
    }
  }

  return issues;
}

export function normalizeGeneratedFiles(files: GeneratedFile[]): GeneratedFile[] {
  const normalized: GeneratedFile[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    if (!file || typeof file !== "object") {
      throw new Error("Invalid file payload");
    }

    const rawName = String(file.name ?? "");
    const rawCode = String(file.code ?? "");
    const normalizedName = normalizePath(rawName);
    const normalizedCode = rawCode;

    if (!normalizedCode.trim()) {
      throw new Error(`File ${normalizedName} has empty code`);
    }

    if (seen.has(normalizedName)) {
      throw new Error(`Duplicate file path: ${normalizedName}`);
    }

    seen.add(normalizedName);
    normalized.push({
      name: normalizedName,
      code: normalizedCode,
      language: file.language,
    });
  }

  return normalized;
}

export type InvalidFileOperationIssue = {
  path?: string;
  reason: string;
};

export type ApplyFileOperationsResult = {
  files: GeneratedFile[];
  appliedOperations: FileOperation[];
  invalidOperations: InvalidFileOperationIssue[];
};

export function applyFileOperations(
  currentFiles: GeneratedFile[],
  operations: FileOperation[],
  context?: ApplyOperationContext
): ApplyFileOperationsResult {
  const nextMap = new Map<string, GeneratedFile>();

  for (const file of normalizeGeneratedFiles(currentFiles)) {
    nextMap.set(file.name, file);
  }

  const formatPrefix = (index: number, path?: string) => {
    const phase = context?.phase ? ` phase=${context.phase}` : "";
    const taskId = context?.taskId ? ` task=${context.taskId}` : "";
    const opPath = path ? ` path=${path}` : "";
    return `op#${index}${phase}${taskId}${opPath}`;
  };

  const appliedOperations: FileOperation[] = [];
  const invalidOperations: InvalidFileOperationIssue[] = [];

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    try {
      if (operation.op === "delete") {
        const normalizedPath = normalizePath(operation.path);
        nextMap.delete(normalizedPath);
        appliedOperations.push(operation);
        continue;
      }

      if (operation.op === "upsert") {
        if (typeof operation.code !== "string" || !operation.code.trim()) {
          throw new Error(`Upsert operation for ${operation.path} is missing code`);
        }

        const normalizedPath = normalizePath(operation.path);
        nextMap.set(normalizedPath, {
          name: normalizedPath,
          code: operation.code,
          language: operation.language,
        });
        appliedOperations.push(operation);
        continue;
      }

      if (operation.op === "json_manifest_update") {
        const normalizedPath = normalizePath(operation.path);
        const existing = nextMap.get(normalizedPath);
        if (!existing) {
          throw new Error(`json_manifest_update target not found: ${normalizedPath}`);
        }

        let parsedExisting: unknown;
        try {
          parsedExisting = JSON.parse(existing.code);
        } catch {
          throw new Error(`json_manifest_update target is not valid JSON: ${normalizedPath}`);
        }

        if (!parsedExisting || typeof parsedExisting !== "object" || Array.isArray(parsedExisting)) {
          throw new Error(`json_manifest_update requires JSON object root: ${normalizedPath}`);
        }
        if (!operation.merge || typeof operation.merge !== "object" || Array.isArray(operation.merge)) {
          throw new Error(`json_manifest_update merge payload must be a JSON object: ${normalizedPath}`);
        }

        const merged = deepMergeJson(
          parsedExisting as Record<string, unknown>,
          operation.merge
        );

        nextMap.set(normalizedPath, {
          name: normalizedPath,
          code: `${JSON.stringify(merged, null, 2)}\n`,
          language: existing.language ?? "json",
        });
        appliedOperations.push(operation);
        continue;
      }

      const unsupported = operation as { op?: unknown };
      throw new Error(`Unsupported file operation: ${String(unsupported.op)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown operation failure";
      invalidOperations.push({
        path: operation.path,
        reason: `${formatPrefix(index, operation.path)} failed: ${message}`,
      });
    }
  }

  return {
    files: Array.from(nextMap.values()),
    appliedOperations,
    invalidOperations,
  };
}

function deepMergeJson(
  target: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...target };

  for (const [key, nextValue] of Object.entries(patch)) {
    if (
      nextValue &&
      typeof nextValue === "object" &&
      !Array.isArray(nextValue) &&
      output[key] &&
      typeof output[key] === "object" &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMergeJson(
        output[key] as Record<string, unknown>,
        nextValue as Record<string, unknown>
      );
      continue;
    }
    output[key] = nextValue;
  }

  return output;
}

type DeterministicFixPlan = {
  operations: FileOperation[];
  attemptedIssueCodes: string[];
  fixedIssueCodes: string[];
};

function replaceProcessEnvAccess(code: string): string {
  let next = code;
  next = next.replace(
    /process\s*\.\s*env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, variableName: string) => `import.meta.env.${variableName}`
  );
  next = next.replace(
    /process\s*\.\s*env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    (_match, variableName: string) => `import.meta.env.${variableName}`
  );
  return next;
}

function normalizePostcssTailwindPlugin(code: string): string {
  let next = code;
  next = next.replace(
    /require\(\s*(['"])@tailwindcss\/postcss\1\s*\)/g,
    (_match, quote: string) => `require(${quote}tailwindcss${quote})`
  );
  next = next.replace(
    /from\s+(['"])@tailwindcss\/postcss\1/g,
    (_match, quote: string) => `from ${quote}tailwindcss${quote}`
  );
  next = next.replace(
    /(['"])@tailwindcss\/postcss\1/g,
    (_match, quote: string) => `${quote}tailwindcss${quote}`
  );
  return next;
}

function normalizeTailwindCssDirective(code: string): string {
  return code
    .replace(/@tailwindcss\/postcss\s*;/g, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n')
    .replace(/@import\s+['"]tailwindcss['"]\s*;/ig, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
}

function normalizeTailwindInvalidApplyUtilities(code: string): string {
  let next = code;
  next = next.replace(
    /\bborder-gradient-to-(r|l|t|b|tr|tl|br|bl)\b/g,
    (_match, direction: string) => `bg-gradient-to-${direction}`
  );
  next = next.replace(/\bborder-from-([^\s;]+)/g, (_match, token: string) => `from-${token}`);
  next = next.replace(/\bborder-via-([^\s;]+)/g, (_match, token: string) => `via-${token}`);
  next = next.replace(/\bborder-to-([^\s;]+)/g, (_match, token: string) => `to-${token}`);
  return next;
}

function normalizeTailwindApplyCustomClass(code: string, classNames: string[]): string {
  if (classNames.length === 0) {
    return code;
  }
  const classNameSet = new Set(classNames);
  return code.replace(/(^\s*)@apply\s+([^;]+);?/gm, (full, indent: string, utilityList: string) => {
    const keptUtilities = utilityList
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .filter((token) => {
        const normalizedToken = token.replace(/^!+/, "").split(":").pop()?.trim() ?? "";
        return !classNameSet.has(normalizedToken);
      });
    if (keptUtilities.length === 0) {
      return "";
    }
    return `${indent}@apply ${keptUtilities.join(" ")};`;
  });
}

function normalizePgliteDefaultImport(code: string): string {
  let next = code;

  next = next.replace(
    /import\s+([A-Za-z_$][\w$]*)\s*,\s*{([^}]*)}\s+from\s*(['"])@electric-sql\/pglite\3\s*;?/g,
    (_match, defaultLocal: string, namedPart: string, quote: string) => {
      const namedTokens = namedPart
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean);
      const pgliteAlias =
        defaultLocal === "PGlite" ? "PGlite" : `PGlite as ${defaultLocal}`;
      const merged = new Set<string>([pgliteAlias, ...namedTokens]);
      return `import { ${Array.from(merged).join(", ")} } from ${quote}@electric-sql/pglite${quote};`;
    }
  );

  next = next.replace(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])@electric-sql\/pglite\2\s*;?/g,
    (_match, defaultLocal: string, quote: string) => {
      const specifier =
        defaultLocal === "PGlite" ? "PGlite" : `PGlite as ${defaultLocal}`;
      return `import { ${specifier} } from ${quote}@electric-sql/pglite${quote};`;
    }
  );

  return next;
}

function ensureViteOptimizeDepsExclude(code: string): string {
  if (
    /optimizeDeps\s*:\s*{[\s\S]*exclude\s*:\s*\[[^\]]*@electric-sql\/pglite[^\]]*\]/i.test(code)
  ) {
    return code;
  }

  const withExistingOptimizeDeps = code.replace(
    /optimizeDeps\s*:\s*{([\s\S]*?)}/m,
    (full, body: string) => {
      if (/exclude\s*:\s*\[[\s\S]*?]/m.test(body)) {
        const nextBody = body.replace(/exclude\s*:\s*\[([\s\S]*?)\]/m, (arrayFull, inner) => {
          if (/@electric-sql\/pglite/.test(inner)) {
            return arrayFull;
          }
          const trimmed = String(inner).trim();
          const nextInner = trimmed.length > 0
            ? `${trimmed}, "@electric-sql/pglite"`
            : '"@electric-sql/pglite"';
          return `exclude: [${nextInner}]`;
        });
        return `optimizeDeps: {${nextBody}}`;
      }

      const suffix = body.trim().length > 0 ? `\n${body}` : "";
      return `optimizeDeps: {${suffix}\n    exclude: ["@electric-sql/pglite"],\n  }`;
    }
  );
  if (withExistingOptimizeDeps !== code) {
    return withExistingOptimizeDeps;
  }

  const injectIntoDefineConfig = code.replace(
    /defineConfig\s*\(\s*{/,
    (match) => `${match}\n  optimizeDeps: { exclude: ["@electric-sql/pglite"] },`
  );
  if (injectIntoDefineConfig !== code) {
    return injectIntoDefineConfig;
  }

  const injectIntoDefaultExport = code.replace(
    /export\s+default\s*{/,
    (match) => `${match}\n  optimizeDeps: { exclude: ["@electric-sql/pglite"] },`
  );
  if (injectIntoDefaultExport !== code) {
    return injectIntoDefaultExport;
  }

  const injectIntoModuleExports = code.replace(
    /module\.exports\s*=\s*{/,
    (match) => `${match}\n  optimizeDeps: { exclude: ["@electric-sql/pglite"] },`
  );
  return injectIntoModuleExports;
}

function injectImportStatement(code: string, statement: string): string {
  const importBlockPattern = /^(import[^\n]*\n)+/m;
  if (importBlockPattern.test(code)) {
    return code.replace(importBlockPattern, (block) => `${block}${statement}\n`);
  }
  return `${statement}\n${code}`;
}

function ensureCvaImport(code: string): string {
  if (CVA_IMPORT_PATTERN.test(code) || CVA_LOCAL_DECL_PATTERN.test(code)) {
    return code;
  }

  const namedImportPattern =
    /import\s*{([^}]*)}\s*from\s*(['"`])class-variance-authority\2\s*;?/;
  const withNamedImport = code.replace(
    namedImportPattern,
    (_full, namedPart: string, quote: string) => {
      const names = namedPart
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const hasCva = names.some((entry) => (entry.split(/\s+as\s+/i)[0]?.trim() ?? entry) === "cva");
      if (!hasCva) {
        names.push("cva");
      }
      return `import { ${names.join(", ")} } from ${quote}class-variance-authority${quote};`;
    }
  );
  if (withNamedImport !== code) {
    return withNamedImport;
  }

  return injectImportStatement(code, 'import { cva } from "class-variance-authority";');
}

function ensureUseFrameImport(code: string): string {
  if (hasNamedR3FImport(code, "useFrame")) {
    return code;
  }

  const namedImportPattern =
    /import\s*{([^}]*)}\s*from\s*(['"`])@react-three\/fiber\2\s*;?/;
  const withExtendedNamedImport = code.replace(
    namedImportPattern,
    (_full, namedPart: string, quote: string) => {
      const names = namedPart
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const baseNames = names.map((entry) => entry.split(/\s+as\s+/i)[0]?.trim() ?? entry);
      if (!baseNames.includes("useFrame")) {
        names.push("useFrame");
      }
      return `import { ${names.join(", ")} } from ${quote}@react-three/fiber${quote};`;
    }
  );
  if (withExtendedNamedImport !== code) {
    return withExtendedNamedImport;
  }

  return injectImportStatement(code, 'import { useFrame } from "@react-three/fiber";');
}


function ensureTopLevelQueryClientSingleton(code: string): string {
  if (REACT_QUERY_CLIENT_INIT_PATTERN.test(code)) {
    return code;
  }

  const lines = code.split("\n");
  let insertAt = 0;
  while (insertAt < lines.length) {
    const line = lines[insertAt];
    if (
      /^\s*(?:import\b|\/\/|\/\*|\*|["']use strict["'];?\s*)/.test(line) ||
      /^\s*$/.test(line)
    ) {
      insertAt += 1;
      continue;
    }
    break;
  }
  lines.splice(insertAt, 0, "const queryClient = new QueryClient();");
  return lines.join("\n");
}

function ensureQueryClientProvider(code: string): string {
  if (REACT_QUERY_PROVIDER_PATTERN.test(code)) {
    return code;
  }

  let next = code;
  next = ensureNamedImportFromSource(next, "@tanstack/react-query", "QueryClient", "QueryClient");
  next = ensureNamedImportFromSource(
    next,
    "@tanstack/react-query",
    "QueryClientProvider",
    "QueryClientProvider"
  );
  next = ensureTopLevelQueryClientSingleton(next);

  const appImportMatch = next.match(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"`](?:\.\/|\.\.\/)*App(?:\.[^'"`]+)?['"`]\s*;?/
  );
  const appBinding = appImportMatch?.[1] ?? "App";
  if (!new RegExp(`<${appBinding}\\b`).test(next)) {
    return next;
  }

  const selfClosingPattern = new RegExp(`(^[ \\t]*)<${appBinding}\\b([^>]*)\\/>(\\s*)$`, "m");
  if (selfClosingPattern.test(next)) {
    return next.replace(
      selfClosingPattern,
      (_full, indent: string, propsPart: string, trailing: string) =>
        `${indent}<QueryClientProvider client={queryClient}>\n${indent}  <${appBinding}${propsPart} />\n${indent}</QueryClientProvider>${trailing}`
    );
  }

  const explicitPairPattern = new RegExp(
    `(^[ \\t]*)<${appBinding}\\b([^>]*)>([\\s\\S]*?)<\\/${appBinding}>(\\s*)$`,
    "m"
  );
  if (explicitPairPattern.test(next)) {
    return next.replace(
      explicitPairPattern,
      (_full, indent: string, propsPart: string, children: string, trailing: string) =>
        `${indent}<QueryClientProvider client={queryClient}>\n${indent}  <${appBinding}${propsPart}>${children}</${appBinding}>\n${indent}</QueryClientProvider>${trailing}`
    );
  }

  return next;
}

function stripNestedQueryClientProviders(code: string): string {
  let next = code
    .replace(QUERY_PROVIDER_OPEN_TAG_PATTERN, "")
    .replace(QUERY_PROVIDER_CLOSE_TAG_PATTERN, "");

  if (!REACT_QUERY_PROVIDER_PATTERN.test(next)) {
    next = removeNamedImportsFromModule(
      next,
      "@tanstack/react-query",
      new Set(["QueryClientProvider", "QueryClient"])
    );
    next = next.replace(
      /^\s*const\s+queryClient\s*=\s*new\s+QueryClient\s*\([^;]*\)\s*;?\s*$/gm,
      ""
    );
  }

  return next;
}

function removeNamedImportsFromModule(
  code: string,
  moduleName: string,
  namesToRemove: Set<string>
): string {
  const pruneNames = (namedPart: string): string[] =>
    namedPart
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((entry) => {
        const base = entry.split(/\s+as\s+/i)[0]?.trim() ?? entry;
        return !namesToRemove.has(base);
      });

  const mixedImportPattern = new RegExp(
    `import\\s+([^,{][^,;]*?)\\s*,\\s*{([^}]*)}\\s*from\\s*(['"\`])${moduleName}\\3\\s*;?`,
    "g"
  );
  let next = code.replace(
    mixedImportPattern,
    (_full, defaultBinding: string, namedPart: string, quote: string) => {
      const names = pruneNames(namedPart);
      if (names.length === 0) {
        return `import ${defaultBinding.trim()} from ${quote}${moduleName}${quote};`;
      }
      return `import ${defaultBinding.trim()}, { ${names.join(", ")} } from ${quote}${moduleName}${quote};`;
    }
  );

  const namedImportPattern = new RegExp(
    `import\\s*{([^}]*)}\\s*from\\s*(['"\`])${moduleName}\\2\\s*;?`,
    "g"
  );
  next = next.replace(namedImportPattern, (_full, namedPart: string, quote: string) => {
    const names = pruneNames(namedPart);
    if (names.length === 0) {
      return "";
    }
    return `import { ${names.join(", ")} } from ${quote}${moduleName}${quote};`;
  });

  return next;
}

function stripNestedRouterWrappers(code: string): string {
  let next = code
    .replace(ROUTER_WRAPPER_OPEN_TAG_PATTERN, "")
    .replace(ROUTER_WRAPPER_CLOSE_TAG_PATTERN, "");

  const wrappersStillPresent =
    ROUTER_WRAPPER_TAG_PATTERN.test(next) || ROUTER_WRAPPER_CLOSE_TAG_SINGLE_PATTERN.test(next);
  if (!wrappersStillPresent) {
    next = removeNamedImportsFromModule(
      next,
      "react-router-dom",
      new Set(["BrowserRouter", "Router", "HashRouter", "MemoryRouter"])
    );
  }

  return next;
}

function scoreRouterOwnerCandidate(file: GeneratedFile): number {
  const fileName = normalizePath(file.name);
  let score = 0;

  if (ROUTER_CREATOR_PATTERN.test(file.code) || ROUTER_PROVIDER_TAG_PATTERN.test(file.code)) {
    score += 300;
  }
  if (ROUTER_WRAPPER_TAG_PATTERN.test(file.code)) {
    score += 120;
  }
  if (isRuntimeEntrypoint(fileName)) {
    score += 80;
  }
  if (SRC_MAIN_FILE_PATTERN.test(fileName) || ROOT_MAIN_FILE_PATTERN.test(fileName)) {
    score += 40;
  }
  if (SRC_APP_FILE_PATTERN.test(fileName) || ROOT_APP_FILE_PATTERN.test(fileName)) {
    score += 30;
  }

  return score;
}

function pickCanonicalRouterOwner(files: GeneratedFile[]): string | null {
  if (files.length === 0) return null;

  const sorted = [...files].sort((left, right) => {
    const scoreDiff = scoreRouterOwnerCandidate(right) - scoreRouterOwnerCandidate(left);
    if (scoreDiff !== 0) return scoreDiff;
    return normalizePath(left.name).localeCompare(normalizePath(right.name));
  });
  return normalizePath(sorted[0]?.name ?? "");
}

function stripKnownCodeExtension(filePath: string): string {
  return filePath.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/i, "");
}

function toRelativeImportPath(fromPath: string, toPath: string): string {
  const fromDir = path.posix.dirname(fromPath);
  const relative = path.posix.relative(fromDir, toPath).replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/i, "");
  if (!relative) return "./";
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function pickCanonicalPgliteModulePath(paths: string[]): string | null {
  if (paths.length === 0) return null;
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  const preferred = sorted.find((name) =>
    /^(?:src\/)?lib\/db\.(?:js|jsx|ts|tsx|mjs|cjs)$/i.test(name)
  );
  return preferred ?? sorted[0] ?? null;
}

function ensureTopLevelExportedDbPlaceholder(code: string): string {
  if (/^\s*export\s+(?:const|let|var)\s+db\b/m.test(code)) {
    return code;
  }
  if (/^\s*export\s*{\s*[^}]*\bdb\b[^}]*}/m.test(code)) {
    return code;
  }
  if (/^\s*let\s+db\s*;?\s*$/m.test(code) || /^\s*var\s+db\s*;?\s*$/m.test(code)) {
    return code.replace(/^\s*(let|var)\s+db\s*;?\s*$/m, "export let db;");
  }

  const lines = code.split("\n");
  let insertAt = 0;
  while (insertAt < lines.length) {
    const line = lines[insertAt];
    if (
      /^\s*(?:import\b|\/\/|\/\*|\*|["']use strict["'];?\s*)/.test(line) ||
      /^\s*$/.test(line)
    ) {
      insertAt += 1;
      continue;
    }
    break;
  }
  lines.splice(insertAt, 0, "export let db;");
  return lines.join("\n");
}

type ParsedPgliteColumn = {
  name: string;
  typeClause: string;
};

type ParsedPgliteTableSchema = {
  tableName: string;
  columns: ParsedPgliteColumn[];
};

function normalizeSqlIdentifier(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unquoted =
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  if (!/^[A-Za-z_][\w$]*$/.test(unquoted)) {
    return null;
  }
  return unquoted;
}

function splitSqlTopLevelComma(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    const prev = i > 0 ? raw[i - 1] : "";
    const escaped = prev === "\\";

    if (!escaped) {
      if (!inDoubleQuote && !inBacktick && char === "'") {
        inSingleQuote = !inSingleQuote;
      } else if (!inSingleQuote && !inBacktick && char === "\"") {
        inDoubleQuote = !inDoubleQuote;
      } else if (!inSingleQuote && !inDoubleQuote && char === "`") {
        inBacktick = !inBacktick;
      }
    }

    if (!inSingleQuote && !inDoubleQuote && !inBacktick) {
      if (char === "(") depth += 1;
      if (char === ")") depth = Math.max(0, depth - 1);
      if (char === "," && depth === 0) {
        const trimmed = current.trim();
        if (trimmed) parts.push(trimmed);
        current = "";
        continue;
      }
    }

    current += char;
  }

  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseCreateTableColumns(rawColumns: string): ParsedPgliteColumn[] {
  const segments = splitSqlTopLevelComma(rawColumns);
  const parsed: ParsedPgliteColumn[] = [];

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed || SQL_COLUMN_CONSTRAINT_PATTERN.test(trimmed)) {
      continue;
    }

    const columnNameMatch = trimmed.match(
      /^(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][\w$]*))\b/
    );
    const rawName = columnNameMatch?.[1] ?? columnNameMatch?.[2] ?? columnNameMatch?.[3] ?? "";
    const columnName = normalizeSqlIdentifier(rawName);
    if (!columnName) {
      continue;
    }

    const rest = trimmed.slice(columnNameMatch?.[0]?.length ?? 0).trim();
    const typeTokens: string[] = [];
    for (const token of rest.split(/\s+/).filter(Boolean)) {
      const normalized = token.replace(/[(),]/g, "").toUpperCase();
      if (!normalized) continue;
      if (SQL_TYPE_STOP_TOKENS.has(normalized)) break;
      typeTokens.push(token.replace(/,+$/, ""));
      if (typeTokens.length >= 3) break;
    }
    const typeClause = typeTokens.join(" ").trim() || "TEXT";
    parsed.push({ name: columnName, typeClause });
  }

  return parsed;
}

function extractPgliteCreateTableSchemas(code: string): ParsedPgliteTableSchema[] {
  const schemas: ParsedPgliteTableSchema[] = [];
  SQL_CREATE_TABLE_IF_NOT_EXISTS_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SQL_CREATE_TABLE_IF_NOT_EXISTS_PATTERN.exec(code)) !== null) {
    const rawTableName = (match[1] ?? "").trim();
    const tableName = normalizeSqlIdentifier(rawTableName);
    if (!tableName) continue;
    const rawColumns = match[2] ?? "";
    const columns = parseCreateTableColumns(rawColumns).filter(
      (column) => !/PRIMARY\s+KEY/i.test(rawColumns)
        || !new RegExp(`\\b${column.name}\\b[\\s\\S]{0,80}PRIMARY\\s+KEY`, "i").test(rawColumns)
    );
    if (columns.length === 0) continue;
    schemas.push({ tableName, columns });
  }

  return schemas;
}

function hasPgliteColumnMigrationGuard(code: string): boolean {
  return (
    /\binformation_schema\.columns\b/i.test(code) ||
    /\bALTER\s+TABLE\s+["'`A-Za-z_][^;\n]*\s+ADD\s+COLUMN\b/i.test(code)
  );
}

function buildPgliteSchemaMigrationHelper(schemas: ParsedPgliteTableSchema[]): string {
  const serializedSchemas = JSON.stringify(schemas)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
  return `
async function __dexterEnsurePgliteSchemaMigrations(db) {
  const __dexterSchema = ${serializedSchemas};
  const __dexterRowsFromResult = (result) =>
    Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];

  for (const table of __dexterSchema) {
    const tableInfoResult = await db.query(
      \`SELECT column_name FROM information_schema.columns WHERE table_name = '\${table.tableName}';\`
    );
    const existingColumnNames = new Set(
      __dexterRowsFromResult(tableInfoResult)
        .map((row) => String(row?.column_name ?? "").toLowerCase())
        .filter(Boolean)
    );

    for (const column of table.columns) {
      const normalizedName = column.name.toLowerCase();
      if (existingColumnNames.has(normalizedName)) {
        continue;
      }
      await db.exec(
        \`ALTER TABLE "\${table.tableName}" ADD COLUMN "\${column.name}" \${column.typeClause};\`
      );
      existingColumnNames.add(normalizedName);
    }
  }
}
`.trim();
}

function ensurePgliteColumnMigrationGuard(code: string): string {
  if (!PGLITE_INIT_CALL_PATTERN.test(code)) {
    return code;
  }
  const schemas = extractPgliteCreateTableSchemas(code);
  if (schemas.length === 0) {
    return code;
  }
  if (hasPgliteColumnMigrationGuard(code)) {
    return code;
  }

  let next = code;
  if (!/\b__dexterEnsurePgliteSchemaMigrations\s*\(/.test(next)) {
    const returnPattern = /(^|[\n\s;])return\s+db\s*;?/;
    if (returnPattern.test(next)) {
      next = next.replace(
        returnPattern,
        (_full, leading) =>
          `${leading}await __dexterEnsurePgliteSchemaMigrations(db);\n  return db;`
      );
    } else {
      return code;
    }
  }

  if (!/\basync\s+function\s+__dexterEnsurePgliteSchemaMigrations\b/.test(next)) {
    next = `${next.trimEnd()}\n\n${buildPgliteSchemaMigrationHelper(schemas)}\n`;
  }

  return next;
}

function ensureCanonicalPgliteDbExport(code: string): string {
  if (PGLITE_EXPORTED_DB_DECLARATION_PATTERN.test(code) || PGLITE_EXPORTED_DB_NAMED_PATTERN.test(code)) {
    return code;
  }

  if (/^const\s+db\s*=\s*new\s+PGlite\s*\(/m.test(code)) {
    return code.replace(/^const\s+db\s*=\s*new\s+PGlite\s*\(/m, "export const db = new PGlite(");
  }
  if (/^let\s+db\s*=\s*new\s+PGlite\s*\(/m.test(code)) {
    return code.replace(/^let\s+db\s*=\s*new\s+PGlite\s*\(/m, "export let db = new PGlite(");
  }
  if (/^var\s+db\s*=\s*new\s+PGlite\s*\(/m.test(code)) {
    return code.replace(/^var\s+db\s*=\s*new\s+PGlite\s*\(/m, "export var db = new PGlite(");
  }

  if (/\b(?:const|let|var)\s+db\s*=\s*new\s+PGlite\s*\(/.test(code)) {
    const reassigned = code.replace(
      /\b(?:const|let|var)\s+db\s*=\s*new\s+PGlite\s*\(/,
      "db = new PGlite("
    );
    return ensureTopLevelExportedDbPlaceholder(reassigned);
  }

  if (/\bdb\s*=\s*new\s+PGlite\s*\(/.test(code)) {
    return ensureTopLevelExportedDbPlaceholder(code);
  }

  return code;
}

function normalizeSecondaryPgliteInitializer(
  code: string,
  sourcePath: string,
  canonicalPath: string
): string {
  const initDeclPattern =
    /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*new\s+PGlite\s*\([^;]*\)\s*;?\s*$/gm;
  const initVariables: string[] = [];
  let next = code.replace(initDeclPattern, (_match, localVar: string) => {
    initVariables.push(localVar);
    return "";
  });

  if (initVariables.length === 0) {
    return code;
  }

  next = next.replace(
    /^\s*import\s+[^;]*from\s*['"`]@electric-sql\/pglite['"`]\s*;?\s*$/gm,
    ""
  );

  const importSource = toRelativeImportPath(sourcePath, canonicalPath);
  for (const localVar of initVariables) {
    next = ensureNamedImportFromSource(next, importSource, "db", localVar);
  }
  return next;
}

function normalizeLocalMissingModuleImports(code: string, sourcePath: string, fileNames: Set<string>): string {
  IMPORT_WITH_FROM_PATTERN.lastIndex = 0;
  let cursor = 0;
  let nextCode = "";
  let changed = false;
  let match: RegExpExecArray | null;

  while ((match = IMPORT_WITH_FROM_PATTERN.exec(code)) !== null) {
    const [fullImport] = match;
    const importClause = (match[1] ?? "").trim();
    const specifier = (match[2] ?? "").trim();
    const start = match.index;
    const end = start + fullImport.length;
    nextCode += code.slice(cursor, start);
    cursor = end;

    if (!importClause || !specifier || !isLocalModuleSpecifier(specifier)) {
      nextCode += fullImport;
      continue;
    }

    const resolved = resolveLocalModulePath(sourcePath, specifier, fileNames);
    if (resolved) {
      nextCode += fullImport;
      continue;
    }

    const requestedBaseName = stripKnownCodeExtension(path.posix.basename(specifier));
    if (!requestedBaseName) {
      nextCode += fullImport;
      continue;
    }

    const candidates = Array.from(fileNames)
      .filter((name) => looksLikeCodeFile(name))
      .filter((name) => stripKnownCodeExtension(path.posix.basename(name)) === requestedBaseName);
    if (candidates.length !== 1) {
      nextCode += fullImport;
      continue;
    }

    const replacementSpecifier = toRelativeImportPath(sourcePath, candidates[0]);
    const quoteMatch = fullImport.match(/from\s*(["'`])/);
    const quote = quoteMatch?.[1] ?? "\"";
    nextCode += `import ${importClause} from ${quote}${replacementSpecifier}${quote}`;
    changed = true;
  }

  if (!changed) {
    return code;
  }
  nextCode += code.slice(cursor);
  return nextCode;
}

const LUCIDE_ICON_FALLBACK_MAP: Record<string, string> = {
  Pool: "Waves",
  Pools: "Waves",
};

const DEFAULT_LUCIDE_ICON_FALLBACK = "Circle";

function normalizeLucideMissingExportImports(code: string, missingExports: string[]): string {
  if (missingExports.length === 0) {
    return code;
  }

  let next = code;
  const uniqueMissingExports = Array.from(new Set(missingExports));
  for (const missingExport of uniqueMissingExports) {
    const fallback =
      LUCIDE_ICON_FALLBACK_MAP[missingExport] ??
      (missingExport === DEFAULT_LUCIDE_ICON_FALLBACK
        ? "Check"
        : DEFAULT_LUCIDE_ICON_FALLBACK);

    next = removeNamedImportsFromModule(next, "lucide-react", new Set([missingExport]));
    next = ensureNamedImportFromSource(next, "lucide-react", fallback, fallback);
    const usagePattern = new RegExp(`\\b${escapeRegex(missingExport)}\\b`, "g");
    next = next.replace(usagePattern, fallback);
  }
  return next;
}

function normalizeReactQueryPreviousDataGuards(code: string): string {
  const assignmentPattern =
    /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*queryClient\s*\.\s*getQueryData\s*\(([^)]*)\)\s*;?/g;

  return code.replace(
    assignmentPattern,
    (full, declarationKind: string, cacheVar: string, callArgs: string) => {
      const unsafePropertyRead = new RegExp(`\\b${cacheVar}\\.(?:holdings|items|rows|data)\\b`);
      const optionalPropertyRead = new RegExp(`\\b${cacheVar}\\?\\.(?:holdings|items|rows|data)\\b`);
      const nullishFallback = new RegExp(`\\b${cacheVar}\\s*\\?\\?`);
      const andGuard = new RegExp(`\\b${cacheVar}\\s*&&`);
      if (
        !unsafePropertyRead.test(code) ||
        optionalPropertyRead.test(code) ||
        nullishFallback.test(code) ||
        andGuard.test(code)
      ) {
        return full;
      }
      return `${declarationKind} ${cacheVar} = queryClient.getQueryData(${callArgs}) ?? { holdings: [], items: [], rows: [], data: [] };`;
    }
  );
}

function convertSqlQuestionPlaceholders(code: string): string {
  // Mechanical rewrite of SQLite-style `?` placeholders to PostgreSQL `$n`
  // inside `.query(<literal>, [...])` calls, mirroring exactly the sites
  // validatePglitePlaceholderStyle flags. `?` inside single-quoted SQL
  // string literals is left untouched.
  const queryLiteralPattern = /(\.query\s*\(\s*)([`'"])([\s\S]*?)\2(\s*,\s*\[)/g;
  return code.replace(queryLiteralPattern, (whole, pre: string, quote: string, sql: string, post: string) => {
    if (!/\b(select|insert|update|delete|create|alter|drop)\b/i.test(sql) || !/\?/.test(sql)) {
      return whole;
    }
    let counter = 0;
    let inSingleQuote = false;
    let rewritten = "";
    for (const ch of sql) {
      if (ch === "'") {
        inSingleQuote = !inSingleQuote;
        rewritten += ch;
      } else if (ch === "?" && !inSingleQuote) {
        counter += 1;
        rewritten += `$${counter}`;
      } else {
        rewritten += ch;
      }
    }
    return `${pre}${quote}${rewritten}${quote}${post}`;
  });
}

function normalizeSqlUpdateParamOrder(code: string): string {
  SQL_UPDATE_ID_VALUE_PARAM_ORDER_PATTERN.lastIndex = 0;
  return code.replace(
    SQL_UPDATE_ID_VALUE_PARAM_ORDER_PATTERN,
    (full, quote: string, table: string, firstParamRaw: string, secondParamRaw: string) => {
      const firstParam = (firstParamRaw ?? "").trim();
      const secondParam = (secondParamRaw ?? "").trim();
      const firstLower = firstParam.toLowerCase();
      const secondLower = secondParam.toLowerCase();
      const firstLooksId = /(^|[._])id$|(^|[._])holdingid$|(^|[._])assetid$/.test(firstLower) || /\bid\b/.test(firstLower);
      const secondLooksValue =
        /(amount|qty|quantity|price|value|cost|delta|change|new)/.test(secondLower) &&
        !/\bid\b/.test(secondLower);
      if (!firstLooksId || !secondLooksValue) {
        return full;
      }
      return full.replace(
        new RegExp(
          `\\[\\s*${escapeRegex(firstParam)}\\s*,\\s*${escapeRegex(secondParam)}\\s*\\]`
        ),
        `[${secondParam}, ${firstParam}]`
      );
    }
  );
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLocalIdentifierDeclaration(code: string, identifier: string): boolean {
  const declarationPattern = new RegExp(
    `\\b(?:const|let|var|function|class|interface|type|enum)\\s+${escapeRegex(identifier)}\\b`
  );
  return declarationPattern.test(code);
}

function hasImportedLocalIdentifier(code: string, identifier: string): boolean {
  const importPattern = /import\s+([\s\S]*?)\s+from\s*["'`][^"'`]+["'`]\s*;?/g;
  let match: RegExpExecArray | null;
  while ((match = importPattern.exec(code)) !== null) {
    const clause = (match[1] ?? "").trim();
    if (!clause) continue;
    if (clause === identifier) return true;
    if (new RegExp(`\\*\\s+as\\s+${escapeRegex(identifier)}\\b`).test(clause)) return true;
    if (parseDefaultImportSpecifier(clause) === identifier) return true;
    const namedEntries = parseNamedImportEntries(clause);
    if (namedEntries.some((entry) => entry.local === identifier)) {
      return true;
    }
  }
  return false;
}

function ensureNamedImportFromSource(
  code: string,
  source: string,
  importedName: string,
  localName: string
): string {
  const sourcePattern = new RegExp(
    `import\\s+([\\s\\S]*?)\\s+from\\s*([\"'\\\`])${escapeRegex(source)}\\2\\s*;?`
  );
  const matched = code.match(sourcePattern);
  if (!matched) {
    const importText =
      importedName === localName
        ? `import { ${importedName} } from "${source}";`
        : `import { ${importedName} as ${localName} } from "${source}";`;
    return injectImportStatement(code, importText);
  }

  const clause = (matched[1] ?? "").trim();
  if (!clause || clause.startsWith("*")) {
    const importText =
      importedName === localName
        ? `import { ${importedName} } from "${source}";`
        : `import { ${importedName} as ${localName} } from "${source}";`;
    return injectImportStatement(code, importText);
  }

  const namedEntries = parseNamedImportEntries(clause);
  const hasTarget = namedEntries.some(
    (entry) => entry.imported === importedName && entry.local === localName
  );
  if (hasTarget) {
    return code;
  }

  const defaultBinding = parseDefaultImportSpecifier(clause);
  const nextNamed = namedEntries.concat([{ imported: importedName, local: localName }]);
  const clauseParts: string[] = [];
  if (defaultBinding) {
    clauseParts.push(defaultBinding);
  }
  clauseParts.push(`{ ${formatNamedImportEntries(nextNamed)} }`);
  const rebuilt = `import ${clauseParts.join(", ")} from "${source}";`;
  return code.replace(sourcePattern, rebuilt);
}

function ensureDefaultImportFromSource(code: string, source: string, localName: string): string {
  const sourcePattern = new RegExp(
    `import\\s+([\\s\\S]*?)\\s+from\\s*([\"'\\\`])${escapeRegex(source)}\\2\\s*;?`
  );
  const matched = code.match(sourcePattern);
  if (!matched) {
    return injectImportStatement(code, `import ${localName} from "${source}";`);
  }

  const clause = (matched[1] ?? "").trim();
  if (!clause) {
    return injectImportStatement(code, `import ${localName} from "${source}";`);
  }
  if (parseDefaultImportSpecifier(clause)) {
    return code;
  }
  if (clause.startsWith("*")) {
    return injectImportStatement(code, `import ${localName} from "${source}";`);
  }

  const namedEntries = parseNamedImportEntries(clause);
  const rebuilt = namedEntries.length > 0
    ? `import ${localName}, { ${formatNamedImportEntries(namedEntries)} } from "${source}";`
    : `import ${localName} from "${source}";`;
  return code.replace(sourcePattern, rebuilt);
}

function normalizeMissingIdentifierImports(code: string, identifiers: string[]): string {
  let next = code;
  for (const identifier of identifiers) {
    const spec = DETERMINISTIC_IDENTIFIER_IMPORTS[identifier];
    if (!spec) continue;
    if (hasLocalIdentifierDeclaration(next, identifier)) continue;
    if (hasImportedLocalIdentifier(next, identifier)) continue;

    if (spec.kind === "named") {
      const importedName = spec.importedName ?? identifier;
      next = ensureNamedImportFromSource(next, spec.source, importedName, identifier);
    } else {
      next = ensureDefaultImportFromSource(next, spec.source, identifier);
    }
  }
  return next;
}

function dedupeLocalNamedExports(code: string): string {
  const declaredExports = new Set<string>();
  EXPORT_DECLARATION_PATTERN.lastIndex = 0;
  let declarationMatch: RegExpExecArray | null;
  while ((declarationMatch = EXPORT_DECLARATION_PATTERN.exec(code)) !== null) {
    const name = declarationMatch[1]?.trim();
    if (name) {
      declaredExports.add(name);
    }
  }

  const exportBlockPattern =
    /export\s*{\s*([^}]*)\s*}(?:\s*from\s*['"`][^'"`]+['"`])?\s*;?/g;

  return code.replace(exportBlockPattern, (fullMatch, rawSpecifiers: string) => {
    const hasFromClause = /}\s*from\s*['"`]/.test(fullMatch);
    const fromSuffix = hasFromClause
      ? fullMatch.slice(fullMatch.indexOf("}") + 1).trim()
      : "";

    const seenExportedNames = new Set<string>();
    const kept: string[] = [];

    for (const rawToken of rawSpecifiers.split(",")) {
      const token = rawToken.trim();
      if (!token) continue;
      const aliasMatch = token.match(
        /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/i
      );
      const localName = aliasMatch ? aliasMatch[1] : token;
      const exportedName = aliasMatch ? aliasMatch[2] : token;
      if (!localName || !exportedName) continue;

      if (seenExportedNames.has(exportedName)) {
        continue;
      }

      if (!hasFromClause && localName === exportedName && declaredExports.has(exportedName)) {
        continue;
      }

      seenExportedNames.add(exportedName);
      kept.push(aliasMatch ? `${localName} as ${exportedName}` : exportedName);
    }

    if (kept.length === 0) {
      return hasFromClause ? fullMatch : "";
    }

    if (hasFromClause) {
      return `export { ${kept.join(", ")} } ${fromSuffix}`;
    }
    return `export { ${kept.join(", ")} };`;
  });
}

export function generateDeterministicValidationFixOperations(
  files: GeneratedFile[],
  issues: ValidationIssue[]
): DeterministicFixPlan {
  let normalizedFiles: GeneratedFile[];
  try {
    normalizedFiles = normalizeGeneratedFiles(files);
  } catch {
    return { operations: [], attemptedIssueCodes: [], fixedIssueCodes: [] };
  }

  const fileMap = new Map<string, GeneratedFile>();
  for (const file of normalizedFiles) {
    fileMap.set(file.name, file);
  }

  const operations: FileOperation[] = [];
  const operationIndexByPath = new Map<string, number>();
  const attemptedIssueCodes = new Set<string>();
  const fixedIssueCodes = new Set<string>();
  const importContractTargets = new Set<string>();
  const transpileImportTargets = new Map<string, Set<string>>();

  const queueUpsertIfChanged = (targetPath: string, nextCode: string): boolean => {
    const normalizedPath = normalizePath(targetPath);
    const existing = fileMap.get(normalizedPath);
    if (!existing) return false;
    if (existing.code === nextCode) return false;

    const upsert: FileOperation = {
      op: "upsert",
      path: normalizedPath,
      code: nextCode,
      language: existing.language,
    };
    const existingIndex = operationIndexByPath.get(normalizedPath);
    if (typeof existingIndex === "number") {
      operations[existingIndex] = upsert;
    } else {
      operationIndexByPath.set(normalizedPath, operations.length);
      operations.push(upsert);
    }
    fileMap.set(normalizedPath, { ...existing, code: nextCode });
    return true;
  };

  const resolveIssueTargets = (
    issue: ValidationIssue,
    predicate: (file: GeneratedFile) => boolean
  ): GeneratedFile[] => {
    if (issue.file) {
      const normalizedPath = normalizePath(issue.file);
      const file = fileMap.get(normalizedPath);
      if (file && predicate(file)) {
        return [file];
      }
      return [];
    }
    return Array.from(fileMap.values()).filter(predicate);
  };

  const getExportsForFile = (
    filePath: string
  ): {
    names: Set<string>;
    hasExportAll: boolean;
    hasDefaultExport: boolean;
    duplicateNames: string[];
  } => {
    const source = fileMap.get(filePath);
    if (!source || !looksLikeCodeFile(source.name)) {
      return {
        names: new Set<string>(),
        hasExportAll: false,
        hasDefaultExport: false,
        duplicateNames: [],
      };
    }
    return parseModuleExports(source.code);
  };

  for (const issue of issues) {
    switch (issue.code) {
      case "tailwind.css_invalid_directive": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => CSS_FILE_PATTERN.test(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizeTailwindCssDirective(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "tailwind.css_invalid_apply_utility": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => CSS_FILE_PATTERN.test(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizeTailwindInvalidApplyUtilities(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "tailwind.css_apply_custom_class": {
        attemptedIssueCodes.add(issue.code);
        const classNames = Array.from(issue.message.matchAll(/`([A-Za-z_-][\w-]*)`/g))
          .map((match) => match[1])
          .filter(Boolean);
        const targets = resolveIssueTargets(issue, (file) => CSS_FILE_PATTERN.test(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizeTailwindApplyCustomClass(file.code, classNames))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "tailwind.postcss_plugin_legacy": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(
          issue,
          (file) => POSTCSS_CONFIG_FILE_PATTERN.test(file.name)
        );
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizePostcssTailwindPlugin(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "env.process_undefined_in_browser": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => isBrowserSourceFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, replaceProcessEnvAccess(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.multiple_initializers":
      case "pglite.init_in_ui_layer": {
        attemptedIssueCodes.add(issue.code);
        const initializerPaths = Array.from(fileMap.values())
          .filter((file) => looksLikeCodeFile(file.name) && PGLITE_INIT_CALL_PATTERN.test(file.code))
          .map((file) => normalizePath(file.name));
        const canonicalPath = pickCanonicalPgliteModulePath(initializerPaths);
        if (!canonicalPath) {
          break;
        }

        let changed = false;
        for (const initializerPath of initializerPaths) {
          if (initializerPath === canonicalPath) {
            continue;
          }
          const target = fileMap.get(initializerPath);
          if (!target) continue;
          if (!PGLITE_INIT_CALL_PATTERN.test(target.code)) continue;
          const nextCode = normalizeSecondaryPgliteInitializer(
            target.code,
            target.name,
            canonicalPath
          );
          if (queueUpsertIfChanged(target.name, nextCode)) {
            changed = true;
          }
        }

        const canonicalFile = fileMap.get(canonicalPath);
        if (canonicalFile) {
          const nextCanonical = ensureCanonicalPgliteDbExport(canonicalFile.code);
          if (queueUpsertIfChanged(canonicalFile.name, nextCanonical)) {
            changed = true;
          }
        }

        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.db_not_exported": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, ensureCanonicalPgliteDbExport(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.invalid_nested_export": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, ensureCanonicalPgliteDbExport(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.missing_column_migration_guard": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, ensurePgliteColumnMigrationGuard(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.query_object_signature_unsupported": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizePgliteQueryObjectSignature(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.wait_ready_invocation_invalid": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizePgliteWaitReadyInvocation(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.invalid_default_import": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizePgliteDefaultImport(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.vite_optimize_deps_missing": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(
          issue,
          (file) => VITE_CONFIG_FILE_PATTERN.test(file.name)
        );
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, ensureViteOptimizeDepsExclude(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "imports.missing_cva_import": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, ensureCvaImport(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "exports.duplicate_named_export": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, dedupeLocalNamedExports(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "r3f.missing_useframe_import": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, ensureUseFrameImport(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "router.multiple_providers": {
        attemptedIssueCodes.add(issue.code);
        const providerTargets = Array.from(fileMap.values()).filter(
          (file) => looksLikeCodeFile(file.name) && ROUTER_PROVIDER_PATTERN.test(file.code)
        );
        if (providerTargets.length <= 1) {
          break;
        }

        const canonicalOwner = pickCanonicalRouterOwner(providerTargets);
        if (!canonicalOwner) {
          break;
        }

        let changed = false;
        for (const target of providerTargets) {
          const targetPath = normalizePath(target.name);
          if (targetPath === canonicalOwner) {
            continue;
          }
          if (!ROUTER_WRAPPER_TAG_PATTERN.test(target.code)) {
            continue;
          }
          const nextCode = stripNestedRouterWrappers(target.code);
          if (queueUpsertIfChanged(target.name, nextCode)) {
            changed = true;
          }
        }

        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "react_query.missing_provider":
      case "react_query.provider_not_in_entrypoint": {
        attemptedIssueCodes.add(issue.code);
        const runtimeEntrypointPattern =
          /^(?:App|main|index)\.(?:js|jsx|ts|tsx)$|^(?:src\/)(?:App|main|index)\.(?:js|jsx|ts|tsx)$/;
        const runtimeTargets = Array.from(fileMap.values()).filter(
          (file) => runtimeEntrypointPattern.test(file.name)
        );
        const ownerPath = pickCanonicalQueryClientProviderOwner(runtimeTargets);
        const owner = ownerPath ? fileMap.get(ownerPath) : runtimeTargets[0];
        const changed = owner
          ? queueUpsertIfChanged(owner.name, ensureQueryClientProvider(owner.code))
          : false;
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "react_query.provider_scope_violation": {
        attemptedIssueCodes.add(issue.code);
        const providerTargets = Array.from(fileMap.values()).filter(
          (file) => looksLikeCodeFile(file.name) && REACT_QUERY_PROVIDER_PATTERN.test(file.code)
        );
        const runtimeEntrypointPattern =
          /^(?:App|main|index)\.(?:js|jsx|ts|tsx)$|^(?:src\/)(?:App|main|index)\.(?:js|jsx|ts|tsx)$/;
        const runtimeTargets = Array.from(fileMap.values()).filter(
          (file) => runtimeEntrypointPattern.test(file.name)
        );
        const canonicalOwner =
          pickCanonicalQueryClientProviderOwner(
            providerTargets.filter((file) => isRuntimeEntrypoint(normalizePath(file.name)))
          ) ??
          pickCanonicalQueryClientProviderOwner(runtimeTargets);

        let changed = false;
        for (const target of providerTargets) {
          const targetPath = normalizePath(target.name);
          if (canonicalOwner && targetPath === canonicalOwner) {
            continue;
          }
          const nextCode = stripNestedQueryClientProviders(target.code);
          if (queueUpsertIfChanged(target.name, nextCode)) {
            changed = true;
          }
        }

        if (canonicalOwner) {
          const ownerFile = fileMap.get(canonicalOwner);
          if (ownerFile) {
            const nextOwner = ensureQueryClientProvider(ownerFile.code);
            if (queueUpsertIfChanged(ownerFile.name, nextOwner)) {
              changed = true;
            }
          }
        }

        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "imports.local_missing_module": {
        attemptedIssueCodes.add(issue.code);
        const fileNames = new Set(Array.from(fileMap.keys()));
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(
            file.name,
            normalizeLocalMissingModuleImports(file.code, file.name, fileNames)
          )
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "imports.local_missing_default_export":
      case "imports.local_missing_export": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        for (const target of targets) {
          importContractTargets.add(target.name);
        }
        break;
      }
      case "imports.lucide_missing_export": {
        attemptedIssueCodes.add(issue.code);
        const missingIcons = Array.from(issue.message.matchAll(/"([A-Z][A-Za-z0-9_]*)"/g))
          .map((match) => match[1])
          .filter(Boolean);
        if (missingIcons.length === 0) {
          break;
        }
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizeLucideMissingExportImports(file.code, missingIcons))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "react_query.on_mutate_unsafe_previous_data": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizeReactQueryPreviousDataGuards(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "sql.update_param_order_likely_wrong": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, normalizeSqlUpdateParamOrder(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "pglite.sql_placeholder_style": {
        attemptedIssueCodes.add(issue.code);
        const targets = resolveIssueTargets(issue, (file) => looksLikeCodeFile(file.name));
        const changed = targets.some((file) =>
          queueUpsertIfChanged(file.name, convertSqlQuestionPlaceholders(file.code))
        );
        if (changed) fixedIssueCodes.add(issue.code);
        break;
      }
      case "transpile.error": {
        attemptedIssueCodes.add(issue.code);
        const identifierMatch = issue.message.match(CANNOT_FIND_NAME_PATTERN);
        const identifier = identifierMatch?.[1]?.trim();
        if (!identifier || !issue.file || !(identifier in DETERMINISTIC_IDENTIFIER_IMPORTS)) {
          break;
        }
        const normalizedPath = normalizePath(issue.file);
        const existing = transpileImportTargets.get(normalizedPath) ?? new Set<string>();
        existing.add(identifier);
        transpileImportTargets.set(normalizedPath, existing);
        break;
      }
      default:
        break;
    }
  }

  if (importContractTargets.size > 0) {
    const fileNames = new Set(Array.from(fileMap.keys()));
    let changedAnyImportContract = false;

    for (const targetPath of importContractTargets) {
      const target = fileMap.get(targetPath);
      if (!target) continue;
      const nextCode = normalizeLocalImportContractForFile(
        target.code,
        target.name,
        fileNames,
        getExportsForFile
      );
      if (queueUpsertIfChanged(target.name, nextCode)) {
        changedAnyImportContract = true;
      }
    }

    if (changedAnyImportContract) {
      if (attemptedIssueCodes.has("imports.local_missing_default_export")) {
        fixedIssueCodes.add("imports.local_missing_default_export");
      }
      if (attemptedIssueCodes.has("imports.local_missing_export")) {
        fixedIssueCodes.add("imports.local_missing_export");
      }
    }
  }

  if (transpileImportTargets.size > 0) {
    let changedAnyTranspileImports = false;
    for (const [targetPath, identifiers] of transpileImportTargets.entries()) {
      const target = fileMap.get(targetPath);
      if (!target || !looksLikeCodeFile(target.name)) continue;
      const nextCode = normalizeMissingIdentifierImports(
        target.code,
        Array.from(identifiers).sort((a, b) => a.localeCompare(b))
      );
      if (queueUpsertIfChanged(target.name, nextCode)) {
        changedAnyTranspileImports = true;
      }
    }
    if (changedAnyTranspileImports) {
      fixedIssueCodes.add("transpile.error");
    }
  }

  return {
    operations,
    attemptedIssueCodes: Array.from(attemptedIssueCodes).sort((a, b) => a.localeCompare(b)),
    fixedIssueCodes: Array.from(fixedIssueCodes).sort((a, b) => a.localeCompare(b)),
  };
}

export async function validateFinalWorkingTree(files: GeneratedFile[]): Promise<ValidationResult> {
  let normalized: GeneratedFile[];
  try {
    normalized = normalizeGeneratedFiles(files);
  } catch (error) {
    return {
      files: files,
      issues: [
        {
          code: "files.invalid",
          message: error instanceof Error ? error.message : "Unknown file normalization error",
        },
      ],
      runtimeDiagnostics: [
        error instanceof Error ? error.message : "File normalization failed.",
      ],
      importClassification: {
        serverOnlyImports: [],
        browserCompatibleImports: [],
      },
      previewRisk: {
        mode: "local",
        score: 100,
        reasons: [],
        blockers: [
          error instanceof Error
            ? error.message
            : "File normalization failed; check project structure.",
        ],
      },
    };
  }

  const issues: ValidationIssue[] = [];

  const routingIssues = validateRouteSemantics(normalized);
  issues.push(...routingIssues);

  const entryPointIssues = validateEntryPointSemantics(normalized);
  issues.push(...entryPointIssues);

  const reactThreeIssues = validateReactThreeFiberSemantics(normalized);
  issues.push(...reactThreeIssues);

  const hookIssues = await validateReactHookRules(normalized);
  issues.push(...hookIssues);

  const reactQueryProviderIssues = validateReactQueryProviderSemantics(normalized);
  issues.push(...reactQueryProviderIssues);

  const reactQueryIssues = validateReactQueryDataAccess(normalized);
  issues.push(...reactQueryIssues);

  const reactQueryOptimisticIssues = validateReactQueryOptimisticUpdates(normalized);
  issues.push(...reactQueryOptimisticIssues);

  const sqlParamOrderIssues = validateSqlUpdateParamOrder(normalized);
  issues.push(...sqlParamOrderIssues);

  const assetIssues = validateProjectAssets(normalized);
  issues.push(...assetIssues);

  const starterTemplateIssues = validateStarterTemplatePlaceholder(normalized);
  issues.push(...starterTemplateIssues);

  const browserEnvIssues = validateBrowserEnvSemantics(normalized);
  issues.push(...browserEnvIssues);

  const nativeDialogIssues = validateNativeDialogUsage(normalized);
  issues.push(...nativeDialogIssues);

  const cvaImportIssues = validateCvaImportSemantics(normalized);
  issues.push(...cvaImportIssues);

  const importClassification = classifyImports(normalized);
  for (const specifier of importClassification.serverOnlyImports) {
    issues.push({
      code: "imports.server_only",
      message: `Server-only import is not browser-compatible: ${specifier}`,
    });
  }

  const transpileIssues = await validateTranspile(normalized);
  issues.push(...transpileIssues);

  const dependencyIssues = validateDeclaredDependencies(normalized);
  issues.push(...dependencyIssues);

  const localImportContractIssues = validateLocalModuleContracts(normalized);
  issues.push(...localImportContractIssues);

  const tailwindPostcssIssues = validateTailwindPostcssCompatibility(normalized);
  issues.push(...tailwindPostcssIssues);

  const tailwindCssIssues = validateTailwindCssSemantics(normalized);
  issues.push(...tailwindCssIssues);

  const pgliteResilienceIssues = validatePgliteResilience(normalized);
  issues.push(...pgliteResilienceIssues);

  const pgliteQuerySignatureIssues = validatePgliteQuerySignatures(normalized);
  issues.push(...pgliteQuerySignatureIssues);

  const pgliteQueryResultShapeIssues = validatePgliteQueryResultShape(normalized);
  issues.push(...pgliteQueryResultShapeIssues);

  const pgliteSqlDialectIssues = validatePgliteSqlDialect(normalized);
  issues.push(...pgliteSqlDialectIssues);

  const pglitePlaceholderStyleIssues = validatePglitePlaceholderStyle(normalized);
  issues.push(...pglitePlaceholderStyleIssues);

  const previewRisk = analyzePreviewRisk({
    files: normalized,
    importClassification,
  });

  const runtimeDiagnostics = buildRuntimeDiagnostics(issues);

  return {
    files: normalized,
    issues,
    runtimeDiagnostics,
    importClassification,
    previewRisk,
  };
}

export async function validateWorkingTree(files: GeneratedFile[]): Promise<ValidationResult> {
  return validateFinalWorkingTree(files);
}

export function summarizeIssues(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => {
    if (issue.file) {
      return `${issue.file}: ${issue.message}`;
    }
    return issue.message;
  });
}

export function summarizeBlockingIssues(issues: ValidationIssue[]): string[] {
  return summarizeIssues(issues.filter(isBlockingValidationIssue));
}
