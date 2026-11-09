#!/usr/bin/env node
// Self-test for the benchmark's pass/fail judge (verifyApp in
// run-benchmark.mjs). Builds five tiny apps on disk, two good and three
// broken in different ways, and checks the judge gives each the right
// outcome. Needs network for npm install (about 15 s with a warm npm cache).
//
//   npm run test:bench-judge

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyApp } from "./run-benchmark.mjs";

const spaPackage = (extraDeps = {}) => ({
  name: "judge-spa",
  private: true,
  type: "module",
  scripts: { build: "vite build" },
  dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", ...extraDeps },
  devDependencies: { vite: "^5.4.0" },
});

const spaFiles = {
  "index.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
  "src/main.jsx":
    'import React from "react";\nimport { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")).render(React.createElement("h1", null, "ok"));\n',
};

const serverPackage = {
  ...spaPackage({ express: "^4.21.0" }),
  name: "judge-fullstack",
  scripts: { build: "vite build", "check:server": "SMOKE_TEST=1 node server/index.js" },
};

const serverIndex =
  'import { app } from "./app.js";\nif (!process.env.SMOKE_TEST) app.listen(Number(process.env.PORT || 3001));\n';

const serverApp = (handler) =>
  `import express from "express";\nexport const app = express();\napp.get("/api/items", ${handler});\n`;

const cases = [
  { name: "good-spa", expect: "pass", files: { "package.json": spaPackage(), ...spaFiles } },
  {
    name: "syntax-error",
    expect: "build_failed",
    files: { "package.json": spaPackage(), ...spaFiles, "src/main.jsx": "export default function (\n" },
  },
  {
    name: "missing-package",
    expect: "install_failed",
    files: { "package.json": spaPackage({ "this-package-does-not-exist-asb-judge": "1.0.0" }), ...spaFiles },
  },
  {
    name: "good-fullstack",
    expect: "pass",
    files: {
      "package.json": serverPackage,
      ...spaFiles,
      "server/index.js": serverIndex,
      "server/app.js": serverApp('(req, res) => res.json({ items: [] })'),
    },
  },
  {
    name: "api-throws",
    expect: "smoke_failed",
    files: {
      "package.json": serverPackage,
      ...spaFiles,
      "server/index.js": serverIndex,
      "server/app.js": serverApp('() => { throw new Error("db not wired"); }'),
    },
  },
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "asb-judge-"));
let failures = 0;
for (const testCase of cases) {
  const dir = path.join(root, testCase.name);
  for (const [name, content] of Object.entries(testCase.files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  const result = await verifyApp(dir, path.join(root, `${testCase.name}.log`));
  const ok = result.outcome === testCase.expect;
  if (!ok) failures += 1;
  console.log(`${ok ? "[pass]" : "[FAIL]"} ${testCase.name}: expected ${testCase.expect}, got ${result.outcome} (${result.reason})`);
}
fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? `judge self-test: ${cases.length}/${cases.length} cases correct` : `judge self-test: ${failures} case(s) wrong`);
process.exit(failures === 0 ? 0 : 1);
