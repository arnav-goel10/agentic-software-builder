import type { ParsedRunStep, RunRow } from "@/lib/server/types";

export type RunEventType =
  | "run_started"
  | "run_snapshot"
  | "run_heartbeat"
  | "step"
  | "spec_progress"
  | "architect_progress"
  | "qa_progress"
  | "coder_started"
  | "coder_progress"
  | "coder_completed"
  | "coder_deferred"
  | "coder_noop_classified"
  | "validation_failed"
  | "repair_started"
  | "context_compacted"
  | "memory_cards_updated"
  | "phase_timeout"
  | "preview_ready"
  | "preview_reused"
  | "run_completed"
  | "run_failed";

export type RunEventPayload = {
  runId: string;
  projectId: string;
  timestamp: number;
  run?: RunRow;
  step?: ParsedRunStep;
  message?: string;
  snapshotId?: string;
  summary?: string;
  error?: string;
  issues?: string[];
  taskId?: string;
  title?: string;
  detail?: string;
  operations?: Array<Record<string, unknown>>;
  phase?: string;
  model?: string;
  modelCandidates?: string[];
  reasoningEnabled?: boolean;
  phaseTimeoutMs?: number;
  executionMode?: string;
  taskObjectiveType?: string;
  noOpClassification?: string;
  memoryCardIds?: string[];
  retrievedContextStats?: Record<string, unknown>;
  changedFiles?: {
    created: string[];
    updated: string[];
    deleted: string[];
  } | null;
};

export type RunEvent = {
  type: RunEventType;
  payload: RunEventPayload;
};

type Listener = (event: RunEvent) => void;

class RunEventBus {
  private readonly listenersByRun = new Map<string, Set<Listener>>();

  subscribe(runId: string, listener: Listener): () => void {
    const listeners = this.listenersByRun.get(runId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listenersByRun.set(runId, listeners);

    return () => {
      const current = this.listenersByRun.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listenersByRun.delete(runId);
      }
    };
  }

  publish(event: RunEvent): void {
    const listeners = this.listenersByRun.get(event.payload.runId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[run-event-bus] listener error", error);
      }
    }
  }
}

type GlobalWithEventBus = typeof globalThis & {
  __dexterRunEventBus?: RunEventBus;
};

function getBus(): RunEventBus {
  const globalRef = globalThis as GlobalWithEventBus;
  if (!globalRef.__dexterRunEventBus) {
    globalRef.__dexterRunEventBus = new RunEventBus();
  }
  return globalRef.__dexterRunEventBus;
}

export function subscribeToRunEvents(runId: string, listener: Listener): () => void {
  return getBus().subscribe(runId, listener);
}

export function publishRunEvent(event: RunEvent): void {
  getBus().publish(event);
}
