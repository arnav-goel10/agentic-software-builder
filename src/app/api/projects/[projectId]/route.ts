import { NextResponse } from "next/server";
import {
  deleteProjectById,
  ensureDefaultThread,
  findActiveRunForProject,
  getProjectSummary,
  updateRunStatus,
  toParsedSnapshot,
} from "@/lib/server/repositories";
import { cancelRun } from "@/lib/server/agent/orchestrator";


function notFoundResponse() {
  return NextResponse.json({ error: "Project not found" }, { status: 404 });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  const summary = getProjectSummary(projectId);

  if (!summary) {
    return notFoundResponse();
  }

  const thread = ensureDefaultThread(projectId);

  return NextResponse.json({
    project: summary.project,
    thread,
    currentSnapshot: summary.currentSnapshot ? toParsedSnapshot(summary.currentSnapshot) : null,
    latestRun: summary.latestRun,
  });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;

  const activeRun = findActiveRunForProject(projectId);
  if (activeRun) {
    console.log(`[project:${projectId}] Deleting project with active run ${activeRun.id} — signalling cancellation`);
    cancelRun(activeRun.id);
    updateRunStatus({
      runId: activeRun.id,
      status: "cancelled",
      error: "Run cancelled during project deletion.",
    });
  }



  const deleted = deleteProjectById(projectId);

  if (!deleted) {
    return notFoundResponse();
  }

  return NextResponse.json({ success: true });
}
