const ROUTER_PROVIDER_PATTERN = /<\s*(BrowserRouter|Router|HashRouter|MemoryRouter|RouterProvider)\b|createBrowserRouter\s*\(/i;
const ROUTER_WRAPPER_TAG_PATTERN = /<\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\b/i;
const ROUTER_WRAPPER_CLOSE_TAG_SINGLE_PATTERN = /<\/\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\s*>/i;
const ROUTER_WRAPPER_OPEN_TAG_PATTERN = /<\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\b[^>]*>/gi;
const ROUTER_WRAPPER_CLOSE_TAG_PATTERN = /<\/\s*(BrowserRouter|Router|HashRouter|MemoryRouter)\s*>/gi;

function removeNamedImportsFromModule(
    code,
    moduleName,
    namesToRemove
) {
    const pruneNames = (namedPart) =>
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
        (_full, defaultBinding, namedPart, quote) => {
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
    next = next.replace(namedImportPattern, (_full, namedPart, quote) => {
        const names = pruneNames(namedPart);
        if (names.length === 0) {
            return "";
        }
        return `import { ${names.join(", ")} } from ${quote}${moduleName}${quote};`;
    });

    return next;
}

function stripNestedRouterWrappers(code) {
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

const inputs = [
    `import { Router, Routes, Route } from "react-router-dom";
   export default function App() {
     return (
       <Router>
         <Routes>
           <Route path="/" element={<Home />} />
         </Routes>
       </Router>
     );
   }`,
    `import { BrowserRouter as Router } from "react-router-dom"; // wait, the regex doesn't handle aliased default-like?`
];

for (const input of inputs) {
    console.log("IN:", input);
    console.log("OUT:", stripNestedRouterWrappers(input));
    console.log("-----");
}
