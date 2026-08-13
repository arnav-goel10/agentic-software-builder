import type { FileContract, PlanTask, SpecResponse } from "./types";

export type PromptSkillId = "frontend-design" | "pglite-database" | "skeleton-contract";

export const FRONTEND_DESIGN_SKILL_PROMPT = `Skill active: frontend-design

Create distinctive, production-grade frontend interfaces with high design quality. Generates creative, polished code that avoids generic AI aesthetics.

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

Before coding, understand the context and commit to a BOLD aesthetic direction:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw, art deco/geometric, soft/pastel, industrial/utilitarian, etc. There are so many flavors to choose from. Use these for inspiration but design one that is true to the aesthetic direction.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Dexter is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.`;

const FRONTEND_KEYWORD_RE = /\b(frontend|front-end|ui|ux|website|web app|webpage|landing|portfolio|dashboard|component|layout|theme|typography|color|animation|motion|tailwind|responsive|design|redesign|visual)\b/i;
const BACKEND_ONLY_KEYWORD_RE = /\b(api only|backend only|server only|db only|database only|sql migration|worker|cron|batch job|cli tool|command line)\b/i;
const FRONTEND_PATH_RE =
    /^(src\/(app|pages|components|layouts|routes|features|styles|hooks)\/|src\/(App|main)\.[jt]sx?$|src\/index\.css$|index\.html$|tailwind\.config\.[cm]?[jt]s$|postcss\.config\.[cm]?[jt]s$)/i;

export function shouldApplyFrontendDesignSkill(input: {
    userPrompt: string;
    threadContext?: string;
    spec?: SpecResponse;
    task?: PlanTask;
    additionalInstructions?: string;
}): boolean {
    const joined = [
        input.userPrompt,
        input.threadContext ?? "",
        input.additionalInstructions ?? "",
        input.spec?.summary ?? "",
        ...(input.spec?.requirements ?? []),
        input.task?.title ?? "",
        input.task?.instructions ?? "",
    ]
        .join("\n")
        .toLowerCase();

    let score = 0;
    if (FRONTEND_KEYWORD_RE.test(joined)) {
        score += 2;
    }
    if (input.task?.taskWriteSet?.some((path) => FRONTEND_PATH_RE.test(path))) {
        score += 2;
    }
    const specSignals = [
        ...(input.spec?.requirements ?? []),
        ...(input.spec?.acceptanceCriteria ?? []),
        ...(input.spec?.testChecklist ?? []),
    ];
    if (specSignals.some((signal) => FRONTEND_KEYWORD_RE.test(signal))) {
        score += 1;
    }
    if (BACKEND_ONLY_KEYWORD_RE.test(joined) && score < 2) {
        return false;
    }
    return score >= 2;
}

export const PGLITE_DATABASE_SKILL_PROMPT = `Skill active: pglite-database

PGlite is an embedded PostgreSQL engine (NOT SQLite). All SQL MUST use PostgreSQL syntax.

## Required Patterns
- Auto-increment IDs: \`id SERIAL PRIMARY KEY\` (never AUTOINCREMENT)
- Booleans: \`BOOLEAN NOT NULL DEFAULT FALSE\` (never INTEGER 0/1)
- Timestamps: \`NOW()\` or \`CURRENT_TIMESTAMP\` (never datetime('now'))
- Parameterized queries: \`db.query('SELECT * FROM t WHERE id = $1', [id])\` (never string interpolation)
- Query result shape safety: normalize \`db.query(...)\` output before iteration. Use \`const rows = Array.isArray(result) ? result : Array.isArray(result?.rows) ? result.rows : [];\` before \`.map/.reduce/.filter\`.
- Schema introspection: \`SELECT column_name FROM information_schema.columns WHERE table_name = $1\` (never PRAGMA)
- Boolean toggle: \`UPDATE t SET flag = NOT flag WHERE id = $1\` (never CASE WHEN 1 THEN 0 ELSE 1)

## Forbidden SQLite Syntax (will cause runtime errors)
AUTOINCREMENT, PRAGMA, datetime('now'), GLOB, typeof(), IFNULL() (use COALESCE), GROUP_CONCAT() (use STRING_AGG), INTEGER for boolean columns.

## Init Pattern
Import with named import only. Single DB module. Export shared instance:
\`\`\`
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite("idb://app-db");
await db.waitReady; // promise property, NOT a function call
export const db = getDb();
\`\`\``;

const PGLITE_KEYWORD_RE = /\b(database|db|postgres|pglite|sql|table|schema|persist|persistence|storage|save|crud|auth|login|sign[\s-]?in|sign[\s-]?up|account|session|backend)\b/i;
const PGLITE_PATH_RE = /^(src\/)?(lib\/)?db\.[jt]sx?$/i;

