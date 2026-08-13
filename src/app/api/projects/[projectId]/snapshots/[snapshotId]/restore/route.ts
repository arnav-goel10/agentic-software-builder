import { NextResponse } from "next/server";
import {
  getProjectById,
  getSnapshotById,
  restoreSnapshotForProject,
  getCurrentSnapshotForProject,
  toParsedSnapshot,
} from "@/lib/server/repositories";

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string; snapshotId: string }> }
) {
  const { projectId, snapshotId } = await context.params;

  const project = getProjectById(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const snapshot = getSnapshotById(snapshotId);
  if (!snapshot || snapshot.project_id !== projectId) {
    return NextResponse.json({ error: "Snapshot not found for project" }, { status: 404 });
  }

  restoreSnapshotForProject(projectId, snapshotId);

  const updatedProject = getProjectById(projectId);
  const currentSnapshot = getCurrentSnapshotForProject(projectId);

  return NextResponse.json({
    project: updatedProject,
    currentSnapshot: currentSnapshot ? toParsedSnapshot(currentSnapshot) : null,
  });
}
