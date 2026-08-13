
import { syncRuntimeEnv } from "@/lib/server/runtime-env";

export type ModelProviderId = "openrouter";

export type ModelProviderPhase =
  | "spec"
  | "architect"
  | "scaffold"
  | "coder"
  | "repair_primary"
  | "repair_escalation"
  | "qa"
  | "finalize"
  | "run_metadata";

type OpenrouterRouting = {
  allowFallbacks: boolean;
  requireParameters: boolean;
  ignoredProviders?: string[];
};

type OpenrouterPromptCaching = {
  strategy: "auto" | "explicit";
  minChars: number;
};

export type ConfiguredModelProvider =

  | {
    provider: "openrouter";
    phase: ModelProviderPhase;
    model: string;
    apiKey: string;
    baseUrl: string;
    siteUrl?: string;
    appName?: string;
    user?: string;
    traceAppName?: string;
    timeoutMs: number;
    reasoningEnabled: boolean;
    routing: OpenrouterRouting;
    promptCaching: OpenrouterPromptCaching;
  };

export interface StructuredPromptInput {
  providers: ConfiguredModelProvider[];
  systemInstruction: string | Array<{ text: string; cache?: boolean }>;
  userPrompt: string;
  schema: Record<string, unknown>;
  temperature?: number;
  onPartial?: (partialData: Record<string, unknown>) => void;
};

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
};

export type ProviderStructuredDiagnostics = {
  invalidJsonIncidents: number;
  invalidSchemaIncidents: number;
  schemaRepairAttempts: number;
  lengthFinishSignals: number;
};

export type ProviderAttempt = {
  provider: ModelProviderId;
  model: string;
  ok: boolean;
  status?: number;
  message?: string;
  durationMs: number;
};

export type ProviderCallResult<T> = {
  data: T;
  provider: ModelProviderId;
  model: string;
  usage?: ProviderUsage;
  diagnostics?: ProviderStructuredDiagnostics;
  attempts: ProviderAttempt[];
};

type ProviderError = Error & {
  provider?: ModelProviderId;
  status?: number;
};

const OPENROUTER_RESPONSE_HEALING_PLUGIN_ID = "response-healing";
const OPENROUTER_MAX_REPAIR_SOURCE_CHARS = 120000;
const OPENROUTER_MAX_REQUEST_ATTEMPTS = 3;
const OPENROUTER_RETRY_BASE_DELAY_MS = 500;
const OPENROUTER_CONTINUATION_CONTEXT_CHARS = 16000;
const OPENROUTER_CONTINUATION_STALE_CONTEXT_CHARS = 6000;
const OPENROUTER_CONTINUATION_ECHO_TAIL_CHARS = 600;
const OPENROUTER_MAX_CONTINUATION_OVERLAP_CHARS = 4000;
const OPENROUTER_PROVIDER_BLACKLISTS_BY_MODEL: Array<{
  modelPrefix: string;
  ignoredProviders: string[];
}> = [
  {
    modelPrefix: "minimax/minimax-m2.5",
    ignoredProviders: ["siliconflow"],
  },
];

function nowMs(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number | undefined): boolean {
  if (typeof status !== "number") return false;
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function isTransientTransportMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "terminated",
    "network request failed",
    "fetch failed",
    "socket hang up",
    "econnreset",
    "etimedout",
    "timed out",
    "timeout",
    "aborted",
    "premature close",
    "stream closed",
  ].some((needle) => normalized.includes(needle));
}

function toProviderError(
  provider: ModelProviderId,
  message: string,
  status?: number
): ProviderError {
  const error = new Error(message) as ProviderError;
  error.provider = provider;
  error.status = status;
  return error;
}

