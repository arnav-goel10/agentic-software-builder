// orchestrator/context.ts — File context utilities, tokenization, and working tree management
import type { GeneratedFile, RunStatus, ThreadSummaryPayload } from "@/lib/server/types";
import type { FileOperation } from "@/lib/server/agent/validation";
import { normalizePath } from "@/lib/server/agent/validation";
import type { ProviderCallResult } from "@/lib/server/agent/model-provider";
import {
    createMemoryRetrievalLog,
    createOrUpdateMemoryCard,
    createThreadSummary,
    getCurrentSnapshotForProject,
    getPreviousCompletedRun,
    listThreadSummariesByThread,
    listRunArtifacts,
    listMessagesByThread,
    searchMemoryCardsByProject,
    toParsedRunArtifact,
    toParsedSnapshot,
    toParsedMemoryCard,
    toParsedThreadSummary,
    getRunById,
    updateRunStatus,
} from "@/lib/server/repositories";
import type { RunRow } from "@/lib/server/types";
import type { TaskContextPack, ModelTrace, SpecResponse, FileContract } from "./types";
import {
    CONTEXT_FILE_LIMIT,
    CONTEXT_CHAR_BUDGET,
    MAX_USER_ERROR_LENGTH,
    STARTER_TEMPLATE_FILES,
    REPOMAP_MAX_ENTRYPOINTS,
    REPOMAP_MAX_OWNERSHIP_FILES,
    REPOMAP_MAX_DB_FILES,
    REPOMAP_MAX_FANIN_MODULES,
    CODER_FILL_DEPENDENCY_SOURCE_CHAR_CAP,
} from "./prompts";

const RUN_TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "cancelled"];
const THREAD_SUMMARY_WINDOW = 12;
const RECENCY_WINDOW = 6;
const DEFAULT_PHASE_CONTEXT_TOKEN_BUDGET = 4000;
const JSON_MANIFEST_TARGET_PATH_PATTERN = /\.json$/i;

const PHASE_CONTEXT_TOKEN_BUDGET: Partial<Record<
    "spec" | "architect" | "scaffold" | "coder" | "repair_primary" | "repair_escalation" | "qa" | "finalize",
    number
>> = {
    spec: 8000,
    architect: 10000,
    scaffold: 10000,
    coder: 32000,
    repair_primary: 16000,
    repair_escalation: 24000,
    qa: 12000,
    finalize: 4000,
};

export type ThreadContextStats = {
    tokenEstimate: number;
    tokenBudget: number;
    selectedCardIds: string[];
    droppedCardIds: string[];
    summaryIds: string[];
    recencyTurns: number;
    compacted: boolean;
};

export type ThreadContextPack = {
    text: string;
    stats: ThreadContextStats;
};

export function assertNonTerminal(run: RunRow): void {
    if (RUN_TERMINAL_STATUSES.includes(run.status)) {
        throw new Error(`Run ${run.id} is already in terminal status: ${run.status}`);
    }
}

export function toSafeJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

export function compactErrorMessage(raw: string): string {
    const flattened = raw.replace(/\s+/g, " ").trim();
    if (!flattened) {
        return "Unknown execution error";
    }
    if (flattened.length <= MAX_USER_ERROR_LENGTH) {
        return flattened;
    }
    return `${flattened.slice(0, MAX_USER_ERROR_LENGTH)}...`;
}

export function toUserFacingAgentError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? "Unknown execution error");
    const normalized = raw.toLowerCase();

    if (
        normalized.includes("truncated repeatedly with no continuation progress") ||
        normalized.includes("output truncated (finish_reason=length)")
    ) {
        return compactErrorMessage(
            "Model output hit the provider length cap repeatedly and continuation could not make progress. Try a different model routing setup or reduce per-step output size."
        );
    }

    if (
        normalized.includes("all configured providers failed") ||
        normalized.includes("provider returned error") ||
        normalized.includes("no available provider")
    ) {
        const prefix = "Model provider unavailable for current routing/model settings.";
        if (normalized.includes(prefix.toLowerCase())) {
            return compactErrorMessage(raw);
        }
        return compactErrorMessage(`${prefix} ${raw}`);
    }

    if (
        normalized.includes("resource_exhausted") ||
        normalized.includes("quota") ||
        normalized.includes("rate limit") ||
        normalized.includes("429")
    ) {
        return compactErrorMessage(raw);
    }

    if (
        normalized.includes("unauthenticated") ||
        normalized.includes("permission denied") ||
        normalized.includes("invalid api key") ||
        normalized.includes("401") ||
        normalized.includes("api key")
    ) {
        return "Model authentication failed. Verify OPENROUTER_API_KEY and model configuration env vars.";
    }

    if (normalized.includes("timeout") || normalized.includes("deadline")) {
        return "Model request timed out. Please retry.";
    }

    if (normalized.includes("invalid json")) {
        return "Model returned invalid structured output.";
    }

    if (normalized.includes("empty response")) {
        return "Model returned an empty response.";
    }

    return compactErrorMessage(raw);
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function toCompactLine(value: string, maxChars = 280): string {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) return "";
    if (compact.length <= maxChars) return compact;
    return `${compact.slice(0, maxChars)}...`;
}

