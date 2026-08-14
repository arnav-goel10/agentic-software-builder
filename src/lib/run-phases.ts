import type { ParsedRunStep, StepPhase } from "@/lib/server/types";

export type PhaseTimelineStatus = "pending" | "active" | "done" | "error";

export interface PhaseTimelineEntry {
  key: StepPhase;
  label: string;
  status: PhaseTimelineStatus;
  startedAt: number | null;
  finishedAt: number | null;
  stepCount: number;
}

/**
 * Canonical phase order the engine executes in: spec -> plan -> skeleton DAG
 * -> validate -> code fill -> build gates -> QA -> snapshot. Mirrors
 * StepPhase in lib/server/types.ts.
 */
export const PHASE_ORDER: { key: StepPhase; label: string }[] = [
  { key: "spec", label: "Spec" },
  { key: "architect", label: "Plan" },
  { key: "scaffold", label: "Scaffold" },
  { key: "validate", label: "Validate" },
  { key: "coder", label: "Code" },
  { key: "review", label: "Gates" },
  { key: "qa", label: "QA" },
  { key: "finalize", label: "Done" },
];

export function computePhaseTimeline(steps: ParsedRunStep[]): PhaseTimelineEntry[] {
  return PHASE_ORDER.map(({ key, label }) => {
    const phaseSteps = steps.filter((step) => step.phase === key);

    if (phaseSteps.length === 0) {
      return { key, label, status: "pending", startedAt: null, finishedAt: null, stepCount: 0 };
    }

    const hasError = phaseSteps.some((step) => step.status === "error");
    const hasRunning = phaseSteps.some((step) => step.status === "running");
    const allComplete = phaseSteps.every((step) => step.status === "complete");

    const status: PhaseTimelineStatus = hasError
      ? "error"
      : hasRunning
        ? "active"
        : allComplete
          ? "done"
          : "pending";

    const startedTimes = phaseSteps
      .map((step) => step.startedAt)
      .filter((value): value is number => typeof value === "number");
    const finishedTimes = phaseSteps
      .map((step) => step.finishedAt)
      .filter((value): value is number => typeof value === "number");

    return {
      key,
      label,
      status,
      startedAt: startedTimes.length > 0 ? Math.min(...startedTimes) : null,
      finishedAt:
        finishedTimes.length === phaseSteps.length && finishedTimes.length > 0
          ? Math.max(...finishedTimes)
          : null,
      stepCount: phaseSteps.length,
    };
  });
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