function parseJsonSafe(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractBalancedJsonSubstring(
  source: string,
  startIndex: number,
  openChar: "{" | "[",
  closeChar: "}" | "]"
): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function collectJsonCandidates(rawContent: string): string[] {
  const source = rawContent.trim();
  if (!source) return [];

  const seen = new Set<string>();
  const candidates: string[] = [];
  const push = (value: string) => {
    const normalized = value.trim();
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  push(source);

  const markdownBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = markdownBlockRegex.exec(source);
  while (match) {
    push(match[1] ?? "");
    match = markdownBlockRegex.exec(source);
  }

  const firstContainerStart = source.search(/[{\[]/);
  if (firstContainerStart >= 0) {
    for (
      let index = firstContainerStart;
      index < source.length && candidates.length < 24;
      index += 1
    ) {
      const char = source[index];
      if (char !== "{" && char !== "[") continue;
      const extracted =
        char === "{"
          ? extractBalancedJsonSubstring(source, index, "{", "}")
          : extractBalancedJsonSubstring(source, index, "[", "]");
      if (extracted) {
        push(extracted);
      }
    }
  }

  return candidates;
}

function validateJsonAgainstSchema(schema: unknown, value: unknown): string[] {
  const errors: string[] = [];

  const push = (message: string) => {
    if (errors.length < 10) {
      errors.push(message);
    }
  };

  const validateAt = (schemaNode: unknown, nodeValue: unknown, path: string) => {
    if (errors.length >= 10) return;
    if (!isObject(schemaNode)) return;

    const oneOf = Array.isArray(schemaNode.oneOf) ? schemaNode.oneOf : null;
    if (oneOf && oneOf.length > 0) {
      const branchPasses = oneOf.some((branch) => validateJsonAgainstSchema(branch, nodeValue).length === 0);
      if (!branchPasses) {
        push(`${path} does not match any allowed schema branch (oneOf)`);
      }
      return;
    }

    if ("const" in schemaNode) {
      if (JSON.stringify(schemaNode.const) !== JSON.stringify(nodeValue)) {
        push(`${path} must equal const ${JSON.stringify(schemaNode.const)}`);
      }
      return;
    }

    if (Array.isArray(schemaNode.enum) && schemaNode.enum.length > 0) {
      const enumMatch = schemaNode.enum.some(
        (entry) => JSON.stringify(entry) === JSON.stringify(nodeValue)
      );
      if (!enumMatch) {
        push(`${path} must be one of enum values`);
      }
    }

    const declaredType = typeof schemaNode.type === "string" ? schemaNode.type : null;
    const inferredType =
      declaredType ??
      (isObject(schemaNode.properties) || Array.isArray(schemaNode.required)
        ? "object"
        : schemaNode.items
          ? "array"
          : null);

    if (inferredType === "object") {
      if (!isObject(nodeValue)) {
        push(`${path} must be an object`);
        return;
      }

      const requiredKeys = Array.isArray(schemaNode.required)
        ? schemaNode.required.filter((key): key is string => typeof key === "string")
        : [];
      for (const key of requiredKeys) {
        if (!(key in nodeValue)) {
          push(`${path}.${key} is required`);
        }
      }

      const properties = isObject(schemaNode.properties) ? schemaNode.properties : {};
      for (const [propKey, propSchema] of Object.entries(properties)) {
        if (propKey in nodeValue) {
          validateAt(propSchema, (nodeValue as Record<string, unknown>)[propKey], `${path}.${propKey}`);
        }
      }

      if (schemaNode.additionalProperties === false) {
        const allowedKeys = new Set(Object.keys(properties));
        for (const key of Object.keys(nodeValue)) {
          if (!allowedKeys.has(key)) {
            push(`${path}.${key} is not allowed (additionalProperties=false)`);
          }
        }
      }
      return;
    }

    if (inferredType === "array") {
      if (!Array.isArray(nodeValue)) {
        push(`${path} must be an array`);
        return;
      }
      const minItems =
        typeof schemaNode.minItems === "number" && Number.isInteger(schemaNode.minItems)
          ? schemaNode.minItems
          : undefined;
      const maxItems =
        typeof schemaNode.maxItems === "number" && Number.isInteger(schemaNode.maxItems)
          ? schemaNode.maxItems
          : undefined;
      if (typeof minItems === "number" && nodeValue.length < minItems) {
        push(`${path} must have at least ${minItems} items`);
      }
      if (typeof maxItems === "number" && nodeValue.length > maxItems) {
        push(`${path} must have at most ${maxItems} items`);
      }
      if (schemaNode.items) {
        nodeValue.forEach((item, index) => {
          validateAt(schemaNode.items, item, `${path}[${index}]`);
        });
      }
      return;
    }

    if (inferredType === "string") {
      if (typeof nodeValue !== "string") {
        push(`${path} must be a string`);
        return;
      }
      const minLength =
        typeof schemaNode.minLength === "number" && Number.isInteger(schemaNode.minLength)
          ? schemaNode.minLength
          : undefined;
      if (typeof minLength === "number" && nodeValue.length < minLength) {
        push(`${path} must have at least ${minLength} characters`);
      }
      if (typeof schemaNode.pattern === "string") {
        try {
          const re = new RegExp(schemaNode.pattern);
          if (!re.test(nodeValue)) {
            push(`${path} does not match required pattern`);
          }
        } catch {
          // Ignore invalid schema pattern and avoid failing valid model output.
        }
      }
      return;
    }

    if (inferredType === "number") {
      if (typeof nodeValue !== "number" || !Number.isFinite(nodeValue)) {
        push(`${path} must be a finite number`);
        return;
      }
      const minimum = typeof schemaNode.minimum === "number" ? schemaNode.minimum : undefined;
      const maximum = typeof schemaNode.maximum === "number" ? schemaNode.maximum : undefined;
      if (typeof minimum === "number" && nodeValue < minimum) {
        push(`${path} must be >= ${minimum}`);
      }
      if (typeof maximum === "number" && nodeValue > maximum) {
        push(`${path} must be <= ${maximum}`);
      }
      return;
    }

    if (inferredType === "integer") {
      if (typeof nodeValue !== "number" || !Number.isInteger(nodeValue)) {
        push(`${path} must be an integer`);
        return;
      }
      return;
    }

    if (inferredType === "boolean") {
      if (typeof nodeValue !== "boolean") {
        push(`${path} must be a boolean`);
      }
      return;
    }

    if (inferredType === "null") {
      if (nodeValue !== null) {
        push(`${path} must be null`);
      }
      return;
    }
  };

  validateAt(schema, value, "$");
  return errors;
}

/**
 * Creates a generic parser that extracts complete objects from any top-level array in a JSON stream.
 * This allows streaming feedback for Spec (requirements), Plan (tasks), and Task (operations).
 */
function createGenericPartialParser(onPartial?: (data: Record<string, unknown>) => void) {
  if (!onPartial) return () => { };

  const processedCounts = new Map<string, number>();

  return (buffer: string) => {
    try {
      // Find all top-level array keys: "key": [ ... ]
      const arrayKeyRegex = /"([^"]+)"\s*:\s*\[/g;
      let match;

      while ((match = arrayKeyRegex.exec(buffer)) !== null) {
        const key = match[1];
        const arrayStart = match.index + match[0].length - 1; // index of '['

        let cursor = arrayStart + 1;
        const foundItems: unknown[] = [];

        while (cursor < buffer.length) {
          while (cursor < buffer.length && /[\s,]/.test(buffer[cursor])) cursor++;
          if (buffer[cursor] === ']') break;
          if (buffer[cursor] === '{') {
            let braceCount = 1;
            let end = cursor + 1;
            let insideString = false;
            let escape = false;

            while (end < buffer.length && braceCount > 0) {
              const char = buffer[end];
              if (escape) escape = false;
              else if (char === '\\') escape = true;
              else if (char === '"') insideString = !insideString;
              else if (!insideString) {
                if (char === '{') braceCount++;
                else if (char === '}') braceCount--;
              }
              end++;
            }

            if (braceCount === 0) {
              try {
                const obj = JSON.parse(buffer.substring(cursor, end));
                foundItems.push(obj);
              } catch { }
              cursor = end;
            } else break;
          } else if (buffer[cursor] === '"' || buffer[cursor] === "'" || !isNaN(Number(buffer[cursor]))) {
            // Handle primitive arrays like requirements: ["item1", "item2"]
            let end = cursor;
            if (buffer[cursor] === '"' || buffer[cursor] === "'") {
              const quote = buffer[cursor];
              end++;
              let escape = false;
              while (end < buffer.length) {
                if (escape) escape = false;
                else if (buffer[end] === '\\') escape = true;
                else if (buffer[end] === quote) {
                  end++;
                  break;
                }
                end++;
              }
            } else {
              while (end < buffer.length && /[0-9.eE-]/.test(buffer[end])) end++;
            }

            if (end <= buffer.length) {
              try {
                foundItems.push(JSON.parse(buffer.substring(cursor, end)));
              } catch { }
              cursor = end;
            } else break;
          } else break;
        }

        const processedCount = processedCounts.get(key) || 0;
        if (foundItems.length > processedCount) {
          // Send the full list so far so the UI can show cumulative progress
          onPartial({ [key]: foundItems });
          processedCounts.set(key, foundItems.length);
        }
      }
    } catch { }
  };
}

function parseModelJsonContent<T>(rawContent: string): T | null {
  const candidates = collectJsonCandidates(rawContent);
  for (const candidate of candidates) {
    const parsed = parseJsonSafe(candidate);
    if (parsed !== null) {
      return parsed as T;
    }
  }
  return null;
}

function coerceOpenrouterTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(item);
        continue;
      }
      if (!isObject(item)) {
        continue;
      }
      const text = item.text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
    return parts.join("");
  }
  return "";
}

