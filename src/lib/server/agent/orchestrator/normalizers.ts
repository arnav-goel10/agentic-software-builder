// orchestrator/normalizers.ts — Response normalization for LLM outputs
import path from "node:path";
import type {
    SpecResponse,
    PlanResponse,
    PlanTask,
    OperationResponse,
    QaResponse,
    QaAcceptanceItem,
    ArchitectPlanResponse,
    FileContract,
    ExportContract,
    DbQueryContract,
    PlanOutlineResponse,
    SkeletonSpecDagResponse,
    SkeletonDagNode,
    FixDagTask,
    FixDagResponse,
} from "./types";
import type { FileOperation } from "@/lib/server/agent/validation";
import { normalizePath } from "@/lib/server/agent/validation";
import { MAX_PLAN_TASKS } from "./prompts";
import type { ExecutionMode, TaskObjectiveType } from "@/lib/server/types";

const JSON_MANIFEST_TARGET_PATH_PATTERN = /\.json$/i;

function normalizeObjectiveType(
    raw: unknown,
    title: string,
    instructions: string
): TaskObjectiveType {
    if (
        raw === "direct_fix" ||
        raw === "supporting_refactor" ||
        raw === "verification"
    ) {
        return raw;
    }

    const signal = `${title}\n${instructions}`.toLowerCase();
    if (/\b(verify|validate|check|test)\b/.test(signal)) {
        return "verification";
    }
    if (/\b(refactor|cleanup|restructure|extract|reorganize)\b/.test(signal)) {
        return "supporting_refactor";
    }
    return "direct_fix";
}

function tokenizeForSimilarity(input: string): Set<string> {
    return new Set(
        input
            .toLowerCase()
            .split(/[^a-z0-9_]+/g)
            .map((token) => token.trim())
            .filter((token) => token.length >= 3)
    );
}

