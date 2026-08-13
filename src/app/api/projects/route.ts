import { NextRequest, NextResponse } from "next/server";
import {
  createProject,
  ensureDefaultThread,
  listProjects,
  toParsedSnapshot,
} from "@/lib/server/repositories";

export async function GET() {
  const projects = listProjects().map((item) => ({
    project: item.project,
    currentSnapshot: item.currentSnapshot ? toParsedSnapshot(item.currentSnapshot) : null,
    latestRun: item.latestRun,
  }));

  return NextResponse.json({ projects });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";

    if (!name) {
      return NextResponse.json({ error: "Project name is required" }, { status: 400 });
    }

    const project = createProject({
      name,
      description,
    });
    const thread = ensureDefaultThread(project.id);

    return NextResponse.json({ project, thread }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create project";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