export function shouldApplyPgliteDatabaseSkill(input: {
    userPrompt: string;
    threadContext?: string;
    spec?: SpecResponse;
    task?: PlanTask;
    additionalInstructions?: string;
}): boolean {
    const joined = [
        input.userPrompt,
        input.threadContext ?? "",
        input.additionalInstructions ?? "",
        input.spec?.summary ?? "",
        ...(input.spec?.requirements ?? []),
        input.task?.title ?? "",
        input.task?.instructions ?? "",
    ]
        .join("\n")
        .toLowerCase();

    let score = 0;
    if (PGLITE_KEYWORD_RE.test(joined)) {
        score += 2;
    }
    if (input.task?.taskWriteSet?.some((path) => PGLITE_PATH_RE.test(path))) {
        score += 3;
    }
    if (/@electric-sql\/pglite/.test(joined) || /idb:\/\//.test(joined)) {
        score += 3;
    }
    const specSignals = [
        ...(input.spec?.requirements ?? []),
        ...(input.spec?.acceptanceCriteria ?? []),
    ];
    if (specSignals.some((signal) => PGLITE_KEYWORD_RE.test(signal))) {
        score += 1;
    }
    return score >= 2;
}

export const SKELETON_CONTRACT_SKILL_PROMPT = `Skill active: skeleton-contract-adherence

This task involves filling in or modifying files that have explicit architectural contracts (imports/exports).
You MUST honor the pre-scaffolded structure.

## Rules
1. **Preserve Exports**: If a file skeleton exports function \`foo()\`, you MUST implement \`foo()\` with that exact name and signature. Do NOT rename it.
2. **Preserve Imports**: If a file skeleton imports \`bar\` from \`./utils\`, you MUST keep that import. The architecture relies on this dependency graph.
3. **No Ghost Exports**: Do not add new named exports unless absolutely necessary. The architect has already defined the public API of this module.
4. **Implementation Only**: Focus on filling the \`// TODO: FILL_IN\` blocks. Do not rewrite the file structure valid logic outside the function bodies.
`;

// ─── Skeleton Contract Skill Detection ───────────────────────────

export function shouldApplySkeletonContractSkill(input: {
    fileContracts?: FileContract[];
    pipelinePhase?: string;
}): boolean {
    if (input.fileContracts && input.fileContracts.length > 0) {
        return true;
    }
    if (input.pipelinePhase) {
        const skeletonPhases = [
            "coder-fill",
            "skeleton-files",
            "skeleton-autofix",
            "skeleton-dag",
            "missing-fill-regions",
        ];
        return skeletonPhases.includes(input.pipelinePhase);
    }
    return false;
}

// ─── Centralized Skill Resolution ────────────────────────────────

export type ResolvedSkills = {
    frontendDesign: boolean;
    pgliteDatabase: boolean;
    skeletonContract: boolean;
    /** Pre-built prompt block containing all active skill prompts, ready
     *  to concatenate into a user prompt array. Empty string if no skills active. */
    skillsPromptBlock: string;
};

/**
 * Evaluates all skill heuristics once and returns both individual results
 * and a pre-built prompt block. Use this instead of calling each
 * `shouldApply*` function independently in every generator.
 */
export function resolveActiveSkills(input: {
    userPrompt: string;
    threadContext?: string;
    spec?: SpecResponse;
    task?: PlanTask;
    additionalInstructions?: string;
    fileContracts?: FileContract[];
    pipelinePhase?: string;
}): ResolvedSkills {
    const frontendDesign = shouldApplyFrontendDesignSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
        task: input.task,
        additionalInstructions: input.additionalInstructions,
    });
    const pgliteDatabase = shouldApplyPgliteDatabaseSkill({
        userPrompt: input.userPrompt,
        threadContext: input.threadContext,
        spec: input.spec,
        task: input.task,
        additionalInstructions: input.additionalInstructions,
    });
    const skeletonContract = shouldApplySkeletonContractSkill({
        fileContracts: input.fileContracts,
        pipelinePhase: input.pipelinePhase,
    });

    const parts: string[] = [];
    if (frontendDesign) parts.push(FRONTEND_DESIGN_SKILL_PROMPT);
    if (pgliteDatabase) parts.push(PGLITE_DATABASE_SKILL_PROMPT);
    if (skeletonContract) parts.push(SKELETON_CONTRACT_SKILL_PROMPT);

    return {
        frontendDesign,
        pgliteDatabase,
        skeletonContract,
        skillsPromptBlock: parts.join("\n\n"),
    };
}