function jaccardSimilarity(left: string, right: string): number {
    const leftTokens = tokenizeForSimilarity(left);
    const rightTokens = tokenizeForSimilarity(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    let overlap = 0;
    for (const token of leftTokens) {
        if (rightTokens.has(token)) {
            overlap += 1;
        }
    }
    const union = new Set([...leftTokens, ...rightTokens]).size;
    return union === 0 ? 0 : overlap / union;
}

function writeSetOverlapRatio(left: PlanTask, right: PlanTask): number {
    const leftSet = new Set(left.taskWriteSet);
    const rightSet = new Set(right.taskWriteSet);
    if (leftSet.size === 0 || rightSet.size === 0) return 0;
    let overlap = 0;
    for (const path of leftSet) {
        if (rightSet.has(path)) {
            overlap += 1;
        }
    }
    const minSize = Math.min(leftSet.size, rightSet.size);
    return minSize === 0 ? 0 : overlap / minSize;
}

function mergeObjectiveType(left: TaskObjectiveType, right: TaskObjectiveType): TaskObjectiveType {
    if (left === "direct_fix" || right === "direct_fix") return "direct_fix";
    if (left === "supporting_refactor" || right === "supporting_refactor") {
        return "supporting_refactor";
    }
    return "verification";
}

function isJavascriptLikePath(pathName: string): boolean {
    return /\.(?:jsx?|mjs|cjs)$/i.test(pathName);
}

function sanitizeExportSignatureForPath(
    pathName: string,
    kind: ExportContract["kind"],
    name: string,
    signature: string
): string {
    const trimmed = signature.trim();
    if (!trimmed) {
        return kind === "const" ? name : `${name}(...args)`;
    }
    if (!isJavascriptLikePath(pathName)) {
        return trimmed;
    }

    const hasTypeScriptSyntax =
        /:\s*[A-Za-z_$][\w$.<>,\[\]\s|&?]*/.test(trimmed) ||
        /\bas\s+[A-Za-z_$][\w$.<>,\[\]\s|&?]*/.test(trimmed) ||
        /\b(?:interface|type)\s+[A-Za-z_$]/.test(trimmed) ||
        /=>\s*[A-Za-z_$][\w$.]*(?:<[^>]+>)?(?:\[\])?$/.test(trimmed) ||
        /<\s*[A-Za-z_$][\w$,\s]*>/.test(trimmed);

    if (!hasTypeScriptSyntax) {
        return trimmed;
    }

    if (kind === "const") {
        return name;
    }
    if (kind === "class") {
        return `${name}(...)`;
    }
    return `${name}(...args)`;
}

function stripKnownModuleExtensions(pathName: string): string {
    return pathName.replace(/\.(?:jsx?|tsx?|mjs|cjs)$/i, "").replace(/\/index$/i, "");
}

function toRelativeImportSource(fromPath: string, targetPath: string): string {
    const fromDir = path.posix.dirname(fromPath);
    const raw = path.posix.relative(fromDir, targetPath);
    const withDot = raw.startsWith(".") ? raw : `./${raw}`;
    const normalized = stripKnownModuleExtensions(withDot);
    return normalized.length > 0 ? normalized : "./";
}

function resolveLocalImportTargetPath(
    ownerPath: string,
    source: string,
    knownPaths: Set<string>
): string | null {
    const trimmed = source.trim();
    if (!trimmed) return null;
    if (!(trimmed.startsWith(".") || trimmed.startsWith("src/"))) return null;

    const ownerDir = path.posix.dirname(ownerPath);
    const base = trimmed.startsWith(".")
        ? path.posix.normalize(path.posix.join(ownerDir, trimmed))
        : path.posix.normalize(trimmed);
    const strippedBase = base.startsWith("src/") ? base : `src/${base}`;
    const baseCandidates = Array.from(
        new Set([
            normalizePath(base),
            normalizePath(strippedBase),
            normalizePath(`${base}.ts`),
            normalizePath(`${base}.tsx`),
            normalizePath(`${base}.js`),
            normalizePath(`${base}.jsx`),
            normalizePath(`${base}.mjs`),
            normalizePath(`${base}.cjs`),
            normalizePath(`${base}/index.ts`),
            normalizePath(`${base}/index.tsx`),
            normalizePath(`${base}/index.js`),
            normalizePath(`${base}/index.jsx`),
            normalizePath(`${base}/index.mjs`),
            normalizePath(`${base}/index.cjs`),
            normalizePath(`${strippedBase}.ts`),
            normalizePath(`${strippedBase}.tsx`),
            normalizePath(`${strippedBase}.js`),
            normalizePath(`${strippedBase}.jsx`),
            normalizePath(`${strippedBase}.mjs`),
            normalizePath(`${strippedBase}.cjs`),
            normalizePath(`${strippedBase}/index.ts`),
            normalizePath(`${strippedBase}/index.tsx`),
            normalizePath(`${strippedBase}/index.js`),
            normalizePath(`${strippedBase}/index.jsx`),
            normalizePath(`${strippedBase}/index.mjs`),
            normalizePath(`${strippedBase}/index.cjs`),
        ])
    );
    for (const candidate of baseCandidates) {
        if (knownPaths.has(candidate)) {
            return candidate;
        }
    }

    const sourceStem = stripKnownModuleExtensions(trimmed.replace(/^src\//, "").replace(/^\.\//, ""));
    const sourceBasename = path.posix.basename(sourceStem);
    const fuzzyMatches = Array.from(knownPaths).filter((candidatePath) => {
        const candidateStem = stripKnownModuleExtensions(candidatePath.replace(/^src\//, ""));
        return (
            candidateStem.endsWith(sourceStem) ||
            path.posix.basename(candidateStem) === sourceBasename
        );
    });
    if (fuzzyMatches.length === 1) {
        return fuzzyMatches[0];
    }
    return null;
}

function normalizeFileContracts(rawContracts: unknown): FileContract[] {
    const rows = Array.isArray(rawContracts) ? rawContracts : [];
    const map = new Map<string, FileContract>();

    const mergeIntoMap = (contract: FileContract): void => {
        const existing = map.get(contract.path);
        if (!existing) {
            map.set(contract.path, {
                ...contract,
                imports: contract.imports.map((entry) => ({ ...entry, names: [...entry.names] })),
                exports: contract.exports.map((entry) => ({ ...entry })),
                ...(contract.dbQueries
                    ? { dbQueries: contract.dbQueries.map((entry) => ({ ...entry })) }
                    : {}),
            });
            return;
        }

        existing.purpose = existing.purpose || contract.purpose;
        for (const imp of contract.imports) {
            const found = existing.imports.find((entry) => entry.source === imp.source);
            if (!found) {
                existing.imports.push({ ...imp, names: [...imp.names] });
                continue;
            }
            for (const name of imp.names) {
                if (!found.names.includes(name)) {
                    found.names.push(name);
                }
            }
        }
        for (const exp of contract.exports) {
            if (!existing.exports.some((entry) => entry.name === exp.name)) {
                existing.exports.push({ ...exp });
            }
        }
        if (contract.dbQueries && contract.dbQueries.length > 0) {
            const existingQueries = existing.dbQueries ?? [];
            for (const query of contract.dbQueries) {
                if (
                    !existingQueries.some(
                        (entry) =>
                            entry.operation === query.operation &&
                            entry.table === query.table &&
                            entry.description === query.description
                    )
                ) {
                    existingQueries.push({ ...query });
                }
            }
            if (existingQueries.length > 0) {
                existing.dbQueries = existingQueries;
            }
        }
    };

    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const raw = row as Record<string, unknown>;
        const rawPath = typeof raw.path === "string" ? raw.path.trim() : "";
        if (!rawPath) continue;
        let path: string;
        try {
            path = normalizePath(rawPath);
        } catch {
            continue;
        }

        const purpose =
            typeof raw.purpose === "string" && raw.purpose.trim().length > 0
                ? raw.purpose.trim()
                : `Implementation contract for ${path}`;

        const imports = Array.isArray(raw.imports)
            ? raw.imports
                .map((item) => {
                    if (!item || typeof item !== "object") return null;
                    const record = item as Record<string, unknown>;
                    const source = typeof record.source === "string" ? record.source.trim() : "";
                    if (!source) return null;
                    const names = Array.isArray(record.names)
                        ? Array.from(
                            new Set(
                                record.names
                                    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
                                    .filter(Boolean)
                            )
                        )
                        : [];
                    return { source, names };
                })
                .filter((item): item is NonNullable<typeof item> => Boolean(item))
            : [];

        const exports = Array.isArray(raw.exports)
            ? raw.exports
                .map((item) => {
                    if (!item || typeof item !== "object") return null;
                    const record = item as Record<string, unknown>;
                    const name = typeof record.name === "string" ? record.name.trim() : "";
                    if (!name) return null;
                    const kindRaw = typeof record.kind === "string" ? record.kind.trim() : "";
                    const kind: ExportContract["kind"] =
                        kindRaw === "function" ||
                        kindRaw === "const" ||
                        kindRaw === "class" ||
                        kindRaw === "default" ||
                        kindRaw === "type"
                            ? kindRaw
                            : "function";
                    const rawSignature =
                        typeof record.signature === "string" && record.signature.trim().length > 0
                            ? record.signature.trim()
                            : "function(...args)";
                    const signature = sanitizeExportSignatureForPath(path, kind, name, rawSignature);
                    const description =
                        typeof record.description === "string" && record.description.trim().length > 0
                            ? record.description.trim()
                            : `${name} implementation`;
                    return { name, kind, signature, description };
                })
                .filter((item): item is NonNullable<typeof item> => Boolean(item))
            : [];

        const dbQueries = Array.isArray(raw.dbQueries)
            ? raw.dbQueries
                .map((item) => {
                    if (!item || typeof item !== "object") return null;
                    const record = item as Record<string, unknown>;
                    const operationRaw =
                        typeof record.operation === "string" ? record.operation.trim() : "";
                    const operation: DbQueryContract["operation"] | null =
                        operationRaw === "SELECT" ||
                        operationRaw === "INSERT" ||
                        operationRaw === "UPDATE" ||
                        operationRaw === "DELETE" ||
                        operationRaw === "CREATE"
                            ? operationRaw
                            : null;
                    const table = typeof record.table === "string" ? record.table.trim() : "";
                    const description =
                        typeof record.description === "string" ? record.description.trim() : "";
                    if (!operation || !table || !description) return null;
                    return { operation, table, description };
                })
                .filter((item): item is NonNullable<typeof item> => Boolean(item))
            : [];

        mergeIntoMap({
            path,
            purpose,
            imports,
            exports,
            ...(dbQueries.length > 0 ? { dbQueries } : {}),
        });
    }

    const contracts = Array.from(map.values());
    const knownPaths = new Set(contracts.map((contract) => contract.path));
    for (const contract of contracts) {
        contract.imports = contract.imports.map((entry) => {
            if (!(entry.source.startsWith(".") || entry.source.startsWith("src/"))) {
                return entry;
            }
            const resolvedTarget = resolveLocalImportTargetPath(contract.path, entry.source, knownPaths);
            if (!resolvedTarget) {
                return entry;
            }
            const canonicalSource = toRelativeImportSource(contract.path, resolvedTarget);
            return {
                ...entry,
                source: canonicalSource,
            };
        });
    }
    return contracts;
}

function mergeFileContractLists(primary: FileContract[], secondary: FileContract[]): FileContract[] {
    return normalizeFileContracts(primary.concat(secondary));
}

function mergeOverlappingTasks(tasks: PlanTask[]): PlanTask[] {
    if (tasks.length <= 1) {
        return tasks;
    }

    const merged: PlanTask[] = [];
    for (const task of tasks) {
        const existing = merged.find((candidate) => {
            const overlap = writeSetOverlapRatio(candidate, task);
            if (overlap <= 0.7) return false;
            const similarity = jaccardSimilarity(
                `${candidate.title}\n${candidate.instructions}`,
                `${task.title}\n${task.instructions}`
            );
            return similarity > 0.65;
        });

        if (!existing) {
            merged.push(task);
            continue;
        }

        const nextDependsOn = Array.from(
            new Set(existing.dependsOn.concat(task.dependsOn))
        ).filter((id) => id !== existing.id);
        const nextWriteSet = Array.from(
            new Set(existing.taskWriteSet.concat(task.taskWriteSet))
        ).sort((a, b) => a.localeCompare(b));

        existing.instructions = `${existing.instructions}\n\n${task.instructions}`.trim();
        existing.dependsOn = nextDependsOn;
        existing.taskWriteSet = nextWriteSet;
        existing.objectiveType = mergeObjectiveType(
            existing.objectiveType ?? "direct_fix",
            task.objectiveType ?? "direct_fix"
        );
        existing.fileContracts = mergeFileContractLists(
            existing.fileContracts ?? [],
            task.fileContracts ?? []
        );
    }

    const validTaskIds = new Set(merged.map((task) => task.id));
    for (const task of merged) {
        task.dependsOn = task.dependsOn.filter((depId) => validTaskIds.has(depId));
    }

    return merged;
}

export function normalizePlanResponse(
    candidate: unknown,
    fallbackPrompt: string,
    options?: { minTasks?: number; maxTasks?: number; executionMode?: ExecutionMode }
): PlanResponse {
    const executionMode = options?.executionMode ?? "feature_mode";
    const modeMaxTasks = executionMode === "followup_fix_mode" ? 3 : MAX_PLAN_TASKS;
    const maxTasks = Math.max(1, Math.min(modeMaxTasks, options?.maxTasks ?? modeMaxTasks));
    const defaultMin = executionMode === "followup_fix_mode" ? 1 : 1;
    const minTasks = Math.max(1, Math.min(maxTasks, options?.minTasks ?? defaultMin));
    const plan = candidate as Partial<PlanResponse>;
    const tasks = Array.isArray(plan.tasks)
        ? plan.tasks
            .map((task) => {
                if (!task || typeof task !== "object") return null;
                const row = task as Partial<PlanTask>;
                if (!row.id || !row.title || !row.instructions) return null;
                const rawDeps = Array.isArray(row.dependsOn) ? row.dependsOn : [];
                const rawWriteSet = Array.isArray(row.taskWriteSet)
                    ? row.taskWriteSet
                    : [];
                const taskWriteSet = rawWriteSet
                    .map((path) => (typeof path === "string" ? path.trim() : ""))
                    .filter(Boolean)
                    .map((path) => {
                        try {
                            return normalizePath(path);
                        } catch {
                            return null;
                        }
                    })
                    .filter((path): path is string => Boolean(path));

                if (taskWriteSet.length === 0) {
                    return null;
                }

                return {
                    id: String(row.id),
                    title: String(row.title),
                    instructions: String(row.instructions),
                    objectiveType: normalizeObjectiveType(
                        row.objectiveType,
                        String(row.title),
                        String(row.instructions)
                    ),
                    dependsOn: rawDeps.map(String),
                    taskWriteSet,
                    fileContracts: normalizeFileContracts(row.fileContracts),
                } satisfies PlanTask;
            })
            .filter((task) => task !== null)
            .slice(0, maxTasks)
        : [];

    const dedupedTasks = mergeOverlappingTasks(tasks);

    // Validate dependsOn references — strip IDs that don't match any task
    const taskIds = new Set(dedupedTasks.map((t) => t.id));
    for (const task of dedupedTasks) {
        task.dependsOn = task.dependsOn.filter((dep) => taskIds.has(dep));
    }

    const normalizedTasks = dedupedTasks.filter((task, index, array) => {
        const signal = `${task.title}\n${task.instructions}`.toLowerCase();
        const looksAnalysisOnly = /\b(analyze|investigate|diagnose|inspect)\b/.test(signal);
        if (!looksAnalysisOnly) return true;
        if (task.objectiveType === "direct_fix") return true;

        return !array.some((other) => {
            if (other.id === task.id) return false;
            if (other.objectiveType !== "direct_fix") return false;
            const left = new Set(task.taskWriteSet);
            const right = new Set(other.taskWriteSet);
            if (left.size !== right.size) return false;
            for (const path of left) {
                if (!right.has(path)) return false;
            }
            return true;
        });
    });

    if (normalizedTasks.length === 0) {
        return {
            summary: "Single-pass implementation task",
            tasks: [
                {
                    id: "task-1",
                    title: "Implement user request",
                    instructions: fallbackPrompt,
                    objectiveType: executionMode === "followup_fix_mode" ? "direct_fix" : "supporting_refactor",
                    dependsOn: [],
                    taskWriteSet: ["src/App.jsx"],
                },
            ],
        };
    }

    if (executionMode !== "followup_fix_mode" && normalizedTasks.length < minTasks) {
        const lastTask = normalizedTasks[normalizedTasks.length - 1];
        while (normalizedTasks.length < minTasks) {
            const nextIndex = normalizedTasks.length + 1;
            normalizedTasks.push({
                id: `task-${nextIndex}`,
                title: `Implementation continuation ${nextIndex}`,
                instructions: fallbackPrompt,
                objectiveType: "supporting_refactor",
                dependsOn: lastTask ? [lastTask.id] : [],
                taskWriteSet: lastTask?.taskWriteSet.length
                    ? [...lastTask.taskWriteSet]
                    : ["src/App.jsx"],
            });
        }
    }

    return {
        summary:
            typeof plan.summary === "string" && plan.summary.trim()
                ? plan.summary.trim()
                : "Execution plan",
        tasks: normalizedTasks.slice(0, maxTasks),
    };
}

export function normalizeSpecResponse(candidate: unknown, userPrompt: string): SpecResponse {
    const payload = candidate as Partial<SpecResponse>;
    const toList = (value: unknown, fallback: string[] = []) =>
        Array.isArray(value)
            ? value
                .map((item) => (typeof item === "string" ? item.trim() : ""))
                .filter(Boolean)
            : fallback;

    const requirements = toList(payload.requirements, [userPrompt]);
    const acceptanceCriteria = toList(payload.acceptanceCriteria, [
        "Primary user request is implemented and functional in preview.",
        "Generated app renders without runtime crash in sandbox preview.",
        "Core interactions requested by user are usable.",
    ]);
    const testChecklist = toList(payload.testChecklist, [
        "Open app in preview and verify first render is successful.",
        "Verify primary user interaction path works end-to-end.",
        "Verify no uncaught runtime error appears in console.",
    ]);

    return {
        summary:
            typeof payload.summary === "string" && payload.summary.trim()
                ? payload.summary.trim()
                : "Build the requested product with production-ready quality.",
        requirements,
        acceptanceCriteria,
        nonGoals: toList(payload.nonGoals, []),
        testChecklist,
    };
}

export function normalizeOperationResponse(candidate: unknown): OperationResponse {
    const payload = candidate as Partial<OperationResponse>;
    const operations = Array.isArray(payload.operations)
        ? payload.operations
            .map((operation) => {
                if (!operation || typeof operation !== "object") return null;
                const raw = operation as Partial<FileOperation>;
                if (typeof raw.path !== "string" || !raw.path.trim()) return null;

                if (raw.op === "upsert") {
                    if (typeof raw.code !== "string" || !raw.code.trim()) return null;
                    return {
                        op: "upsert",
                        path: raw.path,
                        code: raw.code,
                        language: raw.language,
                    };
                }

                if (raw.op === "delete") {
                    return {
                        op: "delete",
                        path: raw.path,
                    };
                }

                if (raw.op === "json_manifest_update") {
                    if (!JSON_MANIFEST_TARGET_PATH_PATTERN.test(raw.path.trim())) {
                        return null;
                    }
                    if (!raw.merge || typeof raw.merge !== "object" || Array.isArray(raw.merge)) {
                        return null;
                    }
                    return {
                        op: "json_manifest_update",
                        path: raw.path,
                        merge: raw.merge as Record<string, unknown>,
                    };
                }

                return null;
            })
            .filter((operation): operation is FileOperation => operation !== null)
        : [];

    return {
        summary:
            typeof payload.summary === "string" && payload.summary.trim()
                ? payload.summary.trim()
                : "Applied file operations",
        operations,
    };
}

export function normalizeQaResponse(candidate: unknown, acceptanceFallback: string[]): QaResponse {
    const payload = candidate as Partial<QaResponse>;
    const score =
        typeof payload.score === "number" && Number.isFinite(payload.score)
            ? Math.max(0, Math.min(100, Math.round(payload.score)))
            : 0;
    const toList = (value: unknown) =>
        Array.isArray(value)
            ? value
                .map((item) => (typeof item === "string" ? item.trim() : ""))
                .filter(Boolean)
            : [];

    const acceptance: QaAcceptanceItem[] = Array.isArray(payload.acceptance)
        ? payload.acceptance
            .map((item) => {
                if (!item || typeof item !== "object") return null;
                const row = item as Partial<QaAcceptanceItem>;
                if (
                    typeof row.criterion !== "string" ||
                    typeof row.evidence !== "string" ||
                    (row.status !== "pass" && row.status !== "partial" && row.status !== "fail")
                ) {
                    return null;
                }

                return {
                    criterion: row.criterion.trim(),
                    status: row.status,
                    evidence: row.evidence.trim(),
                } satisfies QaAcceptanceItem;
            })
            .filter((item): item is QaAcceptanceItem => Boolean(item && item.criterion && item.evidence))
        : acceptanceFallback.map((criterion) => ({
            criterion,
            status: "partial" as const,
            evidence: "Not explicitly evaluated.",
        }));

    const hardBlockers = toList(payload.hardBlockers);
    const attempt =
        typeof payload.attempt === "number" && Number.isFinite(payload.attempt)
            ? Math.max(1, Math.floor(payload.attempt))
            : 1;
    const maxAttempts =
        typeof payload.maxAttempts === "number" && Number.isFinite(payload.maxAttempts)
            ? Math.max(attempt, Math.floor(payload.maxAttempts))
            : attempt;
    const blockingDecisionRaw =
        typeof payload.blockingDecision === "string" ? payload.blockingDecision : "";
    const blockingDecision: QaResponse["blockingDecision"] =
        blockingDecisionRaw === "pass" ||
            blockingDecisionRaw === "remediate" ||
            blockingDecisionRaw === "fail_no_improvement" ||
            blockingDecisionRaw === "fail_max_passes" ||
            blockingDecisionRaw === "fail"
            ? blockingDecisionRaw
            : hardBlockers.length > 0
                ? "remediate"
                : "pass";

    return {
        score,
        summary:
            typeof payload.summary === "string" && payload.summary.trim()
                ? payload.summary.trim()
                : "Quality assessment completed.",
        hardBlockers,
        softBlockers: toList(payload.softBlockers),
        warnings: toList(payload.warnings),
        acceptance,
        suggestedFixes: toList(payload.suggestedFixes),
        attempt,
        maxAttempts,
        blockingDecision,
    };
}

export function normalizeArchitectPlanResponse(
    candidate: unknown,
    fallbackPrompt: string
): ArchitectPlanResponse {
    const payload = candidate as Partial<ArchitectPlanResponse>;
    const summary = typeof payload.summary === "string" ? payload.summary.trim() : "Architectural plan";

    // Normalize tasks using the existing plan normalizer logic for task list.
    const planResponse = normalizePlanResponse({ summary: payload.summary, tasks: payload.tasks }, fallbackPrompt);
    const taskContracts = planResponse.tasks.flatMap((task) => task.fileContracts ?? []);
    const topLevelContracts = normalizeFileContracts(payload.fileContracts);
    const fileContracts = mergeFileContractLists(taskContracts, topLevelContracts);
    const contractsByPath = new Map(fileContracts.map((contract) => [contract.path, contract]));
    const hydratedTasks = planResponse.tasks.map((task) => {
        if (task.fileContracts && task.fileContracts.length > 0) {
            return task;
        }
        const fallbackContracts = task.taskWriteSet
            .map((path) => contractsByPath.get(path))
            .filter((contract): contract is FileContract => Boolean(contract));
        return fallbackContracts.length > 0
            ? {
                ...task,
                fileContracts: fallbackContracts,
            }
            : task;
    });

    return {
        summary,
        tasks: hydratedTasks,
        fileContracts,
        dbSchema:
            typeof payload.dbSchema === "string" && payload.dbSchema.trim().length > 0
                ? payload.dbSchema.trim()
                : undefined,
    };
}

export function normalizePlanOutlineResponse(
    candidate: unknown,
    fallbackPrompt: string,
    options?: { minTasks?: number; maxTasks?: number; executionMode?: ExecutionMode }
): PlanOutlineResponse {
    return normalizePlanResponse(candidate, fallbackPrompt, options);
}

function inferRouteOwnership(path: string): string | undefined {
    const lower = path.toLowerCase();
    if (/(^|\/)(routes?|pages?)\//.test(lower) || /(^|\/)app\.(jsx?|tsx?)$/.test(lower)) {
        return `route:${path}`;
    }
    return undefined;
}

function normalizeSkeletonDagNodes(
    rawNodes: unknown,
    fileContracts: FileContract[]
): SkeletonDagNode[] {
    const contractByPath = new Map(fileContracts.map((contract) => [contract.path, contract]));
    const normalizedFromPayload = Array.isArray(rawNodes)
        ? rawNodes
            .map((node) => {
                if (!node || typeof node !== "object") return null;
                const row = node as Record<string, unknown>;
                const rawPath = typeof row.path === "string" ? row.path.trim() : "";
                if (!rawPath) return null;
                let path: string;
                try {
                    path = normalizePath(rawPath);
                } catch {
                    return null;
                }

                const contract = contractByPath.get(path);
                const imports = normalizeFileContracts([
                    {
                        path,
                        purpose: typeof row.purpose === "string" ? row.purpose : contract?.purpose ?? "",
                        imports: row.imports ?? contract?.imports ?? [],
                        exports: row.exports ?? contract?.exports ?? [],
                        dbQueries: row.dbQueries ?? contract?.dbQueries ?? [],
                    },
                ])[0];
                if (!imports) {
                    return null;
                }

                const dependsOnPaths = Array.isArray(row.dependsOnPaths)
                    ? row.dependsOnPaths
                        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
                        .filter(Boolean)
                        .map((entry) => {
                            try {
                                return normalizePath(entry);
                            } catch {
                                return null;
                            }
                        })
                        .filter((entry): entry is string => Boolean(entry))
                    : imports.imports
                        .map((entry) => entry.source)
                        .filter((source) => source.startsWith(".") || source.startsWith("src/"))
                        .map((source) => {
                            const normalizedSource = source.replace(/^\.\//, "").replace(/^src\//, "");
                            const candidate = fileContracts.find(
                                (contractCandidate) =>
                                    contractCandidate.path.endsWith(normalizedSource) ||
                                    contractCandidate.path === source
                            );
                            return candidate?.path ?? null;
                        })
                        .filter((entry): entry is string => Boolean(entry));

                const externalLibraries = Array.isArray(row.externalLibraries)
                    ? Array.from(
                        new Set(
                            row.externalLibraries
                                .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
                                .filter(Boolean)
                        )
                    )
                    : [];

                const routeOwnership =
                    typeof row.routeOwnership === "string" && row.routeOwnership.trim().length > 0
                        ? row.routeOwnership.trim()
                        : inferRouteOwnership(path);

                return {
                    path,
                    purpose: imports.purpose,
                    imports: imports.imports,
                    exports: imports.exports,
                    ...(imports.dbQueries ? { dbQueries: imports.dbQueries } : {}),
                    ...(routeOwnership ? { routeOwnership } : {}),
                    externalLibraries,
                    dependsOnPaths: Array.from(new Set(dependsOnPaths)).sort((a, b) => a.localeCompare(b)),
                } satisfies SkeletonDagNode;
            })
            .filter((node): node is SkeletonDagNode => Boolean(node))
        : [];

    const map = new Map<string, SkeletonDagNode>();
    for (const node of normalizedFromPayload) {
        map.set(node.path, node);
    }
    for (const contract of fileContracts) {
        if (map.has(contract.path)) {
            continue;
        }
        const inferredDependencies = contract.imports
            .map((entry) => entry.source)
            .filter((source) => source.startsWith(".") || source.startsWith("src/"))
            .map((source) => {
                const normalizedSource = source.replace(/^\.\//, "").replace(/^src\//, "");
                const candidate = fileContracts.find(
                    (contractCandidate) =>
                        contractCandidate.path.endsWith(normalizedSource) ||
                        contractCandidate.path === source
                );
                return candidate?.path ?? null;
            })
            .filter((entry): entry is string => Boolean(entry));
        map.set(contract.path, {
            path: contract.path,
            purpose: contract.purpose,
            imports: contract.imports,
            exports: contract.exports,
            ...(contract.dbQueries ? { dbQueries: contract.dbQueries } : {}),
            ...(inferRouteOwnership(contract.path)
                ? { routeOwnership: inferRouteOwnership(contract.path) }
                : {}),
            externalLibraries: [],
            dependsOnPaths: Array.from(new Set(inferredDependencies)).sort((a, b) => a.localeCompare(b)),
        });
    }

    const validPaths = new Set(map.keys());
    for (const node of map.values()) {
        node.dependsOnPaths = node.dependsOnPaths.filter(
            (depPath) => validPaths.has(depPath) && depPath !== node.path
        );
    }

    return Array.from(map.values()).sort((left, right) => left.path.localeCompare(right.path));
}

const APP_ROOT_PATH_PATTERN = /^src\/App\.(jsx|tsx|js|ts)$/;

export function normalizeSkeletonSpecDagResponse(
    candidate: unknown,
    fallbackPrompt: string
): SkeletonSpecDagResponse {
    const payload = candidate as Partial<SkeletonSpecDagResponse & ArchitectPlanResponse>;
    const plan = normalizeArchitectPlanResponse(payload, fallbackPrompt);
    const nodes = normalizeSkeletonDagNodes((payload as { nodes?: unknown }).nodes, plan.fileContracts);
    // The system-owned src/main.jsx renders src/App.jsx unconditionally, so a
    // DAG that forgets the app root is guaranteed to fail skeleton
    // validation on an unresolved import the model is not allowed to fix.
    // Inject it deterministically, depending on every other node so it is
    // generated last with the full set of sibling signatures available.
    const hasAppRoot =
        nodes.some((node) => APP_ROOT_PATH_PATTERN.test(node.path)) ||
        plan.fileContracts.some((contract) => APP_ROOT_PATH_PATTERN.test(contract.path));
    if (!hasAppRoot && nodes.length > 0) {
        const appExports = [
            {
                name: "App",
                kind: "default" as const,
                signature: "function App(): JSX element",
                description:
                    "Root application component rendered by src/main.jsx; composes the feature components into the page.",
            },
        ];
        plan.fileContracts.push({
            path: "src/App.jsx",
            purpose: "Application root that composes the generated feature components.",
            imports: [],
            exports: appExports,
        });
        nodes.push({
            path: "src/App.jsx",
            purpose: "Application root that composes the generated feature components.",
            imports: [],
            exports: appExports,
            externalLibraries: [],
            dependsOnPaths: nodes.map((node) => node.path),
        });
    }
    return {
        summary:
            typeof payload.summary === "string" && payload.summary.trim().length > 0
                ? payload.summary.trim()
                : "Skeleton DAG",
        tasks: plan.tasks,
        fileContracts: plan.fileContracts,
        nodes,
        dbSchema: plan.dbSchema,
    };
}

function toIssuePath(issue: string): string | null {
    const separatorIndex = issue.indexOf(":");
    if (separatorIndex <= 0) return null;
    const rawPath = issue.slice(0, separatorIndex).trim();
    if (!rawPath) return null;
    try {
        return normalizePath(rawPath);
    } catch {
        return null;
    }
}

export function normalizeFixDagResponse(
    candidate: unknown,
    fallbackIssues: string[],
    availablePaths: string[]
): FixDagResponse {
    const payload = candidate as Partial<FixDagResponse>;
    const fallbackPaths = Array.from(
        new Set(
            fallbackIssues
                .map((issue) => toIssuePath(issue))
                .filter((issuePath): issuePath is string => Boolean(issuePath))
        )
    ).filter((path) => availablePaths.includes(path));
    const allowedPaths = new Set(availablePaths.map((path) => normalizePath(path)));
    const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const normalizedTasks: FixDagTask[] = rawTasks
        .map((task, index) => {
            if (!task || typeof task !== "object") return null;
            const row = task as Partial<FixDagTask>;
            const rawWriteSet = Array.isArray(row.taskWriteSet) ? row.taskWriteSet : [];
            const taskWriteSet = rawWriteSet
                .map((rawPath) => (typeof rawPath === "string" ? rawPath.trim() : ""))
                .filter(Boolean)
                .map((rawPath) => {
                    try {
                        return normalizePath(rawPath);
                    } catch {
                        return null;
                    }
                })
                .filter((normalizedPath): normalizedPath is string => Boolean(normalizedPath))
                .filter((normalizedPath) => allowedPaths.has(normalizedPath));
            const issues = Array.isArray(row.issues)
                ? row.issues
                    .map((issue) => (typeof issue === "string" ? issue.trim() : ""))
                    .filter(Boolean)
                : [];
            if (
                !row.id ||
                !row.title ||
                !row.instructions ||
                taskWriteSet.length === 0 ||
                issues.length === 0
            ) {
                return null;
            }
            const dependsOn = Array.isArray(row.dependsOn)
                ? row.dependsOn.map(String).filter(Boolean)
                : [];
            return {
                id: String(row.id),
                title: String(row.title),
                instructions: String(row.instructions),
                dependsOn,
                taskWriteSet,
                issues,
            } satisfies FixDagTask;
        })
        .filter((task): task is FixDagTask => Boolean(task));

    if (normalizedTasks.length === 0) {
        return {
            summary: "Single remediation task",
            tasks: [
                {
                    id: "fix-1",
                    title: "Resolve validation/runtime blockers",
                    instructions: "Apply targeted fixes for the reported blockers.",
                    dependsOn: [],
                    taskWriteSet: fallbackPaths.length > 0 ? fallbackPaths : availablePaths.slice(0, 12),
                    issues: fallbackIssues.length > 0 ? fallbackIssues : ["Unknown validation/runtime blocker"],
                },
            ],
        };
    }

    const validTaskIds = new Set(normalizedTasks.map((task) => task.id));
    for (const task of normalizedTasks) {
        task.dependsOn = task.dependsOn.filter((depId) => validTaskIds.has(depId) && depId !== task.id);
    }

    return {
        summary:
            typeof payload.summary === "string" && payload.summary.trim().length > 0
                ? payload.summary.trim()
                : "Remediation DAG",
        tasks: normalizedTasks,
    };
}
