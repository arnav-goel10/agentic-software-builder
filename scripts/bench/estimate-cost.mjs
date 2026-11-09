#!/usr/bin/env node
// Estimate what a full benchmark run would cost on the configured OpenRouter
// model, from the prompt volume a stub run actually measured.
//
//   node scripts/bench/estimate-cost.mjs bench-results/<stub-run>/summary.json [--tasks 30]
//
// Prompts in a stub run are real (the engine builds them from the brief, the
// plan and the sibling files); responses are recorded fixtures for 2 to 5
// file apps. A live model writes larger apps, may use reasoning tokens and
// may trigger repair passes, so the estimate is a range:
//   low   the stub run's per-task volume as is
//   high  4x the prompt volume (more files, more fill and repair calls) and
//         a fixed 60k output tokens per task (code plus reasoning)
// Prices are read live from OpenRouter's public model list (no key, no cost)
// and the most expensive listed endpoint is used.

import fs from "node:fs";

const [summaryPath, ...rest] = process.argv.slice(2);
if (!summaryPath) {
  console.error("usage: estimate-cost.mjs <summary.json> [--tasks N] [--model id]");
  process.exit(2);
}
const flag = (name, fallback) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : fallback;
};
const taskCount = Number(flag("--tasks", 30));
const model = flag("--model", "minimax/minimax-m2.5");
const CHARS_PER_TOKEN = 3.5; // conservative for JSON and code; fewer chars per token means more tokens

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
const perTaskInputTokens = summary.tokens.inputChars / CHARS_PER_TOKEN / summary.total;
const perTaskOutputTokens = summary.tokens.outputChars / CHARS_PER_TOKEN / summary.total;

const endpoints = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`).then((r) => r.json());
const prices = endpoints.data.endpoints.map((e) => ({
  provider: e.provider_name,
  inPerM: Number(e.pricing.prompt) * 1e6,
  outPerM: Number(e.pricing.completion) * 1e6,
}));
const priciest = prices.reduce((a, b) => (b.inPerM + b.outPerM > a.inPerM + a.outPerM ? b : a));

const cost = (inTok, outTok) => (inTok * priciest.inPerM + outTok * priciest.outPerM) / 1e6;
const low = { inputTokens: perTaskInputTokens, outputTokens: perTaskOutputTokens };
const high = { inputTokens: perTaskInputTokens * 4, outputTokens: 60_000 };
const report = {
  measuredFrom: summaryPath,
  model,
  pricesFetchedAt: new Date().toISOString(),
  priceUsedPerMillion: priciest,
  allEndpoints: prices,
  charsPerToken: CHARS_PER_TOKEN,
  perTask: {
    low: { ...low, usd: cost(low.inputTokens, low.outputTokens) },
    high: { ...high, usd: cost(high.inputTokens, high.outputTokens) },
  },
  tasks: taskCount,
  totalUsd: { low: cost(low.inputTokens, low.outputTokens) * taskCount, high: cost(high.inputTokens, high.outputTokens) * taskCount },
};
console.log(JSON.stringify(report, null, 2));
