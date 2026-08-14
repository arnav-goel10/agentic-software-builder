// orchestrator/generators.ts — All LLM generation functions
import type { GeneratedFile } from "@/lib/server/types";
import type { ExecutionMode } from "@/lib/server/types";
import type {
    ConfiguredModelProvider,
    ProviderCallResult,
} from "@/lib/server/agent/model-provider";
import { callStructuredJsonWithFallback } from "@/lib/server/agent/model-provider";
import { normalizePath } from "@/lib/server/agent/validation";
import type {
    SpecResponse,
    PlanResponse,
    OperationResponse,
    QaResponse,
    SummaryResponse,
    ModelTrace,
    OperationResult,
    QaResult,
    FileContract,
    SkeletonFile,
    PlanOutlineResponse,
    SkeletonSpecDagResponse,
    SkeletonDagNode,
    FixDagResponse,
    FixDagTask,
} from "./types";
import {
    SPEC_SCHEMA,
    PLAN_OUTLINE_SCHEMA,
    OPERATIONS_SCHEMA,
    SUMMARY_SCHEMA,
    QA_SCHEMA,
    SKELETON_SPEC_DAG_SCHEMA,
    SKELETON_FILL_SCHEMA,
    SKELETON_REGION_FILL_SCHEMA,
    SKELETON_AUTOFIX_SCHEMA,
    FIX_DAG_SCHEMA,
} from "./schemas";
import { BASE_AGENT_SYSTEM_PROMPT } from "./prompts";
import type { TemplateDiversitySeed } from "./prompts";
import {
    toModelTrace,
    buildFileCatalog,
    buildRepoMapSummary,
    buildTaskContextPack,
    buildCoderFillDependencySources,
    buildCoderFillRelatedFilesSection,
    createWorkingTreeDigest,
    formatSpecForPrompt,
    pruneNoOpOperations,
} from "./context";
import { QA_CONTEXT_CHAR_BUDGET, CODER_FILL_CONTEXT_CHAR_BUDGET } from "./prompts";
import {
    normalizeSpecResponse,
    normalizePlanResponse,
    normalizeOperationResponse,
    normalizeQaResponse,
    normalizePlanOutlineResponse,
    normalizeSkeletonSpecDagResponse,
    normalizeFixDagResponse,
} from "./normalizers";
import {
    ARCHITECT_SYSTEM_PROMPT,
    PLAN_OUTLINE_SYSTEM_PROMPT,
    SCAFFOLD_SYSTEM_PROMPT,
    CODER_SYSTEM_PROMPT,
    REPAIR_SYSTEM_PROMPT,
    QA_SYSTEM_PROMPT,
    FINALIZE_SYSTEM_PROMPT,
} from "./prompts-specialized";
import {
    FRONTEND_DESIGN_SKILL_PROMPT,
    PGLITE_DATABASE_SKILL_PROMPT,
    SKELETON_CONTRACT_SKILL_PROMPT,
    shouldApplyFrontendDesignSkill,
    shouldApplyPgliteDatabaseSkill,
    resolveActiveSkills,
} from "./skills";

function formatDiversitySeed(seed?: TemplateDiversitySeed): string {
    if (!seed) {
        return "";
    }
    return [
        "Design diversity seed:",
        `- Typography: ${seed.typography}`,
        `- Color system: ${seed.colorSystem}`,
        `- Layout rhythm: ${seed.layoutRhythm}`,
        "Treat this as a direction, not a strict template copy.",
    ].join("\n");
}

function inferFileLanguageMode(pathName: string): "javascript" | "typescript" | "other" {
    if (/\.(?:jsx?|mjs|cjs)$/i.test(pathName)) {
        return "javascript";
    }
    if (/\.(?:tsx?|mts|cts)$/i.test(pathName)) {
        return "typescript";
    }
    return "other";
}

function buildFileLanguageManifest(paths: string[]): string {
    return paths
        .map((pathName) => {
            const mode = inferFileLanguageMode(pathName);
            if (mode === "javascript") {
                return `- ${pathName}: javascript (no TypeScript syntax)`;
            }
            if (mode === "typescript") {
                return `- ${pathName}: typescript`;
            }
            return `- ${pathName}: preserve existing syntax for this file type`;
        })
        .join("\n");
}

function isLocalImportSource(source: string): boolean {
    return source.startsWith(".") || source.startsWith("src/");
}

function buildSkeletonContractLockManifest(fileContracts: FileContract[]): string {
    return fileContracts
        .map((fileContract) => {
            const allowedImportSources =
                fileContract.imports.length > 0
                    ? fileContract.imports.map((imp) => imp.source).join(", ")
                    : "(none)";
            const requiredImportBindings =
                fileContract.imports.length > 0
                    ? fileContract.imports
                        .map((imp) => `${imp.source} => [${imp.names.join(", ")}]`)
                        .join("; ")
                    : "(none)";
            const allowedExternalSources = fileContract.imports
                .filter((imp) => !isLocalImportSource(imp.source))
                .map((imp) => imp.source);
            const requiredExports =
                fileContract.exports.length > 0
                    ? fileContract.exports
                        .map((exp) => `${exp.kind}:${exp.name} (${exp.signature})`)
                        .join("; ")
                    : "(none)";
            const hasDefaultExport = fileContract.exports.some((exp) => exp.kind === "default");
            const localImportPolicy = fileContract.imports
                .filter((imp) => isLocalImportSource(imp.source))
                .map((imp) => imp.source);
            const forbiddenRules = [
                "Do not add imports from sources not listed in ALLOWED_IMPORT_SOURCES.",
                "Do not add exports not listed in REQUIRED_EXPORTS.",
                hasDefaultExport
                    ? "Do not omit or rename the required default export."
                    : "Do not add a default export.",
                localImportPolicy.length > 0
                    ? `Do not import any other local files beyond: ${localImportPolicy.join(", ")}.`
                    : "Do not import local project files unless explicitly listed.",
                allowedExternalSources.length > 0
                    ? `Do not introduce external libraries beyond: ${allowedExternalSources.join(", ")}.`
                    : "Do not introduce external library imports.",
            ].join(" ");

            return [
                `[${fileContract.path}]`,
                `ALLOWED_IMPORT_SOURCES: ${allowedImportSources}`,
                `REQUIRED_IMPORT_BINDINGS: ${requiredImportBindings}`,
                `REQUIRED_EXPORTS: ${requiredExports}`,
                `FORBIDDEN_RULES: ${forbiddenRules}`,
            ].join("\n");
        })
        .join("\n\n");
}