function extractOpenrouterChoiceContent(choice: unknown): string {
  if (!isObject(choice)) {
    return "";
  }
  const message = isObject(choice.message) ? choice.message : null;
  const delta = isObject(choice.delta) ? choice.delta : null;

  const messageContent = coerceOpenrouterTextContent(message?.content);
  if (messageContent) {
    return messageContent;
  }

  const deltaContent = coerceOpenrouterTextContent(delta?.content);
  if (deltaContent) {
    return deltaContent;
  }

  const text = choice.text;
  if (typeof text === "string") {
    return text;
  }

  return "";
}

function extractOpenrouterChoiceFinishReason(choice: unknown): string | undefined {
  if (!isObject(choice)) {
    return undefined;
  }
  const finishReason = choice.finish_reason;
  if (typeof finishReason === "string" && finishReason.trim().length > 0) {
    return finishReason.trim();
  }
  return undefined;
}

function isLengthFinishReason(reason: string | undefined): boolean {
  return (reason ?? "").trim().toLowerCase() === "length";
}

function mergeContinuationContent(previous: string, next: string): string {
  if (!previous) return next;
  if (!next) return previous;
  if (previous.endsWith(next)) return previous;

  const maxOverlap = Math.min(
    OPENROUTER_MAX_CONTINUATION_OVERLAP_CHARS,
    previous.length,
    next.length
  );

  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    if (previous.endsWith(next.slice(0, overlap))) {
      return previous + next.slice(overlap);
    }
  }

  return previous + next;
}

