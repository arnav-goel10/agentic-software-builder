import { NextResponse } from "next/server";
import { getRuntimeEnvValue } from "@/lib/server/runtime-env";

/**
 * Tiny, non-secret config surface for the client. Currently only exposes
 * which model provider the engine is running against, so the UI can show a
 * neutral "demo mode" indicator when running on deterministic mock fixtures
 * instead of a real LLM provider. Never returns API keys or other secrets.
 */
export async function GET() {
  const raw = getRuntimeEnvValue("DEXTER_MODEL_PROVIDER")?.trim().toLowerCase();
  const provider = raw === "google" || raw === "mock" ? raw : "openrouter";

  return NextResponse.json({
    provider,
    isMock: provider === "mock",
  });
}