function toStringList(value: unknown, max = 6): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => (typeof item === "string" ? toCompactLine(item, 220) : ""))
        .filter(Boolean)
        .slice(0, max);
}

function deriveThreadSummaryPayload(messages: Array<{ role: string; content: string }>): ThreadSummaryPayload {
    const userMessages = messages.filter((message) => message.role === "user");
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    const currentGoal =
        toCompactLine(userMessages.at(-1)?.content ?? userMessages.at(0)?.content ?? "Continue improving the project", 320);

    const lockedConstraints = userMessages
        .map((message) => message.content)
        .flatMap((content) =>
            content
                .split(/\n+/g)
                .map((line) => toCompactLine(line, 220))
                .filter((line) => /\b(must|only|never|always|required|dont|don't|should)\b/i.test(line))
        )
        .filter((line, index, array) => array.indexOf(line) === index)
        .slice(0, 8);

    const knownFailures = assistantMessages
        .map((message) => toCompactLine(message.content, 240))
        .filter((line) => /run failed|quality gate failed|error:/i.test(line))
        .slice(-8);

    const verifiedFixes = assistantMessages
        .map((message) => toCompactLine(message.content, 240))
        .filter((line) => /completed|saved snapshot|fixed|passed/i.test(line))
        .slice(-8);

    return {
        currentGoal,
        lockedConstraints,
        knownFailures,
        verifiedFixes,
        openUnknowns: [],
    };
}

function maybeCompactThreadHistory(threadId: string): {
    summaries: ReturnType<typeof toParsedThreadSummary>[];
    compacted: boolean;
} {
    const messages = listMessagesByThread(threadId);
    const messageIndex = new Map(messages.map((message, index) => [message.id, index]));
    const summaries = listThreadSummariesByThread(threadId, 64)
        .map(toParsedThreadSummary)
        .sort((left, right) => left.createdAt - right.createdAt);

    const latestSummaryEndIndex = summaries.reduce((maxIndex, summary) => {
        const index = messageIndex.get(summary.endMessageId);
        if (typeof index !== "number") return maxIndex;
        return Math.max(maxIndex, index);
    }, -1);

    const summarizeStart = latestSummaryEndIndex + 1;
    const summarizeEnd = messages.length - RECENCY_WINDOW - 1;
    const span = summarizeEnd - summarizeStart + 1;

    if (span < THREAD_SUMMARY_WINDOW) {
        return { summaries, compacted: false };
    }

    const chunk = messages.slice(summarizeStart, summarizeEnd + 1);
    if (chunk.length < THREAD_SUMMARY_WINDOW) {
        return { summaries, compacted: false };
    }

    const summaryPayload = deriveThreadSummaryPayload(chunk);
    const created = createThreadSummary({
        threadId,
        startMessageId: chunk[0].id,
        endMessageId: chunk[chunk.length - 1].id,
        summary: summaryPayload,
    });

    return {
        summaries: summaries.concat(toParsedThreadSummary(created)),
        compacted: true,
    };
}

function normalizeSummaryPayload(value: Record<string, unknown>): ThreadSummaryPayload {
    return {
        currentGoal:
            typeof value.currentGoal === "string" && value.currentGoal.trim()
                ? toCompactLine(value.currentGoal, 320)
                : "Continue implementation based on user intent.",
        lockedConstraints: toStringList(value.lockedConstraints, 10),
        knownFailures: toStringList(value.knownFailures, 10),
        verifiedFixes: toStringList(value.verifiedFixes, 10),
        openUnknowns: toStringList(value.openUnknowns, 10),
    };
}

function resolvePhaseContextBudget(
    phase?: "spec" | "architect" | "scaffold" | "coder" | "repair_primary" | "repair_escalation" | "qa" | "finalize",
    tokenBudget?: number
): number {
    if (typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0) {
        return Math.max(400, Math.floor(tokenBudget));
    }
    if (phase && PHASE_CONTEXT_TOKEN_BUDGET[phase]) {
        return PHASE_CONTEXT_TOKEN_BUDGET[phase]!;
    }
    return DEFAULT_PHASE_CONTEXT_TOKEN_BUDGET;
}

function formatSummaryForPrompt(summary: ThreadSummaryPayload): string {
    const sections = [
        `Current goal: ${summary.currentGoal}`,
        summary.lockedConstraints.length > 0
            ? `Locked constraints:\n${summary.lockedConstraints.map((item) => `- ${item}`).join("\n")}`
            : "Locked constraints:\n- (none)",
        summary.knownFailures.length > 0
            ? `Known failures:\n${summary.knownFailures.map((item) => `- ${item}`).join("\n")}`
            : "Known failures:\n- (none)",
        summary.verifiedFixes.length > 0
            ? `Verified fixes:\n${summary.verifiedFixes.map((item) => `- ${item}`).join("\n")}`
            : "Verified fixes:\n- (none)",
        summary.openUnknowns.length > 0
            ? `Open unknowns:\n${summary.openUnknowns.map((item) => `- ${item}`).join("\n")}`
            : "Open unknowns:\n- (none)",
    ];
    return sections.join("\n");
}

export function buildThreadPromptContextPack(input: {
    projectId?: string;
    threadId: string;
    triggerMessageId: string;
    runId?: string;
    phase?: "spec" | "architect" | "scaffold" | "coder" | "repair_primary" | "repair_escalation" | "qa" | "finalize";
    userPrompt?: string;
    tokenBudget?: number;
}): ThreadContextPack {
    const budget = resolvePhaseContextBudget(input.phase, input.tokenBudget);
    const { summaries, compacted } = maybeCompactThreadHistory(input.threadId);
    const messages = listMessagesByThread(input.threadId);
    const recencyMessages = messages.slice(-RECENCY_WINDOW);

    const summaryLines = summaries.slice(-6).map((summary) => {
        const normalized = normalizeSummaryPayload(summary.summary);
        return `Summary ${new Date(summary.createdAt).toISOString()}:\n${formatSummaryForPrompt(normalized)}`;
    });

    const triggerMessage = messages.find((message) => message.id === input.triggerMessageId);
    const retrievalQuery = [
        input.userPrompt ?? "",
        triggerMessage?.content ?? "",
        recencyMessages.map((message) => message.content).join("\n"),
        summaryLines.join("\n"),
    ]
        .join("\n")
        .trim();

    const memoryCards = input.projectId
        ? searchMemoryCardsByProject({
            projectId: input.projectId,
            query: retrievalQuery,
            limit: 20,
        }).map(toParsedMemoryCard)
        : [];

    const selectedCardIds: string[] = [];
    const droppedCardIds: string[] = [];

    const staticPrefix = [
        "Context policy:",
        "- Preserve locked user constraints unless explicitly overridden.",
        "- Prefer previously verified fixes for recurring failure patterns.",
        "- Use recent runtime/validator failures as priority repair anchors.",
    ].join("\n");

    const memoryEntries: Array<{ id: string; line: string }> = [];
    for (const card of memoryCards) {
        const normalized = toCompactLine(card.text, 260);
        if (!normalized) {
            droppedCardIds.push(card.id);
            continue;
        }
        memoryEntries.push({
            id: card.id,
            line: `- [${card.type}] ${normalized}`,
        });
    }

    const recencyLines = recencyMessages.map((message) => {
        const marker = message.id === input.triggerMessageId ? " (trigger)" : "";
        return `${message.role}${marker}: ${toCompactLine(message.content, 320)}`;
    });

    const blocks: string[] = [staticPrefix];
    const addBlockWithinBudget = (label: string, value: string): boolean => {
        const candidate = `${label}\n${value}`.trim();
        const joined = blocks.concat(candidate).join("\n\n");
        if (estimateTokens(joined) > budget) {
            return false;
        }
        blocks.push(candidate);
        return true;
    };

    if (memoryEntries.length > 0) {
        const acceptedLines: string[] = [];
        const acceptedIds: string[] = [];
        for (const entry of memoryEntries) {
            const candidate = `${"Project memory cards:"}\n${acceptedLines.concat(entry.line).join("\n")}`;
            const merged = blocks.concat(candidate).join("\n\n");
            if (estimateTokens(merged) > budget) {
                droppedCardIds.push(entry.id);
                continue;
            }
            acceptedLines.push(entry.line);
            acceptedIds.push(entry.id);
        }
        if (acceptedLines.length > 0) {
            blocks.push(`Project memory cards:\n${acceptedLines.join("\n")}`);
            selectedCardIds.push(...acceptedIds);
        }
    }

    if (summaryLines.length > 0) {
        const summaryText = summaryLines.join("\n\n");
        addBlockWithinBudget("Thread summaries:", summaryText);
    }

    // Recency is always appended at tail for best relevance.
    const recencyHeader = "Recent turns:";
    const recencyCandidate = `${recencyHeader}\n${recencyLines.join("\n")}`;
    if (!addBlockWithinBudget(recencyHeader, recencyLines.join("\n"))) {
        const keptRecency: string[] = [];
        for (let index = recencyLines.length - 1; index >= 0; index -= 1) {
            keptRecency.unshift(recencyLines[index]);
            const text = `${recencyHeader}\n${keptRecency.join("\n")}`;
            const merged = blocks.concat(text).join("\n\n");
            if (estimateTokens(merged) > budget) {
                keptRecency.shift();
                break;
            }
        }
        if (keptRecency.length > 0) {
            blocks.push(`${recencyHeader}\n${keptRecency.join("\n")}`);
        } else {
            blocks.push(recencyCandidate.slice(0, Math.max(160, budget * 4)));
        }
    }

    const text = blocks.join("\n\n");
    const tokenEstimate = estimateTokens(text);

    if (input.runId && input.phase) {
        createMemoryRetrievalLog({
            runId: input.runId,
            phase: input.phase,
            selectedCardIds,
            droppedCardIds,
            tokenEstimate,
        });
    }

    return {
        text,
        stats: {
            tokenEstimate,
            tokenBudget: budget,
            selectedCardIds,
            droppedCardIds,
            summaryIds: summaries.map((summary) => summary.id),
            recencyTurns: recencyMessages.length,
            compacted,
        },
    };
}

export function getThreadPromptContext(
    threadId: string,
    triggerMessageId: string,
    options?: {
        projectId?: string;
        runId?: string;
        phase?: "spec" | "architect" | "scaffold" | "coder" | "repair_primary" | "repair_escalation" | "qa" | "finalize";
        userPrompt?: string;
        tokenBudget?: number;
    }
): string {
    return buildThreadPromptContextPack({
        threadId,
        triggerMessageId,
        projectId: options?.projectId,
        runId: options?.runId,
        phase: options?.phase,
        userPrompt: options?.userPrompt,
        tokenBudget: options?.tokenBudget,
    }).text;
}

export function toModelTrace<T>(result: ProviderCallResult<T>): ModelTrace {
    return {
        provider: `${result.provider}/${result.model}`,
        usage: result.usage ?? null,
        attempts: result.attempts.map((attempt) => ({
            provider: attempt.provider,
            model: attempt.model,
            ok: attempt.ok,
            status: attempt.status,
            durationMs: attempt.durationMs,
            message: attempt.message
                ? attempt.message.slice(0, 180)
                : undefined,
        })),
        diagnostics: result.diagnostics,
    };
}

export function buildFileCatalog(files: GeneratedFile[]): string {
    if (files.length === 0) {
        return "(none)";
    }
    return files.map((file) => `- ${file.name}`).join("\n");
}

export function createWorkingTreeDigest(files: GeneratedFile[], maxChars = CONTEXT_CHAR_BUDGET): string {
    const blocks: string[] = [];
    let remaining = maxChars;

    for (const file of files) {
        if (remaining <= 0) break;

        const header = `FILE: ${file.name}\n`;
        const bodyBudget = Math.max(0, remaining - header.length - 2);
        const code =
            file.code.length > bodyBudget
                ? `${file.code.slice(0, Math.max(0, bodyBudget - 32))}\n/* truncated */`
                : file.code;
        const block = `${header}${code}\n\n`;

        if (block.length <= remaining) {
            blocks.push(block);
            remaining -= block.length;
        } else {
            blocks.push(block.slice(0, remaining));
            remaining = 0;
        }
    }

    return blocks.join("");
}

function tokenize(text: string): string[] {
    return Array.from(
        new Set(
            text
                .toLowerCase()
                .split(/[^a-z0-9_./-]+/g)
                .map((token) => token.trim())
                .filter((token) => token.length >= 3)
        )
    );
}

/**
 * Extracts internal import paths from source code.
 * Matches: import ... from './foo', require('../bar'), etc.
 */
function extractImports(code: string): string[] {
    const internalImports: string[] = [];
    const regex = /import\s+.*from\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|import\(['"]([^'"]+)['"]\)/g;
    let match;
    while ((match = regex.exec(code)) !== null) {
        const imp = match[1] || match[2] || match[3];
        if (imp && (imp.startsWith('.') || imp.startsWith('/') || imp.startsWith('@/'))) {
            internalImports.push(imp);
        }
    }
    return internalImports;
}

/**
 * Normalizes an import specifier relative to the importing file.
 */
function resolveInternalImport(specifier: string, fromPath: string): string {
    if (specifier.startsWith('@/')) {
        return normalizePath(`src/${specifier.slice(2)}`);
    }
    if (!specifier.startsWith('.')) {
        return normalizePath(specifier);
    }

    const parts = fromPath.split('/');
    parts.pop(); // Remove filename
    const specParts = specifier.split('/');

    for (const part of specParts) {
        if (part === '.') continue;
        if (part === '..') {
            parts.pop();
        } else {
            parts.push(part);
        }
    }

    const resolved = parts.join('/');
    // Add extension if missing (guess jsx/tsx/js/ts)
    if (!/\.[a-z0-9]+$/i.test(resolved)) {
        return resolved; // Base path, caller will match against existing files
    }
    return normalizePath(resolved);
}

/**
 * Builds a cross-file dependency graph.
 */
function buildDependencyGraph(files: GeneratedFile[]): Map<string, Set<string>> {
    const graph = new Map<string, Set<string>>();
    const fileNames = new Set(files.map(f => normalizePath(f.name)));

    for (const file of files) {
        const normalizedName = normalizePath(file.name);
        const deps = new Set<string>();
        const rawImports = extractImports(file.code);

        for (const imp of rawImports) {
            const resolvedBase = resolveInternalImport(imp, normalizedName);
            // Try to find the actual file if extension was omitted
            const candidates = [
                resolvedBase,
                `${resolvedBase}.tsx`,
                `${resolvedBase}.ts`,
                `${resolvedBase}.jsx`,
                `${resolvedBase}.js`,
                `${resolvedBase}/index.tsx`,
                `${resolvedBase}/index.ts`,
            ];

            for (const cand of candidates) {
                const normCand = normalizePath(cand);
                if (fileNames.has(normCand)) {
                    deps.add(normCand);
                    break;
                }
            }
        }
        graph.set(normalizedName, deps);
    }
    return graph;
}

function pickRepoEntrypoints(files: GeneratedFile[]): string[] {
    const entryPattern =
        /^(src\/main\.(tsx?|jsx?)|src\/index\.(tsx?|jsx?)|main\.(tsx?|jsx?)|index\.(tsx?|jsx?)|src\/app\/layout\.tsx|src\/app\/page\.tsx|src\/app\/api\/.*\/route\.ts)$/i;
    return files
        .map((file) => normalizePath(file.name))
        .filter((name) => entryPattern.test(name))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, REPOMAP_MAX_ENTRYPOINTS);
}

function pickRepoOwnershipFiles(files: GeneratedFile[]): string[] {
    const ownershipSignals = [
        /BrowserRouter|RouterProvider|createBrowserRouter|createHashRouter/,
        /QueryClientProvider|new\s+QueryClient/,
        /AuthProvider|useAuth|ThemeProvider|Provider/,
    ];
    return files
        .filter((file) => ownershipSignals.some((pattern) => pattern.test(file.code)))
        .map((file) => normalizePath(file.name))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, REPOMAP_MAX_OWNERSHIP_FILES);
}

