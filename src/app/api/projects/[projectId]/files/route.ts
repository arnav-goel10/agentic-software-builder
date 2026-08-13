import { NextRequest, NextResponse } from "next/server";
import { getCurrentSnapshotForProject } from "@/lib/server/repositories";
import { GeneratedFile, SnapshotRow } from "@/lib/server/types";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const snapshot = getCurrentSnapshotForProject(projectId);

  if (!snapshot) {
    return NextResponse.json({ files: [] });
  }

  const files: GeneratedFile[] = JSON.parse(snapshot.files_json);
  return NextResponse.json({ files });
}
