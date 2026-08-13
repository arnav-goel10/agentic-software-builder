import { NextRequest, NextResponse } from "next/server";
import {
    getCurrentSnapshotForProject,
    getSnapshotById,
    setProjectCurrentSnapshot,
} from "@/lib/server/repositories";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const { projectId } = await params;
    let current = getCurrentSnapshotForProject(projectId);

    if (!current) {
        return NextResponse.json({ error: "No snapshot found" }, { status: 404 });
    }

    // Walk back until we find a non-user-edit snapshot
    // Safety limit to prevent infinite loops
    let steps = 0;
    while (current && current.summary.startsWith("User edit") && steps < 50) {
        if (!current.parent_snapshot_id) break;
        const parent = getSnapshotById(current.parent_snapshot_id);
        if (!parent) break;
        current = parent;
        steps++;
    }

    if (current) {
        setProjectCurrentSnapshot(projectId, current.id);
        return NextResponse.json({ success: true, snapshotId: current.id });
    }

    return NextResponse.json(
        { error: "Could not find agent checkpoint" },
        { status: 400 }
    );
}
