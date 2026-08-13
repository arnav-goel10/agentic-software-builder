import { getRunById, listRunSteps, toParsedRunStep } from "@/lib/server/repositories";
import { subscribeToRunEvents, type RunEventType } from "@/lib/server/agent/event-bus";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const STEP_POLL_INTERVAL_MS = 1000;

function encodeSseEvent(type: RunEventType, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function encodeSseComment(comment: string): string {
  return `: ${comment}\n\n`;
}

function toTerminalEvent(status: string): RunEventType {
  return status === "completed" ? "run_completed" : "run_failed";
}

function stepFingerprint(step: ReturnType<typeof toParsedRunStep>): string {
  return JSON.stringify({
    seq: step.seq,
    status: step.status,
    title: step.title,
    detail: step.detail,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    payload: step.payload,
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; runId: string }> }
) {
  const { projectId, runId } = await context.params;
  const run = getRunById(runId);

  if (!run || run.project_id !== projectId) {
    return new Response(JSON.stringify({ error: "Run not found for project" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let terminalSent = false;
      const seenStepFingerprints = new Map<string, string>();

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };

      const emitStep = (step: ReturnType<typeof toParsedRunStep>) => {
        seenStepFingerprints.set(step.id, stepFingerprint(step));
        write(
          encodeSseEvent("step", {
            runId,
            projectId,
            timestamp: Date.now(),
            step,
          })
        );
      };

      const emitTerminalIfNeeded = (status: string, payload: unknown) => {
        if (terminalSent || !TERMINAL_STATUSES.has(status)) {
          return;
        }
        terminalSent = true;
        write(encodeSseEvent(toTerminalEvent(status), payload));
      };

      const unsubscribe = subscribeToRunEvents(runId, (event) => {
        if (event.type === "step" && event.payload.step) {
          seenStepFingerprints.set(event.payload.step.id, stepFingerprint(event.payload.step));
        }

        write(encodeSseEvent(event.type, event.payload));

        if (event.type === "run_completed" || event.type === "run_failed") {
          terminalSent = true;
          clearInterval(heartbeat);
          clearInterval(stepPoll);
          clearInterval(statusPoll);
          unsubscribe();
          close();
        }
      });

      write(
        encodeSseEvent("run_snapshot", {
          runId,
          projectId,
          timestamp: Date.now(),
          run,
        })
      );

      const existingSteps = listRunSteps(runId).map(toParsedRunStep);
      for (const step of existingSteps) {
        emitStep(step);
      }

      const heartbeat = setInterval(() => {
        write(encodeSseComment("ping"));
      }, 15000);

      const stepPoll = setInterval(() => {
        const latestRun = getRunById(runId);
        if (!latestRun) {
          clearInterval(heartbeat);
          clearInterval(stepPoll);
          clearInterval(statusPoll);
          unsubscribe();
          close();
          return;
        }

        const latestSteps = listRunSteps(runId).map(toParsedRunStep);
        for (const step of latestSteps) {
          const fingerprint = stepFingerprint(step);
          if (seenStepFingerprints.get(step.id) === fingerprint) {
            continue;
          }
          emitStep(step);
        }

        if (TERMINAL_STATUSES.has(latestRun.status)) {
          emitTerminalIfNeeded(latestRun.status, {
            runId,
            projectId,
            timestamp: Date.now(),
            run: latestRun,
            error: latestRun.error,
          });

          clearInterval(heartbeat);
          clearInterval(stepPoll);
          clearInterval(statusPoll);
          unsubscribe();
          close();
        }
      }, STEP_POLL_INTERVAL_MS);

      const statusPoll = setInterval(() => {
        const latestRun = getRunById(runId);
        if (!latestRun) {
          clearInterval(heartbeat);
          clearInterval(stepPoll);
          clearInterval(statusPoll);
          unsubscribe();
          close();
          return;
        }

        if (TERMINAL_STATUSES.has(latestRun.status)) {
          emitTerminalIfNeeded(latestRun.status, {
            runId,
            projectId,
            timestamp: Date.now(),
            run: latestRun,
            error: latestRun.error,
          });

          clearInterval(heartbeat);
          clearInterval(stepPoll);
          clearInterval(statusPoll);
          unsubscribe();
          close();
        }
      }, 2000);

      const onAbort = () => {
        clearInterval(heartbeat);
        clearInterval(stepPoll);
        clearInterval(statusPoll);
        unsubscribe();
        close();
      };

      request.signal.addEventListener("abort", onAbort, { once: true });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
