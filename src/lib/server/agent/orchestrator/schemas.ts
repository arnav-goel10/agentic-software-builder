// orchestrator/schemas.ts — JSON schemas for structured LLM output
export const SPEC_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "requirements", "acceptanceCriteria", "nonGoals", "testChecklist"],
    properties: {
        summary: { type: "string", minLength: 1 },
        requirements: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        acceptanceCriteria: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        nonGoals: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        testChecklist: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
    },
} as const;

export const PLAN_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "tasks"],
    properties: {
        summary: { type: "string", minLength: 1 },
        tasks: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                additionalProperties: true,
                required: ["id", "title", "instructions", "taskWriteSet"],
                properties: {
                    id: { type: "string", minLength: 1 },
                    title: { type: "string", minLength: 1 },
                    instructions: { type: "string", minLength: 1 },
                    objectiveType: {
                        type: "string",
                        enum: ["direct_fix", "supporting_refactor", "verification"],
                    },
                    dependsOn: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                    },
                    taskWriteSet: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", minLength: 1 },
                    },
                },
            },
        },
    },
} as const;

export const PLAN_OUTLINE_SCHEMA = PLAN_SCHEMA;

// ─── Skeleton-First Architecture Schemas ────────────────────────

const FILE_CONTRACT_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["path", "purpose", "imports", "exports"],
    properties: {
        path: { type: "string", minLength: 1 },
        purpose: { type: "string", minLength: 1 },
        imports: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: true,
                required: ["source", "names"],
                properties: {
                    source: { type: "string", minLength: 1 },
                    names: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                    },
                },
            },
        },
        exports: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: true,
                required: ["name", "kind", "signature", "description"],
                properties: {
                    name: { type: "string", minLength: 1 },
                    kind: {
                        type: "string",
                        enum: ["function", "const", "class", "default", "type"],
                    },
                    signature: { type: "string", minLength: 1 },
                    description: { type: "string", minLength: 1 },
                },
            },
        },
        dbQueries: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: true,
                required: ["operation", "table", "description"],
                properties: {
                    operation: {
                        type: "string",
                        enum: ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE"],
                    },
                    table: { type: "string", minLength: 1 },
                    description: { type: "string", minLength: 1 },
                },
            },
        },
    },
} as const;

export const SKELETON_SPEC_DAG_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "tasks", "fileContracts", "nodes"],
    properties: {
        summary: { type: "string", minLength: 1 },
        dbSchema: { type: "string" },
        tasks: PLAN_SCHEMA.properties.tasks,
        fileContracts: {
            type: "array",
            minItems: 1,
            items: FILE_CONTRACT_SCHEMA,
        },
        nodes: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                additionalProperties: true,
                required: [
                    "path",
                    "purpose",
                    "imports",
                    "exports",
                    "externalLibraries",
                    "dependsOnPaths",
                ],
                properties: {
                    path: { type: "string", minLength: 1 },
                    purpose: { type: "string", minLength: 1 },
                    imports: FILE_CONTRACT_SCHEMA.properties.imports,
                    exports: FILE_CONTRACT_SCHEMA.properties.exports,
                    dbQueries: FILE_CONTRACT_SCHEMA.properties.dbQueries,
                    routeOwnership: { type: "string" },
                    externalLibraries: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                    },
                    dependsOnPaths: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                    },
                },
            },
        },
    },
} as const;

export const SKELETON_FILL_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "operations"],
    properties: {
        summary: { type: "string", minLength: 1 },
        operations: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                additionalProperties: true,
                required: ["op", "path", "code"],
                properties: {
                    op: { const: "upsert" },
                    path: { type: "string", minLength: 1 },
                    code: { type: "string", minLength: 1 },
                },
            },
        },
    },
} as const;

export const SKELETON_REGION_FILL_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "path", "regions"],
    properties: {
        summary: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        regions: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                additionalProperties: true,
                required: ["regionId", "body"],
                properties: {
                    regionId: { type: "string", minLength: 1 },
                    body: { type: "string" },
                },
            },
        },
    },
} as const;

export const SKELETON_AUTOFIX_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "operations"],
    properties: {
        summary: { type: "string", minLength: 1 },
        operations: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                additionalProperties: true,
                required: ["op", "path", "code"],
                properties: {
                    op: { const: "upsert" },
                    path: { type: "string", minLength: 1 },
                    code: { type: "string", minLength: 1 },
                },
            },
        },
    },
} as const;

export const FIX_DAG_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "tasks"],
    properties: {
        summary: { type: "string", minLength: 1 },
        tasks: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                additionalProperties: true,
                required: ["id", "title", "instructions", "taskWriteSet", "issues"],
                properties: {
                    id: { type: "string", minLength: 1 },
                    title: { type: "string", minLength: 1 },
                    instructions: { type: "string", minLength: 1 },
                    dependsOn: {
                        type: "array",
                        items: { type: "string", minLength: 1 },
                    },
                    taskWriteSet: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", minLength: 1 },
                    },
                    issues: {
                        type: "array",
                        minItems: 1,
                        items: { type: "string", minLength: 1 },
                    },
                },
            },
        },
    },
} as const;

export const OPERATIONS_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary", "operations"],
    properties: {
        summary: { type: "string", minLength: 1 },
        operations: {
            type: "array",
            items: {
                oneOf: [
                    {
                        type: "object",
                        additionalProperties: true,
                        required: ["op", "path", "code"],
                        properties: {
                            op: { const: "upsert" },
                            path: { type: "string", minLength: 1 },
                            code: { type: "string", minLength: 1 },
                            language: { type: "string" },
                        },
                    },
                    {
                        type: "object",
                        additionalProperties: true,
                        required: ["op", "path"],
                        properties: {
                            op: { const: "delete" },
                            path: { type: "string", minLength: 1 },
                        },
                    },
                    {
                        type: "object",
                        additionalProperties: true,
                        required: ["op", "path", "merge"],
                        properties: {
                            op: { const: "json_manifest_update" },
                            path: { type: "string", minLength: 1, pattern: "\\.json$" },
                            merge: { type: "object", additionalProperties: true },
                        },
                    },
                ],
            },
        },
    },
} as const;

export const SUMMARY_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: ["summary"],
    properties: {
        summary: { type: "string", minLength: 1 },
    },
} as const;

export const QA_SCHEMA = {
    type: "object",
    additionalProperties: true,
    required: [
        "score",
        "summary",
        "hardBlockers",
        "softBlockers",
        "warnings",
        "acceptance",
        "attempt",
        "maxAttempts",
        "blockingDecision",
    ],
    properties: {
        score: { type: "number", minimum: 0, maximum: 100 },
        summary: { type: "string", minLength: 1 },
        hardBlockers: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        softBlockers: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        warnings: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        acceptance: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: true,
                required: ["criterion", "status", "evidence"],
                properties: {
                    criterion: { type: "string", minLength: 1 },
                    status: { type: "string", enum: ["pass", "partial", "fail"] },
                    evidence: { type: "string", minLength: 1 },
                },
            },
        },
        suggestedFixes: {
            type: "array",
            items: { type: "string", minLength: 1 },
        },
        attempt: { type: "number", minimum: 1 },
        maxAttempts: { type: "number", minimum: 1 },
        blockingDecision: {
            type: "string",
            enum: ["pass", "remediate", "fail_no_improvement", "fail_max_passes", "fail"],
        },
    },
} as const;
