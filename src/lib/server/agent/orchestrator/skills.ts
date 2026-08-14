import type { DesignLanguage, FileContract, PlanTask, SpecResponse } from "./types";
import { isServerOwnedPath } from "@/lib/server/agent/validation";

export type PromptSkillId = "frontend-design" | "pglite-database" | "skeleton-contract";

export const FRONTEND_DESIGN_SKILL_PROMPT = `Skill active: frontend-design

Create distinctive, production-grade frontend interfaces with high design quality. Generates creative, polished code that avoids generic AI aesthetics.

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Design Thinking

A specific design language has been chosen for this project (see the "Design language" block below) — execute it with precision rather than picking your own aesthetic direction. Before coding, hold the purpose and audience in mind, honor the framework/performance/accessibility constraints, and ask what makes this UNFORGETTABLE within that language's bounds.

**CRITICAL**: Execute the chosen conceptual direction with precision. Bold maximalism and refined minimalism both work within different languages — the key is intentionality, not intensity.

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

// ─── Design Languages ─────────────────────────────────────────────
//
// Chosen at spec time (SpecResponse.designLanguage) instead of leaving the
// aesthetic direction fully freeform every run. Each block below is
// concrete enough to execute directly: palette, type scale, spacing,
// component character. The diversity-seed mechanism in starter-templates.ts
// (typography/color-system/layout-rhythm hashes) still applies on top of
// whichever language is chosen, so two "minimal-light" runs still vary in
// specifics even though they share the same design family.

export const DEFAULT_DESIGN_LANGUAGE: DesignLanguage = "minimal-light";

export const DESIGN_LANGUAGE_IDS: DesignLanguage[] = [
    "minimal-light",
    "editorial-bold",
    "dense-dashboard",
    "playful-rounded",
    "dark-glass",
];

export const DESIGN_LANGUAGE_PROMPTS: Record<DesignLanguage, string> = {
    "minimal-light": `Design language: minimal-light (Apple-like restraint)