type FillRegionDescriptor = {
    id: string;
    fullText: string;
    indent: string;
};

type RegionBodyItem = {
    regionId: string;
    body: string;
};

type RegionFillResponse = {
    summary: string;
    path: string;
    regions: RegionBodyItem[];
};

const FILL_REGION_BLOCK_PATTERN =
    /(^[ \t]*)\/\/\s*BEGIN_FILL:\s*([A-Za-z0-9_-]+)[^\n]*\n([\s\S]*?)^[ \t]*\/\/\s*END_FILL:\s*\2/gm;

function extractFillRegions(code: string): FillRegionDescriptor[] {
    const regions: FillRegionDescriptor[] = [];
    for (const match of code.matchAll(FILL_REGION_BLOCK_PATTERN)) {
        const id = (match[2] ?? "").trim();
        const fullText = match[0] ?? "";
        const indent = match[1] ?? "";
        if (!id || !fullText) continue;
        regions.push({ id, fullText, indent });
    }
    return regions;
}

function normalizeRegionBody(rawBody: string, regionId: string): string {
    let body = String(rawBody ?? "")
        .replace(/^```[A-Za-z0-9_-]*\s*\n?/g, "")
        .replace(/```$/g, "")
        .trim();

    const escapedRegionId = regionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrappedBlock = body.match(
        new RegExp(
            String.raw`\/\/\s*BEGIN_FILL:\s*${escapedRegionId}[^\n]*\n([\s\S]*?)\/\/\s*END_FILL:\s*${escapedRegionId}`,
            "m"
        )
    );
    if (wrappedBlock && typeof wrappedBlock[1] === "string") {
        body = wrappedBlock[1].trim();
    }

    return body;
}

function applyRegionBodiesToSkeleton(params: {
    baseCode: string;
    regionBodies: RegionBodyItem[];
    requiredRegionIds?: Set<string>;
}): { code: string; missingRegionIds: string[] } {
    const baseRegions = extractFillRegions(params.baseCode);
    const bodyById = new Map<string, string>();
    for (const region of params.regionBodies) {
        const id = region.regionId.trim();
        if (!id) continue;
        bodyById.set(id, normalizeRegionBody(region.body, id));
    }

    const missing: string[] = [];
    let nextCode = params.baseCode;
    for (const region of baseRegions) {
        if (params.requiredRegionIds && !params.requiredRegionIds.has(region.id)) {
            continue;
        }
        if (!bodyById.has(region.id)) {
            missing.push(region.id);
            continue;
        }
        const body = bodyById.get(region.id) ?? "";
        const indentedBody =
            body.length > 0
                ? body
                    .split(/\r?\n/g)
                    .map((line) => `${region.indent}${line}`)
                    .join("\n")
                : `${region.indent}// TODO: FILL_IN`;
        const replacement = `${region.indent}// BEGIN_FILL:${region.id}\n${indentedBody}\n${region.indent}// END_FILL:${region.id}`;
        nextCode = nextCode.replace(region.fullText, replacement);
    }

    return { code: nextCode, missingRegionIds: missing };
}

async function callStructuredJson<T>(input: {
    providers: ConfiguredModelProvider[];
    system: string | { text: string; cache?: boolean }[];
    userPrompt: string;
    schema: Record<string, unknown>;
    temperature?: number;
    onPartial?: (partial: Record<string, unknown>) => void;
    mockFixtureKey?: string;
    mockFixtureTarget?: string;
}): Promise<ProviderCallResult<T>> {
    return callStructuredJsonWithFallback<T>(input.providers, {
        providers: input.providers,
        systemInstruction: input.system,
        userPrompt: input.userPrompt,
        schema: input.schema,
        temperature: input.temperature,
        onPartial: input.onPartial,
        mockFixtureKey: input.mockFixtureKey,
        mockFixtureTarget: input.mockFixtureTarget,
    });
}

export async function generateSpec(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    threadContext: string;
    priorRunContext: string;
    files: GeneratedFile[];
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<{ spec: SpecResponse; trace: ModelTrace }> {
    const response = await callStructuredJson<SpecResponse>({
        providers: input.providers,
        system: [
            { text: BASE_AGENT_SYSTEM_PROMPT, cache: true },
            { text: "\nYou are in the specification phase. Use deep reasoning and derive a strict, testable implementation spec before planning." },
        ],
        schema: SPEC_SCHEMA,
        userPrompt: [
            "Create an implementation spec for this request.",
            `User request:\n${input.userPrompt}`,
            `Thread context:\n${input.threadContext || "(no prior context)"}`,
            `Prior run context:\n${input.priorRunContext}`,
            `Current files:\n${buildFileCatalog(input.files)}`,
            "Rules:",
            "- Make acceptance criteria concrete and testable.",
            "- Keep scope realistic for one run.",
            "- Include a practical test checklist.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "spec",
    });

    return {
        spec: normalizeSpecResponse(response.data, input.userPrompt),
        trace: toModelTrace(response),
    };
}

export async function generatePlanOutline(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    threadContext: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    executionMode?: ExecutionMode;
    diversitySeed?: TemplateDiversitySeed;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<{ plan: PlanOutlineResponse; trace: ModelTrace }> {
    const executionMode = input.executionMode ?? "feature_mode";
    const applyFrontendDesignSkill = shouldApplyFrontendDesignSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
    });
    const applyPgliteDatabaseSkill = shouldApplyPgliteDatabaseSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
    });

    const response = await callStructuredJson<PlanOutlineResponse>({
        providers: input.providers,
        system: [
            { text: PLAN_OUTLINE_SYSTEM_PROMPT, cache: true },
            {
                text:
                    "\nYou are in the plan-outline phase. Create a non-executing high-level DAG with task ids, dependencies, and taskWriteSet only.",
            },
        ],
        schema: PLAN_OUTLINE_SCHEMA,
        userPrompt: [
            "Create a planning outline for this request.",
            `User request:\n${input.userPrompt}`,
            `Thread context:\n${input.threadContext || "(no prior context)"}`,
            `Execution mode: ${executionMode}`,
            `Implementation spec:\n${formatSpecForPrompt(input.spec)}`,
            formatDiversitySeed(input.diversitySeed),
            applyFrontendDesignSkill ? FRONTEND_DESIGN_SKILL_PROMPT : "",
            applyPgliteDatabaseSkill ? PGLITE_DATABASE_SKILL_PROMPT : "",
            `Current files:\n${buildFileCatalog(input.files)}`,
            `Repository map summary:\n${buildRepoMapSummary(input.files)}`,
            "Rules:",
            "- Keep this outline planning-only. It will not execute directly.",
            "- Task titles/instructions should help later skeleton DAG generation.",
            "- Include meaningful dependsOn and exact taskWriteSet.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "plan_outline",
    });

    return {
        plan: normalizePlanOutlineResponse(response.data, input.userPrompt, { executionMode }),
        trace: toModelTrace(response),
    };
}