function pickRepoDbFiles(files: GeneratedFile[]): string[] {
    const dbSignals = [
        /@electric-sql\/pglite/,
        /\bnew\s+PGlite\b/,
        /\bdb\.query\b/,
        /\bdb\.exec\b/,
    ];
    return files
        .filter((file) => dbSignals.some((pattern) => pattern.test(file.code)))
        .map((file) => normalizePath(file.name))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, REPOMAP_MAX_DB_FILES);
}

function buildHighFanInModules(
    files: GeneratedFile[],
    graph: Map<string, Set<string>>
): Array<{ path: string; imports: number }> {
    const known = new Set(files.map((file) => normalizePath(file.name)));
    const importCounts = new Map<string, number>();

    for (const deps of graph.values()) {
        for (const dep of deps) {
            if (!known.has(dep)) continue;
            importCounts.set(dep, (importCounts.get(dep) ?? 0) + 1);
        }
    }

    return Array.from(importCounts.entries())
        .filter(([, imports]) => imports >= 2)
        .map(([path, imports]) => ({ path, imports }))
        .sort((left, right) => right.imports - left.imports || left.path.localeCompare(right.path))
        .slice(0, REPOMAP_MAX_FANIN_MODULES);
}

export function buildRepoMapSummary(files: GeneratedFile[]): string {
    if (files.length === 0) {
        return "Repo map:\n- Entrypoints: (none)\n- Router/provider ownership: (none)\n- DB modules: (none)\n- High fan-in modules: (none)";
    }

    const graph = buildDependencyGraph(files);
    const entrypoints = pickRepoEntrypoints(files);
    const ownershipFiles = pickRepoOwnershipFiles(files);
    const dbFiles = pickRepoDbFiles(files);
    const highFanIn = buildHighFanInModules(files, graph);
    const highFanInText =
        highFanIn.length > 0
            ? highFanIn.map((entry) => `- ${entry.path} (imports=${entry.imports})`).join("\n")
            : "- (none)";

    return [
        "Repo map:",
        `Entrypoints:\n${entrypoints.length > 0 ? entrypoints.map((name) => `- ${name}`).join("\n") : "- (none)"}`,
        `Router/provider ownership:\n${ownershipFiles.length > 0 ? ownershipFiles.map((name) => `- ${name}`).join("\n") : "- (none)"}`,
        `DB modules:\n${dbFiles.length > 0 ? dbFiles.map((name) => `- ${name}`).join("\n") : "- (none)"}`,
        `High fan-in modules:\n${highFanInText}`,
    ].join("\n\n");
}