- Palette: near-white surfaces (#fafafa/#ffffff), near-black ink text (#111114), ONE quiet accent color used sparingly (links, primary buttons, focus rings only). No gradients, no decorative color.
- Type scale: one refined sans (system-ui/SF-like stack or a single distinctive sans import) at a tight, deliberate scale — e.g. 13/15/17/22/32/44px. Generous line-height (1.5+) on body text. Weight does the work, not size jumps.
- Spacing: an 8px base rhythm; whitespace is the primary design tool. Let content breathe — err toward more margin, not less.
- Components: flat or near-flat (shadow-sm at most), 1px hairline borders in a soft gray, 8-10px radii, no visible chrome beyond what's functional. Every element earns its place.
- Motion: subtle only — 150-200ms ease-out fades/translates on state change. Never decorative animation.`,
    "editorial-bold": `Design language: editorial-bold (magazine)
- Palette: high-contrast — true black or ink navy text on warm off-white, with one saturated accent (editorial red, ochre, or cobalt) used only for pull quotes, rules, and CTAs.
- Type scale: a big, characterful serif or slab for headlines (48-96px, tight tracking, tight line-height) paired with a plain sans for body copy at 16-18px/1.6. Headline-to-body contrast should be dramatic.
- Spacing: generous margins, a strict column grid (e.g. 12-col), and pull quotes/rules that break the grid intentionally. Section breaks use thick horizontal rules, not just whitespace.
- Components: minimal chrome — text and imagery ARE the interface. Buttons are often just underlined text or a thin bordered rectangle, not a filled pill. Captions in a small caps or mono accent.
- Motion: reveal-on-scroll for headlines/images, otherwise static — the layout carries the drama, not animation.`,
    "dense-dashboard": `Design language: dense-dashboard (data-first)
- Palette: muted, low-saturation neutrals (slate/zinc grays) as the base, with 2-3 semantic colors reserved strictly for status (positive/negative/warning) — never decorative.
- Type scale: small and efficient — 11-13px for table/label text, 14-16px for primary values, one or two larger numerals (20-28px) for hero metrics. Tabular-nums for anything numeric.
- Spacing: compact — 4px base rhythm, tight padding (8-12px) inside cards/rows, dense grids of small cards/tables rather than a few large ones. Density is the point; nothing should feel sparse.
- Components: bordered cards/tables with sortable headers, sparklines, compact badges/pills for status, sticky headers on scrollable tables. Every panel has a clear, small label.
- Motion: near-none — instant state changes, maybe a 100ms fade on data refresh. Never let motion slow down scanning.`,
    "playful-rounded": `Design language: playful-rounded (springy)
- Palette: 2-3 vivid, saturated accent colors (not pastel-washed) on a clean light or soft-tinted base; color-blocked sections rather than gradients.
- Type scale: a rounded, friendly sans (or a bouncy display font for headlines) at a generous scale — headlines 32-56px, body 16-18px. Bold weights used liberally for emphasis.
- Spacing: loose and airy, generous padding (16-24px+), large tap targets. Cards float with visible gaps rather than touching.
- Components: large radii everywhere (16-24px, pill-shaped buttons), soft saturated shadows (not gray), icons and illustrations with rounded, friendly forms. Chips/badges in solid accent fills.
- Motion: springy and responsive — scale/bounce on press (spring easing, not linear), playful hover lifts, staggered entrance animations. Motion should feel tactile.`,
    "dark-glass": `Design language: dark-glass (frosted, restrained glow)
- Palette: deep dark surfaces (#0a0a0f-#16161d, not pure black) layered at 2-3 elevations, with ONE accent color reserved for primary actions/focus states and used sparingly as a glow — never as a dominant wash across the whole page.
- Type scale: a clean sans at moderate contrast against dark backgrounds (avoid pure white text — use a soft off-white like #e8e8ec to reduce glare); headlines 28-40px, body 15-16px.
- Spacing: an 8px base rhythm; let dark negative space separate frosted panels rather than crowding them together.
- Components: translucent/frosted panels (backdrop-blur + low-opacity fill + a subtle 1px light border) layered over the dark base to suggest depth; thin borders over heavy shadows. Reserve any glow/blur accent for one focal element per screen, not every card.
- Motion: smooth, deliberate fades/translates (200-300ms) on panel transitions; avoid flashy or constant glow pulsing — restraint is the point.`,
};

/** Injected into the spec-generation prompt so the model can decide. */
export const DESIGN_LANGUAGE_SPEC_GUIDANCE = `Design language selection:
Choose exactly one "designLanguage" for this project's frontend, plus a one-sentence "designLanguageReasoning".
- "minimal-light": Apple-like restraint — quiet neutral palette, one accent color, generous whitespace.
- "editorial-bold": magazine energy — big serif/display headlines, high contrast, strict grid, minimal chrome.
- "dense-dashboard": data-first — compact grids, muted palette, small efficient type, built for scanning numbers.
- "playful-rounded": vivid and springy — large radii, saturated accent colors, bouncy motion.
- "dark-glass": dark surfaces with frosted layered panels and one restrained glow accent.
Pick whichever best fits the brief's audience and purpose (a finance dashboard suits dense-dashboard; a kids' app suits playful-rounded; a portfolio suits editorial-bold or minimal-light; a night-mode creative tool suits dark-glass). Actively vary your choice across different projects rather than defaulting to the same language every time.`;

/**
 * Builds the full frontend-design prompt block for a given design language:
 * the universal craft guidance in FRONTEND_DESIGN_SKILL_PROMPT (typography/
 * motion/spatial-composition technique, avoiding generic AI aesthetics) plus
 * the concrete direction for the chosen language. Falls back to
 * DEFAULT_DESIGN_LANGUAGE when none is provided (e.g. legacy callers).
 */
export function buildFrontendDesignSkillPrompt(designLanguage?: DesignLanguage): string {
    const resolved = designLanguage ?? DEFAULT_DESIGN_LANGUAGE;
    const languageBlock = DESIGN_LANGUAGE_PROMPTS[resolved] ?? DESIGN_LANGUAGE_PROMPTS[DEFAULT_DESIGN_LANGUAGE];
    return `${FRONTEND_DESIGN_SKILL_PROMPT}\n\n${languageBlock}`;
}

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

// Server-side variant: injected instead of PGLITE_DATABASE_SKILL_PROMPT when
// the fill/edit target is under server/ (express-fullstack profile). PGlite
// also runs natively in Node, but the browser-only "idb://" dataDir scheme
// and WebContainer FS-bundle-recovery guidance above are meaningless (and
// misleading) for a server/db.js that talks to a plain filesystem path.
export const PGLITE_SERVER_DATABASE_SKILL_PROMPT = `Skill active: pglite-database (server-side)

PGlite is an embedded PostgreSQL engine (NOT SQLite) that also runs natively in Node.js. All SQL MUST use PostgreSQL syntax.

## Required Patterns
- Auto-increment IDs: \`id SERIAL PRIMARY KEY\` (never AUTOINCREMENT)
- Booleans: \`BOOLEAN NOT NULL DEFAULT FALSE\` (never INTEGER 0/1)
- Timestamps: \`NOW()\` or \`CURRENT_TIMESTAMP\` (never datetime('now'))
- Parameterized queries: \`db.query('SELECT * FROM t WHERE id = $1', [id])\` (never string interpolation)
- Query result shape safety: normalize \`db.query(...)\` output before iteration, same as the browser variant.
- Schema introspection: \`SELECT column_name FROM information_schema.columns WHERE table_name = $1\` (never PRAGMA)

## Forbidden SQLite Syntax (will cause runtime errors)
AUTOINCREMENT, PRAGMA, datetime('now'), GLOB, typeof(), IFNULL() (use COALESCE), GROUP_CONCAT() (use STRING_AGG), INTEGER for boolean columns.

## Server Init Pattern (Node, not browser)
Import with named import only. One dedicated module (server/db.js). Use a plain filesystem directory, NOT idb:// (that scheme is IndexedDB — browser-only and meaningless in Node):
\`\`\`
import { PGlite } from "@electric-sql/pglite";
const db = new PGlite("./data/app-db");
await db.waitReady; // promise property, NOT a function call
export const db = getDb();
\`\`\`
Do not reference idb://, IndexedDB, or WebContainer FS-bundle recovery — none of that applies server-side.`;

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
 *
 * `targetPaths` — the path(s) this specific call is generating/editing, when
 * known more precisely than `fileContracts` (which for some callers, e.g.
 * coder-fill, is the FULL cross-file contract set rather than just the
 * current target). Falls back to `fileContracts`' paths when omitted. When
 * every resolved target is under server/, the frontend-design skill is
 * suppressed entirely (server files need no aesthetic guidance) and the
 * PGlite skill — if it applies — uses the server-side prompt variant
 * instead of the browser/idb:// one.
 */
export function resolveActiveSkills(input: {
    userPrompt: string;
    threadContext?: string;
    spec?: SpecResponse;
    task?: PlanTask;
    additionalInstructions?: string;
    fileContracts?: FileContract[];
    pipelinePhase?: string;
    targetPaths?: string[];
}): ResolvedSkills {
    const resolvedTargets =
        input.targetPaths && input.targetPaths.length > 0
            ? input.targetPaths
            : (input.fileContracts ?? []).map((contract) => contract.path);
    const targetsOnlyServerFiles =
        resolvedTargets.length > 0 && resolvedTargets.every((path) => isServerOwnedPath(path));

    const frontendDesign =
        !targetsOnlyServerFiles &&
        shouldApplyFrontendDesignSkill({
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
    if (frontendDesign) parts.push(buildFrontendDesignSkillPrompt(input.spec?.designLanguage));
    if (pgliteDatabase) {
        parts.push(targetsOnlyServerFiles ? PGLITE_SERVER_DATABASE_SKILL_PROMPT : PGLITE_DATABASE_SKILL_PROMPT);
    }
    if (skeletonContract) parts.push(SKELETON_CONTRACT_SKILL_PROMPT);

    return {
        frontendDesign,
        pgliteDatabase,
        skeletonContract,
        skillsPromptBlock: parts.join("\n\n"),
    };
}