export async function generateQaVerdict(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    threadContext?: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    diversitySeed?: TemplateDiversitySeed;
    attempt: number;
    maxAttempts: number;
    validationIssues?: string[];
    runtimeDiagnostics?: string[];
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<QaResult> {
    const fullFileCatalog = buildFileCatalog(input.files);
    const fullTreeDigest = createWorkingTreeDigest(input.files, QA_CONTEXT_CHAR_BUDGET);

    const validationSection =
        input.validationIssues && input.validationIssues.length > 0
            ? `Validation issues (CRITICAL):\n${input.validationIssues.map((i) => `- ${i}`).join("\n")}`
            : "Validation issues:\n- (none)";
    const runtimeDiagnosticsSection =
        input.runtimeDiagnostics && input.runtimeDiagnostics.length > 0
            ? `Runtime diagnostics (terminal-style evidence):\n${input.runtimeDiagnostics
                .map((line) => `- ${line}`)
                .join("\n")}`
            : "Runtime diagnostics:\n- (none)";

    const response = await callStructuredJson<QaResponse>({
        providers: input.providers,
        system: [
            { text: QA_SYSTEM_PROMPT, cache: true },
            {
                text:
                    "\nYou are in the quality gate phase. Score quality against acceptance criteria and classify issues into hard blockers (objective run-breaking), soft blockers (advisory quality gaps), and warnings.",
            },
        ],
        schema: QA_SCHEMA,
        userPrompt: [
            `User request:\n${input.userPrompt}`,
            `Thread context:\n${input.threadContext || "(none)"}`,
            `Implementation spec:\n${formatSpecForPrompt(input.spec)}`,
            formatDiversitySeed(input.diversitySeed),
            `Final file catalog (authoritative):\n${fullFileCatalog}`,
            validationSection,
            runtimeDiagnosticsSection,
            "Final tree digest (expanded, truncated by budget):",
            fullTreeDigest,
            "Scoring guidance:",
            "- 90-100: production-ready and complete",
            "- 75-89: good with minor gaps",
            "- 60-74: partially complete",
            "- 0-59: major blockers",
            "Classify as hardBlockers ONLY when corroborated by Validation issues or Runtime diagnostics and the issue can crash runtime/build or prevent app boot/critical interaction.",
            "If not corroborated by deterministic evidence, classify as softBlockers or warnings (never hardBlockers).",
            "Treat UX/polish/design/completeness gaps as softBlockers unless they directly break build/runtime.",
            "Do not classify missing optional enhancements as hardBlockers.",
            "Do NOT mark a file as missing if it appears in the final file catalog.",
            "If content visibility is limited by truncation, treat as warning (insufficient visibility), not hard blocker.",
            "Use softBlockers for missing features/polish gaps that do not crash execution.",
            "Penalize score heavily if validation issues are present.",
            `Set attempt to ${input.attempt} and maxAttempts to ${input.maxAttempts}.`,
            "Set blockingDecision to one of: pass | remediate | fail_no_improvement | fail_max_passes | fail.",
            "If there are no corroborated hardBlockers, set blockingDecision to pass.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "qa",
    });

    return {
        qa: normalizeQaResponse(response.data, input.spec.acceptanceCriteria),
        trace: toModelTrace(response),
    };
}

export async function generateQaFixOperations(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    threadContext?: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    qa: QaResponse;
    diversitySeed?: TemplateDiversitySeed;
    validationIssues?: string[];
    runtimeDiagnostics?: string[];
    additionalInstructions?: string;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<OperationResult> {
    const hardBlockerText = input.qa.hardBlockers.length
        ? input.qa.hardBlockers.map((item) => `- ${item}`).join("\n")
        : "- (none)";
    const softBlockerText = input.qa.softBlockers.length
        ? input.qa.softBlockers.map((item) => `- ${item}`).join("\n")
        : "- (none)";
    const fixText = input.qa.suggestedFixes?.length
        ? input.qa.suggestedFixes.map((item) => `- ${item}`).join("\n")
        : "- (none)";
    const validationText =
        input.validationIssues && input.validationIssues.length > 0
            ? input.validationIssues.map((item) => `- ${item}`).join("\n")
            : "- (none)";
    const runtimeText =
        input.runtimeDiagnostics && input.runtimeDiagnostics.length > 0
            ? input.runtimeDiagnostics.map((item) => `- ${item}`).join("\n")
            : "- (none)";

    const taskInstructions = [
        "Close blocker gaps from QA while preserving existing functionality.",
        `Current QA score: ${input.qa.score}`,
        `Validation issues (MUST FIX):\n${validationText}`,
        `Runtime diagnostics (MUST ADDRESS if relevant):\n${runtimeText}`,
        `QA model-reported hard blockers (ADVISORY unless corroborated by validation/runtime diagnostics):\n${hardBlockerText}`,
        `QA soft blockers (advisory):\n${softBlockerText}`,
        `Suggested fixes:\n${fixText}`,
    ].join("\n\n");

    // Context: hard blockers + relevance-ranked relevant file sources, via
    // the same context pack machinery used by the plan-execution generators.
    const context = buildTaskContextPack({
        files: input.files,
        userPrompt: input.userPrompt,
        planSummary: "Quality-gate remediation",
        taskTitle: "Quality gate fixes",
        taskInstructions,
    });

    const applyFrontendDesignSkill = shouldApplyFrontendDesignSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
        additionalInstructions: input.additionalInstructions,
    });
    const applyPgliteDatabaseSkill = shouldApplyPgliteDatabaseSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
        additionalInstructions: input.additionalInstructions,
    });

    const response = await callStructuredJson<OperationResponse>({
        providers: input.providers,
        system: [
            { text: QA_SYSTEM_PROMPT, cache: true },
            {
                text:
                    "\nYou are in the QA repair phase. Return only targeted file operations that close hard-blocker gaps from the quality gate while preserving existing functionality.",
            },
        ],
        schema: OPERATIONS_SCHEMA,
        userPrompt: [
            `User request:\n${input.userPrompt}`,
            `Thread context:\n${input.threadContext || "(none)"}`,
            `Implementation spec:\n${formatSpecForPrompt(input.spec)}`,
            `Task:\nQuality gate fixes\n${taskInstructions}`,
            formatDiversitySeed(input.diversitySeed),
            applyFrontendDesignSkill ? FRONTEND_DESIGN_SKILL_PROMPT : "",
            applyPgliteDatabaseSkill ? PGLITE_DATABASE_SKILL_PROMPT : "",
            input.additionalInstructions ? `Additional instructions:\n${input.additionalInstructions}` : "",
            `All files:\n${context.fileCatalog}`,
            `Repository map summary:\n${context.repoMapSummary}`,
            `Focused files used as context:\n${context.selectedNames.map((name) => `- ${name}`).join("\n")}`,
            "Focused working tree (truncated):",
            context.treeDigest,
            "Rules:",
            "- Focus ONLY on validation errors, runtime diagnostics, and corroborated hard blockers that can break build/runtime.",
            "- Treat soft blockers as advisory; do not spend operations on polish-only changes during remediation.",
            "- Use upsert to create/update files; use delete to remove obsolete files.",
            "- Use json_manifest_update only for non-engine-owned JSON files when a targeted JSON merge is safer than full rewrite.",
            "- json_manifest_update path MUST end with .json. Never use json_manifest_update for .js/.jsx/.ts/.tsx/.css/.html files.",
            "- Return the smallest set of operations needed to resolve the listed blockers.",
            "- Do not rewrite unchanged files.",
            "- Match file language by extension; never add TypeScript syntax to .js/.jsx/.mjs/.cjs files.",
            "- If you introduce a new local import path, include operation(s) that create/update that imported local module in the same response.",
            "- Never call hook-like functions (names starting with use) inside callbacks, loops, conditionals, or nested functions.",
            "- NEVER use window.alert/window.prompt/window.confirm. Use in-app modal or controlled UI state instead.",
            "- If backend/persistence/auth logic is touched, keep it on @electric-sql/pglite only.",
            "- Do not introduce Supabase/Firebase/Appwrite/Express/remote backend services.",
            "- Do not emit operations that modify package.json.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "qa_fix",
    });

    const normalized = normalizeOperationResponse(response.data);
    const prunedOperations = pruneNoOpOperations(input.files, normalized.operations);
    return {
        summary: normalized.summary,
        operations: prunedOperations,
        trace: toModelTrace(response),
        contextFiles: context.selectedNames,
    };
}

