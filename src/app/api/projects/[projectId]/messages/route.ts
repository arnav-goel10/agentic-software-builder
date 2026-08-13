import { NextRequest, NextResponse } from "next/server";
import {
  createMessage,
  ensureDefaultThread,
  getProjectById,
  getThreadById,
  listMessagesByThread,
  toParsedMessage,
  updateProjectTimestamp,
} from "@/lib/server/repositories";

function projectNotFound() {
  return NextResponse.json({ error: "Project not found" }, { status: 404 });
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  const project = getProjectById(projectId);

  if (!project) {
    return projectNotFound();
  }

  const thread = ensureDefaultThread(projectId);
  const messages = listMessagesByThread(thread.id).map(toParsedMessage);

  return NextResponse.json({ thread, messages });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await context.params;
  const project = getProjectById(projectId);

  if (!project) {
    return projectNotFound();
  }

  try {
    const body = await request.json();
    const content = typeof body?.content === "string" ? body.content.trim() : "";

    if (!content) {
      return NextResponse.json({ error: "Message content is required" }, { status: 400 });
    }

    const requestedThreadId = typeof body?.threadId === "string" ? body.threadId : undefined;
    const thread = requestedThreadId ? getThreadById(requestedThreadId) : ensureDefaultThread(projectId);

    if (!thread || thread.project_id !== projectId) {
      return NextResponse.json({ error: "Thread not found for project" }, { status: 404 });
    }

    const message = createMessage({
      threadId: thread.id,
      role: "user",
      content,
      meta: {},
    });

    updateProjectTimestamp(projectId);

    return NextResponse.json({ message: toParsedMessage(message), threadId: thread.id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create message";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