/**
 * Propagates scores down the dependency tree.
 * If A imports B, B gets some of A's score.
 */
function propagateScores(
    scores: Map<string, number>,
    graph: Map<string, Set<string>>
): Map<string, number> {
    const boosted = new Map(scores);

    // One-pass propagation (could be recursive for deeper depth, but 1-level is usually enough for context)
    for (const [filePath, score] of scores.entries()) {
        const deps = graph.get(filePath);
        if (!deps) continue;

        for (const dep of deps) {
            const current = boosted.get(dep) || 0;
            // 50% score propagation to direct dependencies
            boosted.set(dep, current + (score * 0.5));
        }
    }

    return boosted;
}

function scoreFileForTask(file: GeneratedFile, keywords: string[]): number {
    const haystack = `${file.name}\n${file.code.slice(0, 2000)}`.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
        if (file.name.toLowerCase().includes(keyword)) {
            score += 5;
        }
        if (haystack.includes(keyword)) {
            score += 1;
        }
    }

    if (/^(package\.json|src\/App\.(jsx|tsx|js|ts)|App\.(jsx|tsx|js|ts)|src\/main\.(jsx|tsx|js|ts)|main\.(jsx|tsx|js|ts))$/.test(file.name)) {
        score += 3;
    }

    return score;
}

