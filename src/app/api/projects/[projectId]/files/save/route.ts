import { NextRequest, NextResponse } from "next/server";
import {
    createSnapshot,
    getCurrentSnapshotForProject,
    getLatestRunForProject,
    setProjectCurrentSnapshot,
} from "@/lib/server/repositories";
import type { GeneratedFile } from "@/lib/server/types";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const { projectId } = await params;
    const body = await request.json();
    const { path, content } = body;

    if (!path || typeof content !== "string") {
        return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    const currentSnapshot = getCurrentSnapshotForProject(projectId);
    const latestRun = getLatestRunForProject(projectId);

    if (!currentSnapshot || !latestRun) {
        return NextResponse.json(
            { error: "No active run or snapshot found" },
            { status: 404 }
        );
    }

    // Create new file list
    const currentFiles: GeneratedFile[] = JSON.parse(currentSnapshot.files_json);
    const newFiles: GeneratedFile[] = [...currentFiles];
    const existingIndex = newFiles.findIndex((f) => f.name === path);

    if (existingIndex !== -1) {
        newFiles[existingIndex] = { ...newFiles[existingIndex], code: content };
    } else {
        newFiles.push({ name: path, code: content, language: "typescript" }); // Default/inferred lang
    }

    // Create new snapshot
    const newSnapshot = createSnapshot({
        projectId,
        runId: latestRun.id,
        parentSnapshotId: currentSnapshot.id,
        summary: `User edit: ${path}`,
        files: newFiles,
    });

    // Update project pointer
    setProjectCurrentSnapshot(projectId, newSnapshot.id);

    return NextResponse.json({ success: true, snapshotId: newSnapshot.id });
}
