import { NextResponse } from "next/server";
import {
  getRunById,
  listRunArtifacts,
  listRunSteps,
  toParsedRunArtifact,
  toParsedRunStep,
} from "@/lib/server/repositories";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; runId: string }> }
) {
  const { projectId, runId } = await context.params;
  const run = getRunById(runId);

  if (!run || run.project_id !== projectId) {
    return NextResponse.json({ error: "Run not found for project" }, { status: 404 });
  }

  const steps = listRunSteps(runId).map(toParsedRunStep);
  const artifacts = listRunArtifacts(runId).map(toParsedRunArtifact);

  return NextResponse.json({ run, steps, artifacts });
}
