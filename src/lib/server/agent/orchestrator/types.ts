// orchestrator/types.ts — All type definitions for the orchestrator pipeline
import type { GeneratedFile } from "@/lib/server/types";
import type {
    ExecutionMode,
    NoOpClassification,
    TaskObjectiveType,
} from "@/lib/server/types";
import type { FileOperation } from "@/lib/server/agent/validation";

// ─── Skeleton-First Architecture: Contract Types ─────────────────

export interface ImportContract {
    /** Source module path, e.g. "../lib/db" */
    source: string;
    /** Named imports, e.g. ["getDb", "addHolding"] */
    names: string[];
}

export interface ExportContract {
    /** Export name, e.g. "useCoinGeckoPrices" */
    name: string;
    /** Export kind */
    kind: "function" | "const" | "class" | "default" | "type";
    /** Type signature, e.g. "(coinIds: string[]) => { data, isLoading, error }" */
    signature: string;
    /** What the export does — guides the coder model */
    description: string;
}

export interface DbQueryContract {
    /** SQL operation type */
    operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "CREATE";
    /** Target table name */
    table: string;
    /** What the query does */
    description: string;
}

export interface FileContract {
    /** Workspace-relative path, e.g. "src/hooks/useCoinGecko.js" */
    path: string;
    /** One-line purpose description */
    purpose: string;
    /** What this file imports from other project files */
    imports: ImportContract[];
    /** What this file exports */
    exports: ExportContract[];
    /** DB calls this file makes (optional) */
    dbQueries?: DbQueryContract[];
}

export interface SkeletonFile {
    /** Workspace-relative path */
    path: string;
    /** Skeleton code with function stubs and TODO: FILL_IN markers */
    skeleton: string;
    /** Cross-file contracts this file depends on (for coder context) */
    dependencyContracts: FileContract[];
}

export interface ArchitectPlanResponse {
    summary: string;
    tasks: PlanTask[];
    /** Global DB schema (shared across all tasks) */
    dbSchema?: string;
    /** All file contracts for the project */
    fileContracts: FileContract[];
}

export interface PlanOutlineResponse {
    summary: string;
    tasks: PlanTask[];
}

export interface SkeletonDagNode {
    path: string;
    purpose: string;
    imports: ImportContract[];
    exports: ExportContract[];
    dbQueries?: DbQueryContract[];
    routeOwnership?: string;
    externalLibraries: string[];
    dependsOnPaths: string[];
}

export interface SkeletonSpecDagResponse {
    summary: string;
    tasks: PlanTask[];
    fileContracts: FileContract[];
    nodes: SkeletonDagNode[];
    dbSchema?: string;
}

export interface FixDagTask {
    id: string;
    title: string;
    instructions: string;
    dependsOn: string[];
    taskWriteSet: string[];
    issues: string[];
}

export interface FixDagResponse {
    summary: string;
    tasks: FixDagTask[];
}

export interface StructureLock {
    path: string;
    regionIds: string[];
    templateHash: string;
}

// ─── Core Pipeline Types ─────────────────────────────────────────

export interface PlanTask {
    id: string;
    title: string;
    instructions: string;
    dependsOn: string[];
    taskWriteSet: string[];
    objectiveType?: TaskObjectiveType;
    /** Structured file contracts (skeleton-first mode only) */
    fileContracts?: FileContract[];
}

export interface SpecResponse {
    summary: string;
    requirements: string[];
    acceptanceCriteria: string[];
    nonGoals: string[];
    testChecklist: string[];
}

export interface PlanResponse {
    summary: string;
    tasks: PlanTask[];
}

export interface OperationResponse {
    summary: string;
    operations: FileOperation[];
}

export interface SummaryResponse {
    summary: string;
}

export interface QaAcceptanceItem {
    criterion: string;
    status: "pass" | "partial" | "fail";
    evidence: string;
}

export interface QaResponse {
    score: number;
    summary: string;
    hardBlockers: string[];
    softBlockers: string[];
    warnings: string[];
    acceptance: QaAcceptanceItem[];
    suggestedFixes?: string[];
    attempt?: number;
    maxAttempts?: number;
    blockingDecision?: "pass" | "remediate" | "fail_no_improvement" | "fail_max_passes" | "fail";
}

export interface ExecutionInput {
    runId: string;
}

export interface TaskContextPack {
    selectedFiles: GeneratedFile[];
    selectedNames: string[];
    treeDigest: string;
    fileCatalog: string;
    repoMapSummary: string;
}

export interface ModelTrace {
    provider: string;
    usage: {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
        cacheWriteInputTokens?: number;
    } | null;
    attempts: Array<{
        provider: string;
        model: string;
        ok: boolean;
        status?: number;
        durationMs: number;
        message?: string;
    }>;
}

export interface OperationResult {
    summary: string;
    operations: FileOperation[];
    trace: ModelTrace;
    contextFiles: string[];
    lengthFinishSignals?: number;
    noOpDecision?: NoOpTaskDecision;
}

export interface QaResult {
    qa: QaResponse;
    trace: ModelTrace;
}

export interface NoOpTaskDecision {
    classification: NoOpClassification;
    reason: string;
    deferred: boolean;
}

export interface RetrievedContextStats {
    tokenEstimate: number;
    tokenBudget: number;
    selectedCardIds: string[];
    droppedCardIds: string[];
    summaryIds: string[];
    recencyTurns: number;
    compacted: boolean;
}

export interface RunDiagnostics {
    executionMode?: ExecutionMode;
    specQualityScore: number;
    tasksPlanned: number;
    tasksCompleted: number;
    validationFailures: number;
    repairPasses: number;
    qaPasses: number;
    qaFixPasses: number;
    qaEscalations: number;
    totalOperations: number;
    totalUpserts: number;
    totalDeletes: number;
    noOpTasks: number;
    deferredTasks: number;
    fallbackSwitches: number;
    phaseTimeouts: number;
    invalidJsonIncidents: number;
    invalidSchemaIncidents: number;
}

export type CompletionMode = "strict" | "advisory_override";

export interface CandidateEvaluation {
    candidateId: number;
    providerModels: string[];
    modelTrace: ModelTrace | null;
    blockingIssues: number;
    runtimeDiagnostics: number;
    operationCount: number;
    droppedPaths: string[];
    selected: boolean;
    error?: string;
}