export function buildTaskContextPack(input: {
    files: GeneratedFile[];
    userPrompt: string;
    planSummary?: string;
    taskTitle: string;
    taskInstructions: string;
}): TaskContextPack {
    const keywords = tokenize(
        [
            input.userPrompt,
            input.planSummary ?? "",
            input.taskTitle,
            input.taskInstructions,
            "app",
            "route",
            "auth",
            "api",
            "component",
        ].join(" ")
    );

    // 1. Initial keyword scoring
    const baseScores = new Map<string, number>();
    for (const file of input.files) {
        baseScores.set(normalizePath(file.name), scoreFileForTask(file, keywords));
    }

    // 2. Build graph and propagate scores
    const graph = buildDependencyGraph(input.files);
    const boostedScores = propagateScores(baseScores, graph);

    // 3. Greedy selection based on boosted scores and character budget
    const scoredFiles = input.files
        .map((file) => ({
            file,
            score: boostedScores.get(normalizePath(file.name)) || 0,
        }))
        .sort((a, b) => b.score - a.score || a.file.name.localeCompare(b.file.name));

    const selected: GeneratedFile[] = [];
    let currentChars = 0;

    for (const entry of scoredFiles) {
        // Always include at least 1 file if possible
        const estimatedSize = entry.file.code.length + entry.file.name.length + 20; // 20 for formatting overhead

        if (selected.length > 0 && currentChars + estimatedSize > CONTEXT_CHAR_BUDGET) {
            // Hard limit on total files too, just to avoid overwhelming LLM
            if (selected.length < CONTEXT_FILE_LIMIT * 2) {
                // We don't break yet, might find very small files later?
                // But usually sorted by score. If next high score is massive, we skip.
                continue;
            }
            break;
        }
        selected.push(entry.file);
        currentChars += estimatedSize;
    }

    return {
        selectedFiles: selected,
        selectedNames: selected.map((file) => file.name),
        treeDigest: createWorkingTreeDigest(selected),
        fileCatalog: buildFileCatalog(input.files),
        repoMapSummary: buildRepoMapSummary(input.files),
    };
}