function buildContinuationInstruction(
  mergedContent: string,
  staleContinuationPasses: number
): string {
  const emittedTail = mergedContent.slice(-OPENROUTER_CONTINUATION_ECHO_TAIL_CHARS);
  return [
    "Continue EXACTLY from where you stopped.",
    "Output ONLY the remaining JSON suffix as raw text.",
    "Do not restart from the beginning and do not repeat previously emitted text.",
    "Do not emit markdown, commentary, or code fences.",
    `Already emitted tail (DO NOT repeat): ${JSON.stringify(emittedTail)}`,
    staleContinuationPasses > 0
      ? "Your previous continuation repeated content. Resume at the NEXT character after that tail."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function mergeUsage(primary?: ProviderUsage, secondary?: ProviderUsage): ProviderUsage | undefined {
  const sum = (first?: number, second?: number): number | undefined => {
    if (first === undefined && second === undefined) return undefined;
    return (first ?? 0) + (second ?? 0);
  };

  const merged: ProviderUsage = {
    inputTokens: sum(primary?.inputTokens, secondary?.inputTokens),
    outputTokens: sum(primary?.outputTokens, secondary?.outputTokens),
    totalTokens: sum(primary?.totalTokens, secondary?.totalTokens),
    cachedInputTokens: sum(primary?.cachedInputTokens, secondary?.cachedInputTokens),
    cacheWriteInputTokens: sum(primary?.cacheWriteInputTokens, secondary?.cacheWriteInputTokens),
  };

  if (
    merged.inputTokens === undefined &&
    merged.outputTokens === undefined &&
    merged.totalTokens === undefined &&
    merged.cachedInputTokens === undefined &&
    merged.cacheWriteInputTokens === undefined
  ) {
    return undefined;
  }

  return merged;
}

function buildOpenrouterRepairPrompt(schema: Record<string, unknown>, invalidOutput: string): string {
  const truncated = invalidOutput.slice(0, OPENROUTER_MAX_REPAIR_SOURCE_CHARS);
  return [
    "Convert the following model output into valid JSON that satisfies this schema.",
    "Return JSON only. No explanation. No markdown fences.",
    `Schema:\n${JSON.stringify(schema)}`,
    `Model output to repair:\n${truncated}`,
  ].join("\n\n");
}

function buildOpenrouterSchemaRepairPrompt(
  schema: Record<string, unknown>,
  invalidOutput: string,
  schemaErrors: string[]
): string {
  const truncated = invalidOutput.slice(0, OPENROUTER_MAX_REPAIR_SOURCE_CHARS);
  const compactErrors = schemaErrors.slice(0, 8).map((entry) => `- ${entry}`).join("\n");
  return [
    "The model output is JSON but does not satisfy the schema.",
    "Rewrite it into valid JSON matching the schema exactly.",
    "Return JSON only. No explanation. No markdown fences.",
    `Schema violations:\n${compactErrors}`,
    `Schema:\n${JSON.stringify(schema)}`,
    `Model output to repair:\n${truncated}`,
  ].join("\n\n");
}

function truncateText(value: string, max = 700): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function stringifyOpenrouterMetadataRaw(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeOpenrouterErrorPayload(parsed: unknown, status: number): string {
  if (!isObject(parsed)) {
    return `OpenRouter request failed with status ${status}`;
  }

  const errorNode = isObject(parsed.error) ? parsed.error : null;
  const message =
    (errorNode && typeof errorNode.message === "string" && errorNode.message.trim()) ||
    (typeof parsed.message === "string" && parsed.message.trim()) ||
    "";
  const code =
    (errorNode && typeof errorNode.code === "string" && errorNode.code.trim()) ||
    (typeof parsed.code === "string" && parsed.code.trim()) ||
    "";
  const providerNode = errorNode && isObject(errorNode.metadata) ? errorNode.metadata : null;
  const providerName =
    (providerNode && typeof providerNode.provider_name === "string" && providerNode.provider_name.trim()) ||
    "";
  const metadataRaw = stringifyOpenrouterMetadataRaw(providerNode?.raw);

  const parts: string[] = [];
  if (message) {
    parts.push(message);
  } else {
    parts.push(`OpenRouter request failed with status ${status}`);
  }
  parts.push(`status=${status}`);
  if (code) {
    parts.push(`code=${code}`);
  }
  if (providerName) {
    parts.push(`provider=${providerName}`);
  }
  if (metadataRaw) {
    parts.push(`metadata.raw=${truncateText(metadataRaw, 420)}`);
  }

  return truncateText(parts.join(" | ").trim());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}



function requireHttpUrl(env: NodeJS.ProcessEnv, key: string): string {
  const value = requireEnv(env, key);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid environment variable ${key}: must be a valid URL`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid environment variable ${key}: URL must use http or https`);
  }

  return value.replace(/\/+$/, "");
}

function parsePositiveIntegerStrict(rawValue: string, key: string): number {
  const parsed = Number(rawValue.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid environment variable ${key}: expected a positive integer`);
  }
  return parsed;
}

function parseOpenrouterPromptCacheStrategy(rawValue: string): "auto" | "explicit" {
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "auto" || normalized === "explicit") {
    return normalized;
  }
  throw new Error(
    "Invalid environment variable OPENROUTER_PROMPT_CACHE_STRATEGY: expected 'auto' or 'explicit'"
  );
}

function parseRequiredCsv(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function normalizePhaseToken(token: string): ModelProviderPhase {
  const normalized = token.trim().toLowerCase().replace(/-/g, "_");
  switch (normalized) {
    case "spec":
      return "spec";
    case "architect":
      return "architect";
    case "scaffold":
      return "scaffold";
    case "coder":
      return "coder";
    case "repair_primary":
    case "repairprimary":
      return "repair_primary";
    case "repair_escalation":
    case "repairescalation":
      return "repair_escalation";
    case "qa":
      return "qa";
    case "finalize":
      return "finalize";
    case "run_metadata":
    case "runmetadata":
      return "run_metadata";
    default:
      throw new Error(
        `Invalid OPENROUTER_REASONING_PHASES value '${token}'. Expected one of spec, architect, scaffold, coder, repair_primary, repair_escalation, qa, finalize, run_metadata`
      );
  }
}

function parseReasoningPhaseSet(rawValue: string): Set<ModelProviderPhase> {
  const phases = parseRequiredCsv(rawValue).map(normalizePhaseToken);
  return new Set(phases);
}

function resolveOpenrouterPromptCaching(env: NodeJS.ProcessEnv): OpenrouterPromptCaching {
  return {
    strategy: parseOpenrouterPromptCacheStrategy(
      requireEnv(env, "OPENROUTER_PROMPT_CACHE_STRATEGY")
    ),
    minChars: parsePositiveIntegerStrict(
      requireEnv(env, "OPENROUTER_PROMPT_CACHE_MIN_CHARS"),
      "OPENROUTER_PROMPT_CACHE_MIN_CHARS"
    ),
  };
}

const PHASE_MODEL_ENV_KEY: Record<ModelProviderPhase, string> = {
  spec: "OPENROUTER_MODELS_SPEC",
  architect: "OPENROUTER_MODELS_ARCHITECT",
  scaffold: "OPENROUTER_MODELS_SCAFFOLD",
  coder: "OPENROUTER_MODELS_CODER",
  repair_primary: "OPENROUTER_MODELS_REPAIR_PRIMARY",
  repair_escalation: "OPENROUTER_MODELS_REPAIR_ESCALATION",
  qa: "OPENROUTER_MODELS_QA",
  finalize: "OPENROUTER_MODELS_FINALIZE",
  run_metadata: "OPENROUTER_MODELS_CODER",
};

function resolvePhaseModelCandidates(env: NodeJS.ProcessEnv, phase: ModelProviderPhase): string[] {
  const key = PHASE_MODEL_ENV_KEY[phase];
  const raw = env[key]?.trim();
  // Scaffold phase falls back to plan model when not explicitly configured
  if (!raw && phase === "scaffold") {
    return resolvePhaseModelCandidates(env, "architect");
  }
  if (!raw) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  const models = parseRequiredCsv(raw);
  if (models.length === 0) {
    throw new Error(`Invalid environment variable ${key}: expected at least one model id`);
  }
  return models;
}

function resolveReasoningEnabled(
  env: NodeJS.ProcessEnv,
  phase: ModelProviderPhase
): boolean {
  const phases = parseReasoningPhaseSet(requireEnv(env, "OPENROUTER_REASONING_PHASES"));
  return phases.has(phase);
}

function resolveIgnoredProvidersForModel(model: string): string[] {
  const ignoredProviders = new Set<string>();
  for (const rule of OPENROUTER_PROVIDER_BLACKLISTS_BY_MODEL) {
    if (model.startsWith(rule.modelPrefix)) {
      for (const provider of rule.ignoredProviders) {
        const normalized = provider.trim().toLowerCase();
        if (normalized) {
          ignoredProviders.add(normalized);
        }
      }
    }
  }
  return Array.from(ignoredProviders);
}

function resolveOpenrouterRouting(model: string): OpenrouterRouting {
  const ignoredProviders = resolveIgnoredProvidersForModel(model);
  return {
    allowFallbacks: true,
    requireParameters: true,
    ignoredProviders: ignoredProviders.length > 0 ? ignoredProviders : undefined,
  };
}

type OpenrouterTextPart = {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
  };
};

type OpenrouterMessage = {
  role: "system" | "user" | "assistant";
  content: string | OpenrouterTextPart[];
};

function buildOpenrouterMessageContent(
  text: string,
  promptCaching: OpenrouterPromptCaching
): string | OpenrouterTextPart[] {
  if (promptCaching.strategy !== "explicit" || text.length < promptCaching.minChars) {
    return text;
  }

  return [
    {
      type: "text",
      text,
      cache_control: { type: "ephemeral" },
    },
  ];
}

function extractUsageFromOpenAiLike(payload: unknown): ProviderUsage | undefined {
  if (!isObject(payload) || !isObject(payload.usage)) {
    return undefined;
  }

  const rawUsage = payload.usage;
  const inputTokens = Number(rawUsage.prompt_tokens ?? 0);
  const outputTokens = Number(rawUsage.completion_tokens ?? 0);
  const totalTokens = Number(rawUsage.total_tokens ?? 0);
  const promptTokenDetails = isObject(rawUsage.prompt_tokens_details)
    ? rawUsage.prompt_tokens_details
    : null;
  const cachedInputTokens = Number(
    promptTokenDetails?.cached_tokens ?? promptTokenDetails?.cachedTokens ?? 0
  );
  const cacheWriteInputTokens = Number(
    promptTokenDetails?.cache_write_tokens ?? promptTokenDetails?.cacheWriteTokens ?? 0
  );

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : undefined,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : undefined,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : undefined,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : undefined,
    cacheWriteInputTokens: Number.isFinite(cacheWriteInputTokens)
      ? cacheWriteInputTokens
      : undefined,
  };
}



async function callOpenrouterStructuredJson<T>(
  provider: Extract<ConfiguredModelProvider, { provider: "openrouter" }>,
  input: StructuredPromptInput
): Promise<Omit<ProviderCallResult<T>, "attempts">> {
  const diagnostics: ProviderStructuredDiagnostics = {
    invalidJsonIncidents: 0,
    invalidSchemaIncidents: 0,
    schemaRepairAttempts: 0,
    lengthFinishSignals: 0,
  };
  const endpoint = `${provider.baseUrl}/chat/completions`;
  const schemaJson = JSON.stringify(input.schema);
  const outputRequirements = `
Output requirements:
- Return ONLY valid JSON.
- Return exactly one JSON object and nothing else.
- Use double quotes for all keys and string values.
- Do not emit markdown fences, comments, or trailing commas.
- The JSON must satisfy this schema:
${schemaJson}`;

  let systemMessageContent: string | OpenrouterTextPart[];

  if (typeof input.systemInstruction === "string") {
    systemMessageContent = buildOpenrouterMessageContent(
      `${input.systemInstruction}\n${outputRequirements}`,
      provider.promptCaching
    );
  } else {
    // Structured system prompt with explicit caching
    systemMessageContent = input.systemInstruction.map((part) => ({
      type: "text" as const,
      text: part.text,
      ...(part.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    // Append requirements as final uncached part
    systemMessageContent.push({
      type: "text",
      text: outputRequirements,
    });
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };

  if (provider.siteUrl) {
    headers["HTTP-Referer"] = provider.siteUrl;
  }
  if (provider.appName) {
    headers["X-Title"] = provider.appName;
  }

  const modelSpecificIgnoredProviders = resolveIgnoredProvidersForModel(provider.model);
  const configuredIgnoredProviders = provider.routing.ignoredProviders ?? [];
  const mergedIgnoredProviders = Array.from(
    new Set([...configuredIgnoredProviders, ...modelSpecificIgnoredProviders].map((item) => item.trim().toLowerCase()).filter(Boolean))
  );

  const providerRouting: Record<string, unknown> = {
    allow_fallbacks: provider.routing.allowFallbacks || provider.model.endsWith(":free"),
    require_parameters: provider.routing.requireParameters,
    ...(mergedIgnoredProviders.length > 0
      ? { ignore: mergedIgnoredProviders }
      : {}),
  };

  type OpenrouterRequestResult = {
    content: string;
    usage?: ProviderUsage;
    finishReason?: string;
  };

  const sendOpenrouterRequest = async (
    messages: OpenrouterMessage[],
    options?: { stream?: boolean; useHealingPlugin?: boolean; useJsonMode?: boolean }
  ): Promise<OpenrouterRequestResult> => {
    const stream = options?.stream ?? true;
    const useHealingPlugin = options?.useHealingPlugin ?? true;
    const useJsonMode = options?.useJsonMode ?? !provider.model.endsWith(":free");

    const requestBody = {
      model: provider.model,
      messages,
      ...(provider.user ? { user: provider.user } : {}),
      ...(provider.traceAppName
        ? { trace: { app_name: provider.traceAppName } }
        : {}),
      ...(useJsonMode ? { response_format: { type: "json_object" as const } } : {}),
      plugins: useHealingPlugin ? [{ id: OPENROUTER_RESPONSE_HEALING_PLUGIN_ID }] : undefined,
      provider: providerRouting,
      temperature: Math.max(0, Math.min(1, input.temperature ?? 0.2)),
      stream,
      include_reasoning: provider.reasoningEnabled,
    };

    for (let attempt = 1; attempt <= OPENROUTER_MAX_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Network request failed";
          throw toProviderError("openrouter", message);
        }

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `OpenRouter error ${response.status}`;
          try {
            const parsed = JSON.parse(errorText);
            errorMessage = describeOpenrouterErrorPayload(parsed, response.status);
          } catch {
            // No-op.
          }
          throw toProviderError("openrouter", errorMessage, response.status);
        }

        if (!stream) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            throw toProviderError("openrouter", "OpenRouter returned non-JSON response body");
          }
          if (!isObject(payload)) {
            throw toProviderError("openrouter", "OpenRouter returned malformed response payload");
          }
          const choices = Array.isArray(payload.choices) ? payload.choices : [];
          const firstChoice = choices[0];
          const content = extractOpenrouterChoiceContent(firstChoice);
          return {
            content,
            usage: extractUsageFromOpenAiLike(payload),
            finishReason: extractOpenrouterChoiceFinishReason(firstChoice),
          };
        }

        if (!response.body) {
          throw toProviderError("openrouter", "No response body received");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let bufferedContent = "";
        let sseBuffer = "";
        const tryParsePartials = createGenericPartialParser(input.onPartial);
        let totalUsage: ProviderUsage | undefined;
        let finishReason: string | undefined;

        const processSseLine = (lineRaw: string) => {
          const line = lineRaw.trim();
          if (!line.startsWith("data:")) return;
          const dataStr = line.slice(5).trim();
          if (dataStr === "[DONE]") return;
          try {
            const data = JSON.parse(dataStr);
            if (data.error) {
              console.error("[model-provider] OpenRouter stream error:", data.error);
            }
            const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
            const nextContent = extractOpenrouterChoiceContent(choice);
            if (nextContent) {
              bufferedContent += nextContent;
              tryParsePartials(bufferedContent);
            }
            const nextFinishReason = extractOpenrouterChoiceFinishReason(choice);
            if (nextFinishReason) {
              finishReason = nextFinishReason;
            }
            if (data.usage) {
              totalUsage = extractUsageFromOpenAiLike(data);
            }
          } catch {
            // Ignore malformed SSE line.
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          sseBuffer += chunk;

          while (true) {
            const lineEnd = sseBuffer.indexOf("\n");
            if (lineEnd === -1) break;

            const line = sseBuffer.slice(0, lineEnd).trim();
            sseBuffer = sseBuffer.slice(lineEnd + 1);
            processSseLine(line);
          }
        }

        // Some providers may end the stream without a trailing newline.
        if (sseBuffer.trim().length > 0) {
          processSseLine(sseBuffer);
        }

        const fakePayload = {
          choices: [{ message: { content: bufferedContent } }],
          usage: totalUsage,
        };

        if (isLengthFinishReason(finishReason) || (bufferedContent.length > 0 && totalUsage?.outputTokens === 4096)) {
          console.log(`[model-provider] Output potential truncation: model=${provider.model} length=${bufferedContent.length} tokens=${totalUsage?.outputTokens} finishReason=${finishReason}`);
        }

        return {
          content: bufferedContent,
          usage: totalUsage || extractUsageFromOpenAiLike(fakePayload),
          finishReason,
        };
      } catch (error) {
        const typedError = error as ProviderError;
        const message =
          typedError instanceof Error ? typedError.message : "OpenRouter request failed";
        const status = typeof typedError.status === "number" ? typedError.status : undefined;

        // Auto-fallback for unsupported JSON mode
        if (status === 400 && message.toLowerCase().includes("json_object") && options?.useJsonMode !== false) {
          console.warn(`[model-provider] Model ${provider.model} does not support JSON mode. Retrying without response_format.`);
          return sendOpenrouterRequest(messages, { ...options, useJsonMode: false });
        }

        const retryable = isRetryableStatus(status) || isTransientTransportMessage(message);
        const hasAttemptsLeft = attempt < OPENROUTER_MAX_REQUEST_ATTEMPTS;

        if (retryable && hasAttemptsLeft) {
          const waitMs = OPENROUTER_RETRY_BASE_DELAY_MS * attempt;
          console.warn(
            `[model-provider] OpenRouter transient error on attempt ${attempt}/${OPENROUTER_MAX_REQUEST_ATTEMPTS}: ${message}. Retrying in ${waitMs}ms`
          );
          await sleep(waitMs);
          continue;
        }

        console.error(`[model-provider] OpenRouter terminal error: model=${provider.model} status=${status} message=${message}`);
        throw toProviderError("openrouter", message, status);
      }
    }

    throw toProviderError("openrouter", "OpenRouter request retries exhausted");
  };

  const sendOpenrouterRequestWithContinuation = async (
    baseMessages: OpenrouterMessage[],
    options?: { stream?: boolean; useHealingPlugin?: boolean; useJsonMode?: boolean }
  ): Promise<{ content: string; usage?: ProviderUsage; lengthFinishSignals: number }> => {
    let mergedContent = "";
    let mergedUsage: ProviderUsage | undefined;
    let requestMessages = baseMessages;
    let staleContinuationPasses = 0;
    let continuationPass = 0;
    let lengthFinishSignals = 0;

    while (true) {
      const continuationRequestOptions =
        continuationPass === 0
          ? options
          : {
              ...options,
              useJsonMode: false,
              useHealingPlugin: false,
            };
      const response = await sendOpenrouterRequest(requestMessages, continuationRequestOptions);
      const previousLength = mergedContent.length;
      mergedContent = mergeContinuationContent(mergedContent, response.content);
      mergedUsage = mergeUsage(mergedUsage, response.usage);

      console.log(
        `[model-provider] Continuation pass ${continuationPass}: model=${provider.model} new_chars=${response.content.length} total_chars=${mergedContent.length} finishReason=${response.finishReason} json_mode=${continuationRequestOptions?.useJsonMode !== false} healing=${continuationRequestOptions?.useHealingPlugin !== false}`
      );

      const isLengthSignal = isLengthFinishReason(response.finishReason);
      if (isLengthSignal) {
        lengthFinishSignals += 1;
      }

      if (!isLengthSignal) {
        return {
          content: mergedContent,
          usage: mergedUsage,
          lengthFinishSignals,
        };
      }

      if (mergedContent.length <= previousLength) {
        staleContinuationPasses += 1;
      } else {
        staleContinuationPasses = 0;
      }

      if (staleContinuationPasses >= 2) {
        throw toProviderError(
          "openrouter",
          "Model output truncated repeatedly with no continuation progress"
        );
      }

      const continuationTail = mergedContent.slice(
        -(staleContinuationPasses > 0
          ? OPENROUTER_CONTINUATION_STALE_CONTEXT_CHARS
          : OPENROUTER_CONTINUATION_CONTEXT_CHARS)
      );
      requestMessages = [
        ...baseMessages,
        {
          role: "assistant",
          content: continuationTail,
        },
        {
          role: "user",
          content: buildContinuationInstruction(mergedContent, staleContinuationPasses),
        },
      ];

      continuationPass += 1;
    }

    throw toProviderError("openrouter", "Continuation loop exited unexpectedly");
  };

  const firstPass = await sendOpenrouterRequestWithContinuation([
    {
      role: "system",
      content: systemMessageContent,
    },
    {
      role: "user",
      content: buildOpenrouterMessageContent(input.userPrompt, provider.promptCaching),
    },
  ]);
  diagnostics.lengthFinishSignals += firstPass.lengthFinishSignals;

  const firstParsed = parseModelJsonContent<T>(firstPass.content);
  if (firstParsed === null) {
    diagnostics.invalidJsonIncidents += 1;
  } else {
    const schemaErrors = validateJsonAgainstSchema(input.schema, firstParsed);
    if (schemaErrors.length === 0) {
      return {
        data: firstParsed,
        provider: "openrouter",
        model: provider.model,
        usage: firstPass.usage,
        diagnostics,
      };
    }
    diagnostics.invalidSchemaIncidents += 1;
  }

  diagnostics.schemaRepairAttempts += 1;
  const firstSchemaErrors =
    firstParsed === null ? [] : validateJsonAgainstSchema(input.schema, firstParsed);
  const repairPrompt =
    firstParsed === null || firstSchemaErrors.length === 0
      ? buildOpenrouterRepairPrompt(input.schema, firstPass.content)
      : buildOpenrouterSchemaRepairPrompt(input.schema, firstPass.content, firstSchemaErrors);
  const repairPass = await sendOpenrouterRequestWithContinuation([
    {
      role: "system",
      content: "You are a strict JSON repair engine. Return ONLY valid JSON that matches the schema exactly.",
    },
    {
      role: "user",
      content: repairPrompt,
    },
  ]);
  diagnostics.lengthFinishSignals += repairPass.lengthFinishSignals;
  const repairedParsed = parseModelJsonContent<T>(repairPass.content);
  if (repairedParsed === null) {
    diagnostics.invalidJsonIncidents += 1;
    throw toProviderError(
      "openrouter",
      "Model returned invalid JSON after response-healing and repair pass"
    );
  }
  const repairedSchemaErrors = validateJsonAgainstSchema(input.schema, repairedParsed);
  if (repairedSchemaErrors.length > 0) {
    diagnostics.invalidSchemaIncidents += 1;
    throw toProviderError(
      "openrouter",
      `Model returned JSON that failed schema validation after repair pass: ${repairedSchemaErrors
        .slice(0, 3)
        .join(" | ")}`
    );
  }

  return {
    data: repairedParsed,
    provider: "openrouter",
    model: provider.model,
    usage: mergeUsage(firstPass.usage, repairPass.usage),
    diagnostics,
  };
}

function callProviderStructuredJson<T>(
  provider: ConfiguredModelProvider,
  input: StructuredPromptInput
): Promise<Omit<ProviderCallResult<T>, "attempts">> {
  return callOpenrouterStructuredJson(provider, input);
}

function appendStatusSuffix(message: string | undefined, status: number | undefined): string {
  const base = message ?? "unknown error";
  if (typeof status !== "number") {
    return base;
  }

  if (/\bstatus\s*[:=]?\s*\d{3}\b/i.test(base)) {
    return base;
  }

  return `${base} status=${status}`;
}

function buildProviderPool(
  phase: ModelProviderPhase,
  modelsOverride?: string[]
): ConfiguredModelProvider[] {
  const env = syncRuntimeEnv();

  const apiKey = requireEnv(env, "OPENROUTER_API_KEY");
  const baseUrl = requireHttpUrl(env, "OPENROUTER_BASE_URL");
  const models =
    modelsOverride && modelsOverride.length > 0
      ? Array.from(new Set(modelsOverride.map((model) => model.trim()).filter(Boolean)))
      : resolvePhaseModelCandidates(env, phase);
  if (models.length === 0) {
    throw new Error(`No model candidates configured for phase ${phase}`);
  }
  const reasoningEnabled = resolveReasoningEnabled(env, phase);
  const promptCaching = resolveOpenrouterPromptCaching(env);

  return models.map((model) => ({
    provider: "openrouter",
    phase,
    model,
    apiKey,
    baseUrl,
    siteUrl: env["OPENROUTER_SITE_URL"]?.trim() || undefined,
    appName: env["OPENROUTER_APP_NAME"]?.trim() || undefined,
    user: env["OPENROUTER_USER"]?.trim() || undefined,
    traceAppName:
      env["OPENROUTER_TRACE_APP_NAME"]?.trim() ||
      env["OPENROUTER_APP_NAME"]?.trim() ||
      undefined,
    timeoutMs: 0,
    reasoningEnabled,
    routing: resolveOpenrouterRouting(model),
    promptCaching,
  }));
}

export function getConfiguredModelProviders(): ConfiguredModelProvider[] {
  return buildProviderPool("coder");
}

export function getConfiguredModelProvidersForPhase(
  phase: ModelProviderPhase
): ConfiguredModelProvider[] {
  return buildProviderPool(phase);
}

export function getConfiguredModelProvidersForPhaseWithModels(
  phase: ModelProviderPhase,
  models: string[]
): ConfiguredModelProvider[] {
  return buildProviderPool(phase, models);
}

export function formatProviderModelLabel(provider: ConfiguredModelProvider): string {
  return `${provider.provider}/${provider.model}`;
}

export async function callStructuredJsonWithFallback<T>(
  providers: ConfiguredModelProvider[],
  input: StructuredPromptInput
): Promise<ProviderCallResult<T>> {
  const attempts: ProviderAttempt[] = [];
  let lastError: ProviderError | null = null;
  const MAX_SCHEMA_RECOVERY_ATTEMPTS_PER_PROVIDER = 2;
  const isSchemaLikeFailure = (message: string): boolean =>
    /\binvalid json\b|\bschema validation\b|\bfailed schema\b/i.test(message);

  for (const provider of providers) {
    for (
      let providerAttempt = 1;
      providerAttempt <= MAX_SCHEMA_RECOVERY_ATTEMPTS_PER_PROVIDER;
      providerAttempt += 1
    ) {
      const startedAt = nowMs();

      try {
        const result = await callProviderStructuredJson<T>(provider, input);
        const diagnosticsSuffix = result.diagnostics
          ? ` invalid_json_incidents=${result.diagnostics.invalidJsonIncidents} invalid_schema_incidents=${result.diagnostics.invalidSchemaIncidents} schema_repairs=${result.diagnostics.schemaRepairAttempts} length_finish_signals=${result.diagnostics.lengthFinishSignals}`
          : "";
        attempts.push({
          provider: provider.provider,
          model: provider.model,
          ok: true,
          durationMs: Math.max(1, nowMs() - startedAt),
          message:
            (result.usage?.cachedInputTokens ?? 0) > 0
              ? `cache_hit cached_input_tokens=${result.usage?.cachedInputTokens ?? 0}${diagnosticsSuffix}`
              : `cache_miss${diagnosticsSuffix}`,
        });

        return {
          ...result,
          attempts,
        };
      } catch (error) {
        const typedError = error as ProviderError;
        const providerId = typedError.provider ?? provider.provider;
        const message =
          typedError instanceof Error ? typedError.message : "Unknown model provider error";
        const status = typeof typedError.status === "number" ? typedError.status : undefined;
        const isFinalProviderAttempt =
          providerAttempt >= MAX_SCHEMA_RECOVERY_ATTEMPTS_PER_PROVIDER ||
          !isSchemaLikeFailure(message);

        if (!isFinalProviderAttempt) {
          attempts.push({
            provider: provider.provider,
            model: provider.model,
            ok: false,
            status,
            message: `${message} (schema_recovery_retry=${providerAttempt})`,
            durationMs: Math.max(1, nowMs() - startedAt),
          });
          continue;
        }

        lastError = toProviderError(providerId, message, status);
        attempts.push({
          provider: provider.provider,
          model: provider.model,
          ok: false,
          status,
          message,
          durationMs: Math.max(1, nowMs() - startedAt),
        });
        break;
      }
    }
  }

  if (attempts.length === 0) {
    throw new Error("No model provider configured for this run");
  }

  const failures = attempts
    .filter((attempt) => !attempt.ok)
    .map((attempt) => {
      return `${attempt.provider}/${attempt.model}: ${appendStatusSuffix(
        attempt.message,
        attempt.status
      )}`;
    })
    .join(" || ");

  if (lastError) {
    throw toProviderError(
      lastError.provider ?? "openrouter",
      truncateText(`All configured providers failed. ${failures}`, 900),
      lastError.status
    );
  }

  throw new Error("All configured providers failed.");
}
