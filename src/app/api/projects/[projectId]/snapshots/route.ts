import { NextResponse } from "next/server";
import {
  getProjectById,
  listSnapshotsByProject,
  toParsedSnapshot,
} from "@/lib/server/repositories";

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  const project = getProjectById(projectId);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const snapshots = listSnapshotsByProject(projectId).map((snapshot) => {
    const parsed = toParsedSnapshot(snapshot);
    return {
      id: parsed.id,
      projectId: parsed.projectId,
      runId: parsed.runId,
      parentSnapshotId: parsed.parentSnapshotId,
      summary: parsed.summary,
      fileCount: parsed.files.length,
      createdAt: parsed.createdAt,
    };
  });

  return NextResponse.json({ snapshots });
}
