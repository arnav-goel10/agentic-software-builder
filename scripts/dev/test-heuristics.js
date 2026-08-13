const PGLITE_STRONG_SIGNAL_PATTERN =
    /\b(database|db|postgres|sqlite|sql|table|schema|migration|pglite|auth|authentication|login|sign[\s-]?in|sign[\s-]?up|account|session|backend|api|endpoint|crud|persist|persistence|indexeddb|local\s+storage)\b/i;

const PGLITE_NEGATION_PATTERN =
    /\b(?:no|without|avoid|skip|not needed|not required|do not need|don't need|unnecessary|instead of)\b[\s\S]{0,50}\b(?:database|db|backend|server|api|auth|authentication|accounts?|session|persistence|storage|postgres|sqlite|sql|pglite|crud|indexeddb)\b|\b(?:database|db|backend|server|api|auth|authentication|accounts?|session|persistence|storage|postgres|sqlite|sql|pglite|crud|indexeddb)\b[\s\S]{0,50}\b(?:is not needed|isn't needed|is not required|isn't required|is unnecessary|are not needed|aren't needed|are unnecessary|is overkill|are overkill)\b/i;

const STATIC_FRONTEND_PATTERN =
    /\b(static data|landing page|marketing site|brochure site|content site|portfolio site)\b/i;

function stripNegatedPersistenceLines(signal) {
    return signal
        .split(/\r?\n/g)
        .filter((rawLine) => {
            const line = rawLine.trim();
            if (!line) return false;
            if (!PGLITE_NEGATION_PATTERN.test(line)) return true;
            return !PGLITE_STRONG_SIGNAL_PATTERN.test(line);
        })
        .join("\n");
}

function needsPgliteStarter(signal) {
    const normalized = signal.toLowerCase();
    const normalizedForPositiveScore = stripNegatedPersistenceLines(normalized);
    let score = 0;

    if (/\b(database|db|postgres|sqlite|sql|schema|table|migration|pglite)\b/.test(normalizedForPositiveScore)) {
        score += 3;
    }
    if (/\b(auth|authentication|login|sign[\s-]?in|sign[\s-]?up|account|session)\b/.test(normalizedForPositiveScore)) {
        score += 3;
    }
    if (/\b(backend|api|endpoint|crud)\b/.test(normalizedForPositiveScore)) {
        score += 2;
    }
    if (/\b(persist|persistence|indexeddb|local\s+storage|offline)\b/.test(normalizedForPositiveScore)) {
        score += 2;
    }

    if (PGLITE_NEGATION_PATTERN.test(normalized)) {
        score -= 5;
    }
    if (STATIC_FRONTEND_PATTERN.test(normalized)) {
        score -= 3;
    }

    if (!PGLITE_STRONG_SIGNAL_PATTERN.test(normalizedForPositiveScore)) {
        return false;
    }
    return score >= 3;
}

const tests = [
    "make a simple to do app. i don't need a database for now.",
    "just a static site, no backend needed.",
    "simple timer app.",
    "a landing page for my new product. no db.",
    "db is not needed here.",
    "database is unnecessary.",
    "we can mock the api.",
    "use local storage instead of a real database.",
    "no auth, no db, just a calculator."
];

for (const t of tests) {
    console.log(`"${t}" =>`, needsPgliteStarter(t));
}