// ─── Skeleton-First Architecture: Generator Functions ────────────

export async function generateSkeletonSpecDag(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    threadContext: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    planOutline: PlanOutlineResponse;
    diversitySeed?: TemplateDiversitySeed;
    executionMode?: ExecutionMode;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<{ dag: SkeletonSpecDagResponse; trace: ModelTrace }> {
    const executionMode = input.executionMode ?? "feature_mode";
    const applyFrontendDesignSkill = shouldApplyFrontendDesignSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
    });
    const applyPgliteDatabaseSkill = shouldApplyPgliteDatabaseSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
    });

    const response = await callStructuredJson<SkeletonSpecDagResponse>({
        providers: input.providers,
        system: [
            { text: ARCHITECT_SYSTEM_PROMPT, cache: true },
            {
                text: `\nYou are in the SKELETON_DAG phase. Build a file-level DAG for skeleton generation.

Requirements:
- Output both high-level planning tasks and file-level nodes.
- The DAG MUST include a src/App.jsx node: the root application component. src/main.jsx already exists, is system-owned, and renders the default export of src/App.jsx, so every UI you plan must compose up into src/App.jsx.
- NEVER plan nodes for system-owned files: package.json, vite.config.js, postcss.config.js, tailwind.config.js, index.html, src/main.jsx, src/index.css. They already exist and cannot be edited.
- Each node MUST include path, purpose, imports, exports, externalLibraries, dependsOnPaths.
- Use exact export signatures and import names.
- If a node path ends with .js/.jsx/.mjs/.cjs, signatures MUST be JavaScript-style (no TypeScript annotation syntax).
- Include routeOwnership for route/page files.
- Include dbQueries for DB-access files.
- Keep dependsOnPaths topologically valid (file-to-file dependencies only).`,
            },
        ],
        schema: SKELETON_SPEC_DAG_SCHEMA,
        userPrompt: [
            "Create a strict skeleton DAG spec for this request.",
            `User request:\n${input.userPrompt}`,
            `Thread context:\n${input.threadContext || "(no prior context)"}`,
            `Execution mode: ${executionMode}`,
            `Implementation spec:\n${formatSpecForPrompt(input.spec)}`,
            `Plan outline:\n${JSON.stringify(input.planOutline, null, 2)}`,
            formatDiversitySeed(input.diversitySeed),
            applyFrontendDesignSkill ? FRONTEND_DESIGN_SKILL_PROMPT : "",
            applyPgliteDatabaseSkill ? PGLITE_DATABASE_SKILL_PROMPT : "",
            `Current files:\n${buildFileCatalog(input.files)}`,
            `Repository map summary:\n${buildRepoMapSummary(input.files)}`,
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "skeleton_dag",
    });

    return {
        dag: normalizeSkeletonSpecDagResponse(response.data, input.userPrompt),
        trace: toModelTrace(response),
    };
}

/**
 * Generates skeleton code files from architect file contracts.
 * Each skeleton contains imports, exports, function signatures, and
 * TODO: FILL_IN markers for the coder model to complete.
 * This is Phase ③ of the skeleton-first pipeline.
 */