/**
 * Coder-fill context enrichment, priority (a): pulls FULL SOURCE (current
 * working-tree content) for a skeleton file's direct dependencies, capped
 * per-file and by an overall char budget. Dependencies whose source is not
 * available or does not fit are left for the caller to fall back to a cheap
 * signature-only summary (priority (c)).
 */
export function buildCoderFillDependencySources(input: {
    targetPath: string;
    dependencyContracts: FileContract[];
    workingFiles: GeneratedFile[];
    charBudget: number;
}): { section: string; coveredPaths: Set<string>; remainingBudget: number } {
    const workingByPath = new Map(
        input.workingFiles.map((file) => [normalizePath(file.name), file] as const)
    );
    const covered = new Set<string>();
    const blocks: string[] = [];
    let remaining = input.charBudget;

    for (const dep of input.dependencyContracts) {
        if (remaining <= 100) break;

        let depPath: string;
        try {
            depPath = normalizePath(dep.path);
        } catch {
            continue;
        }
        if (depPath === input.targetPath || covered.has(depPath)) continue;

        const file = workingByPath.get(depPath);
        if (!file) continue;

        const capped =
            file.code.length > CODER_FILL_DEPENDENCY_SOURCE_CHAR_CAP
                ? `${file.code.slice(0, CODER_FILL_DEPENDENCY_SOURCE_CHAR_CAP)}\n/* truncated */`
                : file.code;
        const header = `// ${depPath}\n`;
        const available = remaining - header.length;
        if (available <= 100) continue;

        const body =
            capped.length > available ? `${capped.slice(0, available - 20)}\n/* truncated */` : capped;
        const block = `${header}${body}`;
        blocks.push(block);
        covered.add(depPath);
        remaining -= block.length + 2; // account for the join separator
    }

    return {
        section: blocks.join("\n\n"),
        coveredPaths: covered,
        remainingBudget: Math.max(0, remaining),
    };
}

/**
 * Coder-fill context enrichment, priority (b): relevance-ranked additional
 * files (via buildTaskContextPack) for whatever char budget remains after
 * dependency full sources, excluding files already included.
 */
export function buildCoderFillRelatedFilesSection(input: {
    targetPath: string;
    purpose: string;
    contractSummary: string;
    workingFiles: GeneratedFile[];
    excludePaths: Set<string>;
    charBudget: number;
}): string {
    if (input.charBudget <= 100) {
        return "";
    }

    const candidates = input.workingFiles.filter(
        (file) => !input.excludePaths.has(normalizePath(file.name))
    );
    if (candidates.length === 0) {
        return "";
    }

    const pack = buildTaskContextPack({
        files: candidates,
        userPrompt: input.purpose,
        taskTitle: `Fill ${input.targetPath}`,
        taskInstructions: input.contractSummary || input.purpose,
    });
    if (pack.selectedFiles.length === 0) {
        return "";
    }

    return createWorkingTreeDigest(pack.selectedFiles, input.charBudget);
}

