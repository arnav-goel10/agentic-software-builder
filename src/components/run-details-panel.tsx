"use client";

import * as React from "react";
import { ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedMessage, ParsedRunArtifact, ParsedRunStep, RunRow } from "@/lib/server/types";
import { PHASE_ORDER } from "@/lib/run-phases";

interface RunDetailsPanelProps {
  currentRun: RunRow | null;
  steps: ParsedRunStep[];
  artifacts: ParsedRunArtifact[];
  messages: ParsedMessage[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

type DiagnosticsShape = Record<string, unknown>;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const DIAGNOSTIC_LABELS: Array<{ key: string; label: string }> = [
  { key: "repairPasses", label: "Repair passes" },
  { key: "invalidJsonIncidents", label: "Invalid JSON incidents" },
  { key: "invalidSchemaIncidents", label: "Invalid schema incidents" },
  { key: "validationFailures", label: "Validation failures" },
  { key: "qaPasses", label: "QA passes" },
  { key: "qaFixPasses", label: "QA fix passes" },
  { key: "qaEscalations", label: "QA escalations" },
  { key: "fallbackSwitches", label: "Model fallback switches" },
  { key: "phaseTimeouts", label: "Phase timeouts" },
  { key: "totalOperations", label: "Total file operations" },
  { key: "noOpTasks", label: "No-op tasks" },
  { key: "deferredTasks", label: "Deferred tasks" },
];

export function RunDetailsPanel({
  currentRun,
  steps,
  artifacts,
  messages,
  collapsed,
  onToggleCollapsed,
}: RunDetailsPanelProps) {
  const metricsArtifact = React.useMemo(
    () => [...artifacts].reverse().find((artifact) => artifact.kind === "metrics"),
    [artifacts]
  );

  const diagnostics = (metricsArtifact?.content?.diagnostics ?? null) as DiagnosticsShape | null;
  const executionMode = metricsArtifact?.content?.executionMode;

  const modelChain = React.useMemo(() => {
    const chain: Array<{ phaseLabel: string; model: string; reasoning?: boolean }> = [];
    for (const { key, label } of PHASE_ORDER) {
      const phaseSteps = steps.filter((step) => step.phase === key);
      const withModel = [...phaseSteps]
        .reverse()
        .find((step) => typeof step.payload?.selectedModel === "string" && step.payload.selectedModel);
      if (withModel) {
        chain.push({
          phaseLabel: label,
          model: withModel.payload.selectedModel as string,
          reasoning:
            typeof withModel.payload?.reasoningEnabled === "boolean"
              ? (withModel.payload.reasoningEnabled as boolean)
              : undefined,
        });
      }
    }
    return chain;
  }, [steps]);

  const autofixSteps = React.useMemo(
    () => steps.filter((step) => /autofix/i.test(step.title)),
    [steps]
  );

  const finalSummary = React.useMemo(() => {
    if (currentRun?.status !== "completed") return null;
    const finalizeStep = [...steps].reverse().find((step) => step.phase === "finalize" && step.status === "complete");
    const fromStep = typeof finalizeStep?.payload?.summary === "string" ? finalizeStep.payload.summary : null;
    if (fromStep) return fromStep;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    return lastAssistant?.content ?? null;
  }, [currentRun, messages, steps]);

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label="Show run details"
        className="flex h-full w-10 shrink-0 flex-col items-center justify-start gap-2 border-l border-black/[0.08] bg-white pt-4 hover:bg-[#f5f5f7] transition-colors"
      >
        <ChevronRight className="h-4 w-4 rotate-180 text-[#a1a1a6]" />
      </button>
    );
  }

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-l border-black/[0.08] bg-white">
      <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3">
        <p className="text-[13px] font-semibold text-[#1d1d1f]">Run details</p>
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Hide run details"
          className="flex h-6 w-6 items-center justify-center rounded-[6px] text-[#a1a1a6] hover:bg-black/[0.04] hover:text-[#1d1d1f]"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
        {!currentRun ? (
          <p className="text-[13px] text-[#86868b]">Start a build to see run diagnostics here.</p>
        ) : (
          <>
            <section>
              <p className="text-label mb-2">Model chain</p>
              {modelChain.length > 0 ? (
                <ul className="space-y-1.5">
                  {modelChain.map((entry) => (
                    <li key={entry.phaseLabel} className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-[#6e6e73]">{entry.phaseLabel}</span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate rounded-[6px] bg-[#f5f5f7] px-2 py-0.5 font-mono text-[11px] text-[#1d1d1f]">
                          {entry.model}
                        </span>
                        {entry.reasoning ? (
                          <span
                            title="Reasoning enabled"
                            className="shrink-0 rounded-[4px] bg-[#0071e3]/10 px-1 py-0.5 text-[9px] font-medium text-[#0071e3]"
                          >
                            R
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-[#a1a1a6]">No model activity yet.</p>
              )}
              {typeof executionMode === "string" ? (
                <p className="mt-2 text-[11.5px] text-[#a1a1a6]">
                  Mode: <span className="font-mono">{executionMode}</span>
                </p>
              ) : null}
            </section>

            <section>
              <p className="text-label mb-2">Diagnostics</p>
              {diagnostics ? (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  {DIAGNOSTIC_LABELS.map(({ key, label }) => {
                    const value = readNumber(diagnostics[key]);
                    if (value === null) return null;
                    return (
                      <div key={key}>
                        <dt className="text-[10.5px] leading-tight text-[#a1a1a6]">{label}</dt>
                        <dd
                          className={cn(
                            "font-mono text-[13px] font-medium",
                            value > 0 && /invalid|failure|escalation|timeout/i.test(key)
                              ? "text-[#9a6700]"
                              : "text-[#1d1d1f]"
                          )}
                        >
                          {value}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              ) : (
                <p className="text-[12.5px] text-[#a1a1a6]">Diagnostics land here once the run finishes.</p>
              )}
            </section>

            {autofixSteps.length > 0 ? (
              <section>
                <div className="mb-2 flex items-center gap-1.5">
                  <Wrench className="h-3 w-3 text-[#a1a1a6]" />
                  <p className="text-label">Deterministic autofixes</p>
                </div>
                <ul className="space-y-1.5">
                  {autofixSteps.map((step) => (
                    <li key={step.id} className="rounded-[8px] border border-black/[0.06] bg-[#fafafa] px-2.5 py-2">
                      <p className="text-[12px] font-medium text-[#1d1d1f]">{step.title}</p>
                      {step.detail ? (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-[#86868b]">{step.detail}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {finalSummary ? (
              <section>
                <p className="text-label mb-2">Summary</p>
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[#3a3a3c]">{finalSummary}</p>
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
