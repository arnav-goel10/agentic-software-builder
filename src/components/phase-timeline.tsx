"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedRunStep, RunRow } from "@/lib/server/types";
import { computePhaseTimeline, formatElapsed, type PhaseTimelineEntry } from "@/lib/run-phases";

interface PhaseTimelineProps {
  steps: ParsedRunStep[];
  currentRun: RunRow | null;
  isRunning: boolean;
}

/** Re-renders once a second while a run is active so elapsed times tick smoothly. */
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function elapsedFor(entry: PhaseTimelineEntry, now: number): string | null {
  if (entry.startedAt === null) return null;
  const end = entry.finishedAt ?? now;
  return formatElapsed(end - entry.startedAt);
}

export function PhaseTimeline({ steps, currentRun, isRunning }: PhaseTimelineProps) {
  const now = useNow(isRunning);
  const timeline = React.useMemo(() => computePhaseTimeline(steps), [steps]);

  const totalElapsed = React.useMemo(() => {
    if (!currentRun?.started_at) return null;
    const end = currentRun.finished_at ?? now;
    return formatElapsed(end - currentRun.started_at);
  }, [currentRun, now]);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto px-4 py-6">
      <div className="mb-5 px-1">
        <p className="text-label mb-1">Run</p>
        {currentRun ? (
          <p className="font-mono text-[12px] text-[#6e6e73]">
            {totalElapsed ? `${totalElapsed} elapsed` : "Queued"}
          </p>
        ) : (
          <p className="text-[13px] text-[#86868b]">No run yet</p>
        )}
      </div>

      <ol className="relative flex flex-col">
        {timeline.map((entry, index) => {
          const isLast = index === timeline.length - 1;
          const elapsed = elapsedFor(entry, now);

          return (
            <li key={entry.key} className="relative flex gap-3 pb-6 last:pb-0">
              {!isLast && (
                <span
                  aria-hidden
                  className="absolute left-[11px] top-6 bottom-0 w-px bg-black/[0.08]"
                >
                  <motion.span
                    className="block w-full bg-[#0071e3]"
                    initial={false}
                    animate={{ height: entry.status === "done" ? "100%" : "0%" }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                  />
                </span>
              )}

              <PhaseDot status={entry.status} />

              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "text-[13.5px] font-medium tracking-tight",
                      entry.status === "pending" ? "text-[#a1a1a6]" : "text-[#1d1d1f]"
                    )}
                  >
                    {entry.label}
                  </span>
                  {elapsed ? (
                    <span className="font-mono text-[11px] text-[#86868b] shrink-0">{elapsed}</span>
                  ) : null}
                </div>
                {entry.status === "active" ? (
                  <p className="mt-0.5 text-[11.5px] text-[#0071e3]">In progress</p>
                ) : entry.status === "error" ? (
                  <p className="mt-0.5 text-[11.5px] text-[#d1242f]">Needs attention</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PhaseDot({ status }: { status: PhaseTimelineEntry["status"] }) {
  if (status === "done") {
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0071e3]">
        <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#d1242f]">
        <X className="h-3.5 w-3.5 text-white" strokeWidth={3} />
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white ring-2 ring-[#0071e3]">
        <span className="pulse-ring absolute h-6 w-6 rounded-full" />
        <span className="h-2 w-2 rounded-full bg-[#0071e3]" />
      </span>
    );
  }
  return (
    <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white ring-2 ring-black/[0.1]">
      <span className="h-2 w-2 rounded-full bg-black/[0.15]" />
    </span>
  );
}