export function computeFileSet(files: GeneratedFile[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const file of files) {
        map.set(file.name, file.code);
    }
    return map;
}

export function summarizeTreeChanges(
    before: GeneratedFile[],
    after: GeneratedFile[]
): {
    created: string[];
    updated: string[];
    deleted: string[];
} {
    const beforeMap = computeFileSet(before);
    const afterMap = computeFileSet(after);
    const created: string[] = [];
    const updated: string[] = [];
    const deleted: string[] = [];

    for (const [name, code] of afterMap.entries()) {
        if (!beforeMap.has(name)) {
            created.push(name);
            continue;
        }
        if (beforeMap.get(name) !== code) {
            updated.push(name);
        }
    }

    for (const name of beforeMap.keys()) {
        if (!afterMap.has(name)) {
            deleted.push(name);
        }
    }

    created.sort();
    updated.sort();
    deleted.sort();
    return { created, updated, deleted };
}

export function formatSpecForPrompt(spec: SpecResponse): string {
    return [
        `Spec summary: ${spec.summary}`,
        `Stack profile: ${spec.stackProfile} (${spec.stackProfileReasoning})`,
        `Design language: ${spec.designLanguage} (${spec.designLanguageReasoning})`,
        `Requirements:\n${spec.requirements.map((item) => `- ${item}`).join("\n")}`,
        `Acceptance criteria:\n${spec.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
        spec.nonGoals.length
            ? `Non-goals:\n${spec.nonGoals.map((item) => `- ${item}`).join("\n")}`
            : "Non-goals:\n- (none)",
        `Test checklist:\n${spec.testChecklist.map((item) => `- ${item}`).join("\n")}`,
    ].join("\n\n");
}

export function getPriorRunContext(projectId: string, currentRunId: string): string {
    const previousRun = getPreviousCompletedRun(projectId, currentRunId);
    if (!previousRun) {
        return "(no prior completed run artifacts)";
    }

    const artifacts = listRunArtifacts(previousRun.id).map(toParsedRunArtifact);
    if (artifacts.length === 0) {
        return "(no prior completed run artifacts)";
    }

    const lines: string[] = [];
    for (const artifact of artifacts) {
        if (artifact.kind === "spec") {
            const summary = typeof artifact.content.summary === "string" ? artifact.content.summary : "";
            lines.push(`Previous spec: ${summary}`);
        } else if (artifact.kind === "qa") {
            const score =
                typeof artifact.content.score === "number"
                    ? String(artifact.content.score)
                    : "unknown";
            lines.push(`Previous QA score: ${score}`);
        } else if (artifact.kind === "memory") {
            const decisions = Array.isArray(artifact.content.decisions)
                ? artifact.content.decisions
                    .map((item) => (typeof item === "string" ? item : ""))
                    .filter(Boolean)
                    .slice(0, 6)
                : [];
            if (decisions.length > 0) {
                lines.push(`Prior decisions:\n${decisions.map((item) => `- ${item}`).join("\n")}`);
            }
        }
    }

    return lines.length > 0 ? lines.join("\n") : "(no prior completed run artifacts)";
}

export function persistRunMemoryCards(input: {
    projectId: string;
    runId: string;
    specSummary: string;
    planSummary: string;
    lockedConstraints?: string[];
    hardBlockers?: string[];
    verifiedFixes?: string[];
}): string[] {
    const createdCardIds: string[] = [];

    const decisionCards = [input.specSummary, input.planSummary]
        .map((text) => toCompactLine(text, 320))
        .filter(Boolean);
    for (const text of decisionCards) {
        const row = createOrUpdateMemoryCard({
            projectId: input.projectId,
            sourceRunId: input.runId,
            type: "decision",
            text,
            weight: 1.2,
        });
        createdCardIds.push(row.id);
    }

    const constraints = (input.lockedConstraints ?? [])
        .map((text) => toCompactLine(text, 260))
        .filter(Boolean)
        .slice(0, 12);
    for (const text of constraints) {
        const row = createOrUpdateMemoryCard({
            projectId: input.projectId,
            sourceRunId: input.runId,
            type: "constraint",
            text,
            weight: 1.4,
        });
        createdCardIds.push(row.id);
    }

    const blockers = (input.hardBlockers ?? [])
        .map((text) => toCompactLine(text, 280))
        .filter(Boolean)
        .slice(0, 12);
    for (const text of blockers) {
        const row = createOrUpdateMemoryCard({
            projectId: input.projectId,
            sourceRunId: input.runId,
            type: "anti_pattern",
            text,
            weight: 1.6,
        });
        createdCardIds.push(row.id);
    }

    const fixes = (input.verifiedFixes ?? [])
        .map((text) => toCompactLine(text, 280))
        .filter(Boolean)
        .slice(0, 12);
    for (const text of fixes) {
        const row = createOrUpdateMemoryCard({
            projectId: input.projectId,
            sourceRunId: input.runId,
            type: "bugfix",
            text,
            weight: 1.3,
        });
        createdCardIds.push(row.id);
    }

    return createdCardIds;
}

function cloneFiles(files: GeneratedFile[]): GeneratedFile[] {
    return files.map((file) => ({ ...file }));
}

export function runSnapshotFiles(projectId: string): GeneratedFile[] {
    const snapshot = getCurrentSnapshotForProject(projectId);
    if (!snapshot) {
        return cloneFiles(STARTER_TEMPLATE_FILES);
    }

    const parsed = toParsedSnapshot(snapshot);
    return parsed.files.length > 0 ? cloneFiles(parsed.files) : cloneFiles(STARTER_TEMPLATE_FILES);
}

export function ensureRunExists(runId: string): RunRow {
    const run = getRunById(runId);
    if (!run) {
        throw new Error(`Run not found: ${runId}`);
    }
    return run;
}

export function updateRunAndReload(runId: string, status: RunStatus, error?: string | null): RunRow {
    updateRunStatus({ runId, status, error });
    return ensureRunExists(runId);
}

export function pruneNoOpOperations(
    currentFiles: GeneratedFile[],
    operations: FileOperation[]
): FileOperation[] {
    const currentByPath = new Map<string, string>();
    for (const file of currentFiles) {
        currentByPath.set(normalizePath(file.name), file.code);
    }

    const lastByPath = new Map<string, FileOperation>();
    for (const operation of operations) {
        const rawPath = typeof operation.path === "string" ? operation.path.trim() : "";
        if (!rawPath) {
            continue;
        }
        let normalizedPath: string;
        try {
            normalizedPath = normalizePath(rawPath);
        } catch {
            continue;
        }
        lastByPath.set(normalizedPath, { ...operation, path: normalizedPath });
    }

    const pruned: FileOperation[] = [];
    for (const operation of lastByPath.values()) {
        if (operation.op === "delete") {
            if (currentByPath.has(operation.path)) {
                pruned.push(operation);
            }
            continue;
        }

        if (operation.op === "upsert") {
            const existing = currentByPath.get(operation.path);
            if (typeof operation.code === "string" && operation.code.trim().length > 0) {
                if (existing !== operation.code) {
                    pruned.push(operation);
                }
            }
            continue;
        }

        if (operation.op === "json_manifest_update") {
            if (!JSON_MANIFEST_TARGET_PATH_PATTERN.test(operation.path)) {
                continue;
            }
            const existing = currentByPath.get(operation.path);
            if (!existing) {
                pruned.push(operation);
                continue;
            }

            try {
                const parsed = JSON.parse(existing);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    pruned.push(operation);
                    continue;
                }

                const merged = mergeJsonForNoopCheck(
                    parsed as Record<string, unknown>,
                    operation.merge
                );
                const nextSerialized = JSON.stringify(merged);
                const currentSerialized = JSON.stringify(parsed);
                if (nextSerialized !== currentSerialized) {
                    pruned.push(operation);
                }
            } catch {
                pruned.push(operation);
            }
        }
    }

    return pruned;
}

export function countOperationKinds(operations: FileOperation[]): {
    upserts: number;
    deletes: number;
    manifestUpdates: number;
} {
    let upserts = 0;
    let deletes = 0;
    let manifestUpdates = 0;
    for (const operation of operations) {
        if (operation.op === "upsert") {
            upserts += 1;
        } else if (operation.op === "delete") {
            deletes += 1;
        } else if (operation.op === "json_manifest_update") {
            manifestUpdates += 1;
        }
    }
    return { upserts, deletes, manifestUpdates };
}

export function initializeDiagnostics(
    tasksPlanned: number,
    executionMode?: import("@/lib/server/types").ExecutionMode
): import("./types").RunDiagnostics {
    return {
        executionMode,
        specQualityScore: 0,
        tasksPlanned,
        tasksCompleted: 0,
        validationFailures: 0,
        repairPasses: 0,
        qaPasses: 0,
        qaFixPasses: 0,
        qaEscalations: 0,
        totalOperations: 0,
        totalUpserts: 0,
        totalDeletes: 0,
        noOpTasks: 0,
        deferredTasks: 0,
        fallbackSwitches: 0,
        phaseTimeouts: 0,
        invalidJsonIncidents: 0,
        invalidSchemaIncidents: 0,
    };
}

export function estimateSpecQualityScore(spec: SpecResponse): number {
    let score = 35;
    score += Math.min(20, spec.requirements.length * 4);
    score += Math.min(25, spec.acceptanceCriteria.length * 4);
    score += Math.min(15, spec.testChecklist.length * 3);
    if (spec.nonGoals.length > 0) {
        score += 5;
    }
    return Math.min(100, score);
}

function mergeJsonForNoopCheck(
    target: Record<string, unknown>,
    patch: Record<string, unknown>
): Record<string, unknown> {
    const output: Record<string, unknown> = { ...target };

    for (const [key, value] of Object.entries(patch)) {
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            output[key] &&
            typeof output[key] === "object" &&
            !Array.isArray(output[key])
        ) {
            output[key] = mergeJsonForNoopCheck(
                output[key] as Record<string, unknown>,
                value as Record<string, unknown>
            );
            continue;
        }
        output[key] = value;
    }

    return output;
}