export async function generateSkeletonFiles(input: {
    providers: ConfiguredModelProvider[];
    fileContracts: FileContract[];
    dbSchema?: string;
    spec: SpecResponse;
    userPrompt: string;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<{ skeletons: SkeletonFile[]; trace: ModelTrace }> {
    const skills = resolveActiveSkills({
        userPrompt: input.userPrompt,
        spec: input.spec,
        fileContracts: input.fileContracts,
        pipelinePhase: "skeleton-files",
    });
    const languageManifest = buildFileLanguageManifest(
        input.fileContracts.map((contract) => contract.path)
    );
    const skeletonContractLocks = buildSkeletonContractLockManifest(input.fileContracts);
    const contractManifest = input.fileContracts.map((fc) => ({
        path: fc.path,
        purpose: fc.purpose,
        imports: fc.imports,
        exports: fc.exports.map((e) => `${e.kind} ${e.name}: ${e.signature} — ${e.description}`),
        dbQueries: fc.dbQueries?.map((q) => `${q.operation} ${q.table}: ${q.description}`) ?? [],
    }));

    const response = await callStructuredJson<OperationResponse>({
        providers: input.providers,
        system: [
            { text: SCAFFOLD_SYSTEM_PROMPT, cache: true },
            {
                text: `\nYou are in the SCAFFOLD phase. Generate skeleton code files with function stubs.

RULES:
- For each file contract, emit an "upsert" operation with the file's skeleton code.
- Write ALL import statements exactly as specified in the contract.
- Write ALL export statements with exact names and kinds from the contract.
- For .js/.jsx/.mjs/.cjs files, DO NOT emit TypeScript syntax even if signature text contains types.
- For .ts/.tsx/.mts/.cts files, TypeScript syntax is allowed.
- Write JSDoc/docstring comments describing what each function should do, including:
  - Which APIs to call and how
  - Which data structures to use
  - Edge cases to handle
  - Database queries to execute (if any)
- Write function BODIES as: // TODO: FILL_IN
- Every stubbed function/component body MUST be wrapped by structure lock markers:
  // BEGIN_FILL:<stable-id>
  // TODO: FILL_IN
  // END_FILL:<stable-id>
- The skeleton MUST be syntactically valid (parseable by esbuild). Only the function bodies are stubs.
- Do NOT add any functionality beyond what the contract specifies.
- Do NOT create extra exports not in the contract.
- For React components, include the full JSX structure outline in comments above the TODO marker.
- Follow per-file contract locks exactly (ALLOWED_IMPORT_SOURCES, REQUIRED_IMPORT_BINDINGS, REQUIRED_EXPORTS, FORBIDDEN_RULES).
- Before each BEGIN_FILL region, add a "Skeleton Contract" comment block:
  - Inputs
  - Outputs
  - Allowed dependencies
  - Forbidden changes
  - Edge cases / failure modes.`,
            },
        ],
        schema: SKELETON_FILL_SCHEMA,
        userPrompt: [
            "Generate skeleton files for the following file contracts.",
            `User request:\n${input.userPrompt}`,
            `Spec summary:\n${input.spec.summary}`,
            input.dbSchema ? `Database schema:\n${input.dbSchema}` : "",
            skills.skillsPromptBlock,
            `File language modes:\n${languageManifest}`,
            `File contracts:\n${JSON.stringify(contractManifest, null, 2)}`,
            `Per-file contract locks:\n${skeletonContractLocks}`,
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "scaffold",
        mockFixtureTarget: input.fileContracts[0]?.path,
    });

    // Build dependency map for cross-file contract context
    const contractsByPath = new Map(input.fileContracts.map((fc) => [fc.path, fc]));
    const skeletons: SkeletonFile[] = response.data.operations
        .filter((op): op is { op: "upsert"; path: string; code: string } => op.op === "upsert" && "code" in op)
        .map((op) => {
            const fc = contractsByPath.get(op.path);
            const depContracts: FileContract[] = fc?.imports
                .map((imp) => {
                    // Resolve relative imports to find the contract
                    const candidates = input.fileContracts.filter((c) =>
                        c.path.endsWith(imp.source.replace(/^\.\.?\/?/, "").replace(/^src\//, ""))
                        || c.path === imp.source
                        || c.path === `src/${imp.source}`
                    );
                    return candidates[0];
                })
                .filter(Boolean) as FileContract[] ?? [];

            return {
                path: op.path,
                skeleton: op.code,
                dependencyContracts: depContracts,
            };
        });

    return {
        skeletons,
        trace: toModelTrace(response),
    };
}

export async function generateSkeletonFile(input: {
    providers: ConfiguredModelProvider[];
    node: SkeletonDagNode;
    allContracts: FileContract[];
    dbSchema?: string;
    spec: SpecResponse;
    userPrompt: string;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<{ skeleton: SkeletonFile; trace: ModelTrace }> {
    const matchedContract =
        input.allContracts.find((contract) => contract.path === input.node.path) ?? {
            path: input.node.path,
            purpose: input.node.purpose,
            imports: input.node.imports,
            exports: input.node.exports,
            ...(input.node.dbQueries ? { dbQueries: input.node.dbQueries } : {}),
        };
    const nodeConstraintNotes = [
        `Skeleton DAG node constraints for ${input.node.path}:`,
        `- routeOwnership: ${input.node.routeOwnership?.trim() || "(none)"}`,
        `- externalLibraries: ${input.node.externalLibraries.length > 0 ? input.node.externalLibraries.join(", ") : "(none)"}`,
        `- dependsOnPaths: ${input.node.dependsOnPaths.length > 0 ? input.node.dependsOnPaths.join(", ") : "(none)"}`,
    ].join("\n");
    const batch = await generateSkeletonFiles({
        providers: input.providers,
        fileContracts: [matchedContract],
        dbSchema: input.dbSchema,
        spec: input.spec,
        userPrompt: `${input.userPrompt}\n\n${nodeConstraintNotes}`,
        onPartial: input.onPartial,
    });
    const skeleton =
        batch.skeletons[0] ??
        ({
            path: input.node.path,
            skeleton: "",
            dependencyContracts: [],
        } satisfies SkeletonFile);
    return { skeleton, trace: batch.trace };
}

export async function generateSkeletonAutofix(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    issues: string[];
    fileContracts: FileContract[];
}): Promise<OperationResult> {
    const skills = resolveActiveSkills({
        userPrompt: input.userPrompt,
        spec: input.spec,
        fileContracts: input.fileContracts,
        pipelinePhase: "skeleton-autofix",
    });
    const languageManifest = buildFileLanguageManifest(
        input.fileContracts.map((contract) => contract.path)
    );
    const skeletonContractLocks = buildSkeletonContractLockManifest(input.fileContracts);
    const response = await callStructuredJson<OperationResponse>({
        providers: input.providers,
        system: [
            { text: SCAFFOLD_SYSTEM_PROMPT, cache: true },
            {
                text:
                    "\nYou are in skeleton-autofix phase. Apply targeted upserts to repair skeleton contract violations without adding runtime logic.",
            },
        ],
        schema: SKELETON_AUTOFIX_SCHEMA,
        userPrompt: [
            `User request:\n${input.userPrompt}`,
            `Spec summary:\n${input.spec.summary}`,
            skills.skillsPromptBlock,
            `Skeleton issues:\n${input.issues.map((issue) => `- ${issue}`).join("\n")}`,
            `File language modes:\n${languageManifest}`,
            `File contracts:\n${JSON.stringify(input.fileContracts, null, 2)}`,
            `Per-file contract locks:\n${skeletonContractLocks}`,
            `Current files:\n${buildFileCatalog(input.files)}`,
            "Rules:",
            "- Only upsert files with issues.",
            "- CRITICAL: You MUST wrap all generated function/component bodies with `// BEGIN_FILL:<stable-id>` and `// END_FILL:<stable-id>`. The body inside MUST just be `// TODO: FILL_IN`.",
            "- If a file is missing BEGIN_FILL/END_FILL markers, immediately recreate them for all functions.",
            "- If an issue says 'missing route ownership structure', ensure the file has an `export default` component OR renders `<RouterProvider>` / `<BrowserRouter>` if it's the root app.",
            "- Keep imports/exports/signatures aligned with contracts.",
            "- Respect ALLOWED_IMPORT_SOURCES/REQUIRED_IMPORT_BINDINGS/REQUIRED_EXPORTS exactly; do not add non-contract public API.",
            "- FIX UNRESOLVED LOCAL IMPORTS: If an issue says 'unresolved local import', absolutely remove that import statement or correct its path to point to a valid contract file.",
            "- FIX MISSING IMPORTS: If an issue says 'is missing import from X' or 'missing symbol Y', you MUST add that exact import statement to the top of the file. Fix any syntax typos (e.g. missing commas like 'useCallbackuseState' -> 'useCallback, useState').",
            "- CRITICAL RULE OVERRIDE: The system prompt says 'ALLOW ONLY imports explicitly listed in the file contract'. You are in the AUTOFIX phase aiming to ALIGN the file with the contract. If the validation issue says an import is missing, it MEANS it is in the contract. You MUST add it.",
            "- Match file language by extension; never add TypeScript syntax to .js/.jsx/.mjs/.cjs files.",
            "- Do not add runtime behavior beyond stubbed TODO regions.",
        ].join("\n\n"),
        mockFixtureKey: "skeleton_autofix",
    });

    const normalized = normalizeOperationResponse(response.data);
    return {
        summary: normalized.summary,
        operations: normalized.operations,
        trace: toModelTrace(response),
        contextFiles: normalized.operations.map((op) => op.path),
    };
}

/**
 * Fills in a skeleton file's function bodies using a fast model.
 * This is Phase ④ of the skeleton-first pipeline.
 * Designed to be called in parallel for all skeleton files.
 */
export async function generateCoderFill(input: {
    providers: ConfiguredModelProvider[];
    skeleton: SkeletonFile;
    allContracts: FileContract[];
    workingFiles: GeneratedFile[];
    dbSchema?: string;
    spec: SpecResponse;
    userPrompt: string;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<OperationResult> {
    const skills = resolveActiveSkills({
        userPrompt: input.userPrompt,
        spec: input.spec,
        fileContracts: input.allContracts,
        pipelinePhase: "coder-fill",
    });
    const targetPath = normalizePath(input.skeleton.path);
    const fileLanguageMode = buildFileLanguageManifest([input.skeleton.path]);

    const ownContract = input.allContracts.find((contract) => {
        try {
            return normalizePath(contract.path) === targetPath;
        } catch {
            return false;
        }
    });
    const purpose = ownContract?.purpose ?? "";
    const contractSummary = ownContract
        ? [
            `Imports: ${ownContract.imports.map((imp) => imp.source).join(", ") || "(none)"}`,
            `Exports: ${ownContract.exports.map((exp) => `${exp.kind} ${exp.name}`).join(", ") || "(none)"}`,
        ].join("\n")
        : "";

    // Coder-fill context enrichment: (a) full source of direct dependency
    // skeletons within budget, (b) relevance-ranked related files for
    // whatever budget remains, (c) a cheap export-signature digest for any
    // dependency that didn't fit in (a). See orchestrator/context.ts.
    const dependencySources = buildCoderFillDependencySources({
        targetPath,
        dependencyContracts: input.skeleton.dependencyContracts,
        workingFiles: input.workingFiles,
        charBudget: CODER_FILL_CONTEXT_CHAR_BUDGET,
    });
    const relatedFilesSection = buildCoderFillRelatedFilesSection({
        targetPath,
        purpose,
        contractSummary,
        workingFiles: input.workingFiles,
        excludePaths: new Set([targetPath, ...dependencySources.coveredPaths]),
        charBudget: dependencySources.remainingBudget,
    });
    const otherSignaturesSection = input.skeleton.dependencyContracts
        .filter((dep) => {
            let depPath: string;
            try {
                depPath = normalizePath(dep.path);
            } catch {
                return false;
            }
            return depPath !== targetPath && !dependencySources.coveredPaths.has(depPath);
        })
        .map((dep) => {
            const exports = dep.exports.map((e) => `  export ${e.kind} ${e.name}: ${e.signature}`).join("\n");
            return `// ${dep.path}\n${exports}`;
        })
        .join("\n\n");

    const response = await callStructuredJson<RegionFillResponse>({
        providers: input.providers,
        system: [
            {
                text: CODER_SYSTEM_PROMPT,
                cache: true,
            },
        ],
        schema: SKELETON_REGION_FILL_SCHEMA,
        userPrompt: [
            `Fill in ALL TODO: FILL_IN markers in this skeleton file.`,
            `File path: ${input.skeleton.path}`,
            `User request context: ${input.userPrompt}`,
            `Spec summary: ${input.spec.summary}`,
            skills.skillsPromptBlock,
            `File language mode:\n${fileLanguageMode}`,
            input.dbSchema ? `Database schema:\n${input.dbSchema}` : "",
            dependencySources.section ? `Dependency sources:\n${dependencySources.section}` : "",
            relatedFilesSection ? `Related files:\n${relatedFilesSection}` : "",
            otherSignaturesSection ? `Other signatures:\n${otherSignaturesSection}` : "",
            `Skeleton code:\n\`\`\`\n${input.skeleton.skeleton}\n\`\`\``,
            "STRICT RULES:",
            "- Return ONLY region bodies (not full file code).",
            "- The response path MUST match the file path exactly.",
            "- Include one region entry for every BEGIN_FILL id in the skeleton.",
            "- Do not include BEGIN_FILL/END_FILL markers inside region body values.",
            "- Only edit content inside BEGIN_FILL/END_FILL regions.",
            "- Do not change imports, exports, signatures, routes, or library wiring.",
            "- Match file language by extension; never add TypeScript syntax to .js/.jsx/.mjs/.cjs files.",
            "- For PGlite db.query results, normalize to rows array before map/reduce/filter. Never assume query result is always an array.",
            "- Preserve region intent and ensure valid syntax when merged back into the skeleton.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "coder",
        mockFixtureTarget: targetPath,
    });

    const responsePath = normalizePath(response.data.path || targetPath);
    if (responsePath !== targetPath) {
        throw new Error(`Fill response path mismatch: expected ${targetPath}, got ${responsePath}`);
    }

    const regionBodies = Array.isArray(response.data.regions)
        ? response.data.regions
            .map((region) => ({
                regionId: typeof region?.regionId === "string" ? region.regionId.trim() : "",
                body: typeof region?.body === "string" ? region.body : "",
            }))
            .filter((region) => region.regionId.length > 0)
        : [];

    if (regionBodies.length === 0) {
        throw new Error(`Fill response did not return any region bodies for ${targetPath}`);
    }

    const requiredRegionIds = new Set(extractFillRegions(input.skeleton.skeleton).map((region) => region.id));
    const applied = applyRegionBodiesToSkeleton({
        baseCode: input.skeleton.skeleton,
        regionBodies,
        requiredRegionIds,
    });

    if (applied.missingRegionIds.length > 0) {
        throw new Error(
            `Fill response omitted required regions: ${applied.missingRegionIds.slice(0, 4).join(", ")}`
        );
    }

    return {
        summary: response.data.summary,
        operations: [{
            op: "upsert",
            path: targetPath,
            code: applied.code,
        }],
        trace: toModelTrace(response),
        contextFiles: [targetPath],
        lengthFinishSignals: response.diagnostics?.lengthFinishSignals ?? 0,
    };
}

export async function generateFillForSkeleton(input: {
    providers: ConfiguredModelProvider[];
    skeleton: SkeletonFile;
    allContracts: FileContract[];
    workingFiles: GeneratedFile[];
    dbSchema?: string;
    spec: SpecResponse;
    userPrompt: string;
    maxAttempts?: number;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<OperationResult> {
    const maxAttempts = Math.max(1, input.maxAttempts ?? 2);
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await generateCoderFill({
                providers: input.providers,
                skeleton: input.skeleton,
                allContracts: input.allContracts,
                workingFiles: input.workingFiles,
                dbSchema: input.dbSchema,
                spec: input.spec,
                userPrompt: input.userPrompt,
                onPartial: input.onPartial,
            });
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
            const transient =
                message.includes("timeout") ||
                message.includes("429") ||
                message.includes("rate limit") ||
                message.includes("temporarily unavailable") ||
                message.includes("503");
            if (!transient || attempt >= maxAttempts) {
                break;
            }
            const delayMs = attempt * 400;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "fill generation failed"));
}

export async function generateMissingFillRegions(input: {
    providers: ConfiguredModelProvider[];
    skeleton: SkeletonFile;
    candidateCode: string;
    missingRegionIds: string[];
    userPrompt: string;
    spec: SpecResponse;
}): Promise<OperationResult> {
    const skills = resolveActiveSkills({
        userPrompt: input.userPrompt,
        spec: input.spec,
        pipelinePhase: "missing-fill-regions",
    });
    const targetPath = normalizePath(input.skeleton.path);
    const requiredRegionIds = new Set(
        input.missingRegionIds.map((id) => id.trim()).filter(Boolean)
    );

    const response = await callStructuredJson<RegionFillResponse>({
        providers: input.providers,
        system: [
            {
                text: CODER_SYSTEM_PROMPT,
                cache: true,
            },
        ],
        schema: SKELETON_REGION_FILL_SCHEMA,
        userPrompt: [
            `CRITICAL: You previously omitted required BEGIN_FILL/END_FILL regions.`,
            `File path: ${input.skeleton.path}`,
            `Missing regions to fill:\n${input.missingRegionIds.map(id => `- ${id}`).join("\n")}`,
            `User request context: ${input.userPrompt}`,
            `Spec summary: ${input.spec.summary}`,
            skills.skillsPromptBlock,
            `Original skeleton (shows required regions):\n\`\`\`\n${input.skeleton.skeleton}\n\`\`\``,
            `Partially filled code (for context):\n\`\`\`\n${input.candidateCode}\n\`\`\``,
            "STRICT RULES:",
            "- Return ONLY region bodies for the missing region IDs listed above.",
            "- Response must include path + regions[]; do not return full-file code.",
            "- Do not include BEGIN_FILL/END_FILL markers inside region body values.",
            "- Ensure the generated syntax is valid and matches the file type.",
            "- Include exactly one regions[] entry for each missing region ID.",
        ].join("\n\n"),
        mockFixtureKey: "coder_missing_regions",
        mockFixtureTarget: targetPath,
    });

    const responsePath = normalizePath(response.data.path || targetPath);
    if (responsePath !== targetPath) {
        throw new Error(`Missing-region response path mismatch: expected ${targetPath}, got ${responsePath}`);
    }

    const regionBodies = Array.isArray(response.data.regions)
        ? response.data.regions
            .map((region) => ({
                regionId: typeof region?.regionId === "string" ? region.regionId.trim() : "",
                body: typeof region?.body === "string" ? region.body : "",
            }))
            .filter((region) => region.regionId.length > 0 && requiredRegionIds.has(region.regionId))
        : [];
    const snippetParts = regionBodies.map((region) => {
        const body = normalizeRegionBody(region.body, region.regionId) || "// TODO: FILL_IN";
        return `// BEGIN_FILL:${region.regionId}\n${body}\n// END_FILL:${region.regionId}`;
    });
    const missing = Array.from(requiredRegionIds).filter(
        (id) => !regionBodies.some((region) => region.regionId === id)
    );
    if (missing.length > 0) {
        throw new Error(`Missing-region response omitted region IDs: ${missing.slice(0, 4).join(", ")}`);
    }

    return {
        summary: response.data.summary,
        operations: [{
            op: "upsert",
            path: targetPath,
            code: snippetParts.join("\n\n"),
        }],
        trace: toModelTrace(response),
        contextFiles: [targetPath],
        lengthFinishSignals: response.diagnostics?.lengthFinishSignals ?? 0,
    };
}

export async function generateFixDag(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    issues: string[];
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<{ dag: FixDagResponse; trace: ModelTrace }> {
    const response = await callStructuredJson<FixDagResponse>({
        providers: input.providers,
        system: [
            { text: REPAIR_SYSTEM_PROMPT, cache: true },
            {
                text:
                    "\nYou are in fix-dag planning phase. Create a remediation DAG from validation/build/runtime issues.",
            },
        ],
        schema: FIX_DAG_SCHEMA,
        userPrompt: [
            `User request:\n${input.userPrompt}`,
            `Spec summary:\n${input.spec.summary}`,
            `Issues to remediate:\n${input.issues.map((issue) => `- ${issue}`).join("\n")}`,
            `Current files:\n${buildFileCatalog(input.files)}`,
            "Rules:",
            "- Split into file-scoped tasks where practical.",
            "- Keep dependsOn accurate.",
            "- taskWriteSet must list only files actually to modify.",
            "- issues list for each task should be subsets of reported issues.",
            "- CRITICAL EXPORT MISMATCH: If an issue says 'Local import X is missing from Y', you MUST ensure your taskWriteSet includes either the importer OR the exporter file so the operations phase can fix the named vs default export mismatch.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "fix_dag",
    });

    return {
        dag: normalizeFixDagResponse(
            response.data,
            input.issues,
            input.files.map((file) => file.name)
        ),
        trace: toModelTrace(response),
    };
}

export async function generateFixOperations(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    threadContext?: string;
    spec: SpecResponse;
    files: GeneratedFile[];
    task: FixDagTask;
    onPartial?: (partial: Record<string, unknown>) => void;
}): Promise<OperationResult> {
    const skills = resolveActiveSkills({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
    });
    const response = await callStructuredJson<OperationResponse>({
        providers: input.providers,
        system: [
            { text: REPAIR_SYSTEM_PROMPT, cache: true },
            {
                text:
                    "\nYou are in fix-dag execution phase. Return only targeted operations for this remediation task.",
            },
        ],
        schema: OPERATIONS_SCHEMA,
        userPrompt: [
            `User request:\n${input.userPrompt}`,
            `Thread context:\n${input.threadContext || "(none)"}`,
            `Spec summary:\n${input.spec.summary}`,
            skills.skillsPromptBlock,
            `Fix task:\n${input.task.title}\n${input.task.instructions}`,
            `Task write-set:\n${input.task.taskWriteSet.map((path) => `- ${path}`).join("\n")}`,
            `Task issues:\n${input.task.issues.map((issue) => `- ${issue}`).join("\n")}`,
            `Current files:\n${buildFileCatalog(input.files)}`,
            "Rules:",
            "- Only touch taskWriteSet files.",
            "- Keep changes minimal and issue-targeted.",
            "- Do not alter unrelated architecture or style.",
            "- Match file language by extension; never add TypeScript syntax to .js/.jsx/.mjs/.cjs files.",
            "- Do not modify package.json.",
            "- If an issue says 'Local import X is missing from Y', first check if it's a named vs default mismatch and correct the syntax. If X simply does not exist in Y at all, you MUST either add/implement X inside Y, OR remove the usage/import of X from the importer file.",
            "- If an issue mentions 'PGlite schema uses CREATE TABLE IF NOT EXISTS without column migration guards', ensure your database initialization clearly returns the `db` variable via a loose `return db;` statement at the end of the init block so the system auto-migration injector can take over. If you must fix it manually, use `information_schema.columns` to check for missing columns and run `ALTER TABLE ADD COLUMN`.",
        ].join("\n\n"),
        onPartial: input.onPartial,
        mockFixtureKey: "fix_operations",
        mockFixtureTarget: input.task.id,
    });
    const normalized = normalizeOperationResponse(response.data);
    return {
        summary: normalized.summary,
        operations: pruneNoOpOperations(input.files, normalized.operations),
        trace: toModelTrace(response),
        contextFiles: input.task.taskWriteSet,
    };
}

export async function generateFinalSummary(input: {
    providers: ConfiguredModelProvider[];
    userPrompt: string;
    files: GeneratedFile[];
}): Promise<{ summary: string; trace: ModelTrace | null }> {
    try {
        const response = await callStructuredJson<SummaryResponse>({
            providers: input.providers,
            system: [
                { text: FINALIZE_SYSTEM_PROMPT, cache: true },
                { text: "\nYou are in the finalization phase. Summarize what was delivered in 2-4 sentences." },
            ],
            schema: SUMMARY_SCHEMA,
            userPrompt: [
                `Original request:\n${input.userPrompt}`,
                `Final files:\n${input.files.map((file) => `- ${file.name}`).join("\n")}`,
            ].join("\n\n"),
            mockFixtureKey: "finalize",
        });

        const summary = response.data.summary;
        if (summary && summary.trim()) {
            return {
                summary: summary.trim(),
                trace: toModelTrace(response),
            };
        }
    } catch {
        // Keep deterministic fallback below.
    }

    return {
        summary: `Completed ${input.files.length} files for the latest iteration.`,
        trace: null,
    };
}
