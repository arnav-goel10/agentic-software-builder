import fs from "node:fs";
import path from "node:path";

type RuntimeEnvCache = {
  signature: string;
  managedKeys: Set<string>;
};

const initialProcessEnv = new Map<string, string | undefined>();
Object.keys(process.env).forEach((key) => {
  initialProcessEnv.set(key, process.env[key]);
});

let runtimeEnvCache: RuntimeEnvCache | null = null;

function getRuntimeEnvFilePaths(): string[] {
  const root = process.cwd();
  const nodeEnv = (process.env.NODE_ENV?.trim() || "development").toLowerCase();

  const ordered = [
    ".env",
    `.env.${nodeEnv}`,
    ".env.local",
    `.env.${nodeEnv}.local`,
  ];

  const deduped = new Set<string>();
  for (const fileName of ordered) {
    deduped.add(path.join(root, fileName));
  }
  return Array.from(deduped);
}

function buildSignature(paths: string[]): string {
  return paths
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    })
    .join("|");
}

function unquoteValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? "";
    parsed[key] = unquoteValue(rawValue);
  }

  return parsed;
}

function loadRuntimeEnvFromFiles(paths: string[]): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseEnvContent(content);
    Object.assign(merged, parsed);
  }

  return merged;
}

function applyManagedEnv(nextEnv: Record<string, string>, previousKeys: Set<string>): void {
  const nextKeys = new Set(Object.keys(nextEnv));

  for (const key of previousKeys) {
    if (nextKeys.has(key)) {
      continue;
    }

    if (initialProcessEnv.has(key)) {
      const initialValue = initialProcessEnv.get(key);
      if (typeof initialValue === "string") {
        process.env[key] = initialValue;
      } else {
        delete process.env[key];
      }
    } else {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(nextEnv)) {
    process.env[key] = value;
  }
}

export function syncRuntimeEnv(): NodeJS.ProcessEnv {
  const paths = getRuntimeEnvFilePaths();
  const signature = buildSignature(paths);

  if (runtimeEnvCache && runtimeEnvCache.signature === signature) {
    return process.env;
  }

  const parsed = loadRuntimeEnvFromFiles(paths);
  const previousKeys = runtimeEnvCache?.managedKeys ?? new Set<string>();
  applyManagedEnv(parsed, previousKeys);

  runtimeEnvCache = {
    signature,
    managedKeys: new Set(Object.keys(parsed)),
  };

  return process.env;
}

export function getRuntimeEnvValue(key: string): string | undefined {
  const env = syncRuntimeEnv();
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

export function getRuntimePublicEnv(keys: readonly string[]): Record<string, string> {
  syncRuntimeEnv();

  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      result[key] = value;
    }
  }

  return result;
}
