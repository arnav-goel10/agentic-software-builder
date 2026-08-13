import { NextRequest, NextResponse } from "next/server";
import {
  createRun,
  findActiveRunForProject,
  getMessageById,
  getProjectById,
  getThreadById,
  listRunsByProject,
} from "@/lib/server/repositories";
import {
  describeRunForLog,
  ensureRunDispatcherStarted,
  queueRunExecution,
} from "@/lib/server/agent/orchestrator";
import {
  formatProviderModelLabel,
  getConfiguredModelProvidersForPhase,
} from "@/lib/server/agent/model-provider";

function projectNotFound() {
  return NextResponse.json({ error: "Project not found" }, { status: 404 });
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) {
  ensureRunDispatcherStarted();
  const { projectId } = await context.params;
  const project = getProjectById(projectId);

  if (!project) {
    return projectNotFound();
  }

  const runs = listRunsByProject(projectId);
  return NextResponse.json({ runs });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> }
) {
  ensureRunDispatcherStarted();
  const { projectId } = await context.params;
  const project = getProjectById(projectId);

  if (!project) {
    return projectNotFound();
  }

  try {
    const body = await request.json();
    const threadId = typeof body?.threadId === "string" ? body.threadId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";

    if (!threadId || !messageId) {
      return NextResponse.json({ error: "threadId and messageId are required" }, { status: 400 });
    }

    const thread = getThreadById(threadId);
    if (!thread || thread.project_id !== projectId) {
      return NextResponse.json({ error: "Thread not found for project" }, { status: 404 });
    }

    const triggerMessage = getMessageById(messageId);
    if (!triggerMessage || triggerMessage.thread_id !== threadId) {
      return NextResponse.json({ error: "messageId must belong to the selected thread" }, { status: 400 });
    }

    const activeRun = findActiveRunForProject(projectId);
    if (activeRun) {
      return NextResponse.json(
        {
          error: "An active run already exists for this project",
          activeRunId: activeRun.id,
        },
        { status: 409 }
      );
    }

    const providers = getConfiguredModelProvidersForPhase("run_metadata");
    const runModel = formatProviderModelLabel(providers[0]);

    const run = createRun({
      projectId,
      threadId,
      triggerMessageId: messageId,
      model: runModel,
    });

    console.log(`[run:create] ${describeRunForLog(run)}`);

    queueRunExecution(run.id);

    return NextResponse.json({ runId: run.id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create run";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
