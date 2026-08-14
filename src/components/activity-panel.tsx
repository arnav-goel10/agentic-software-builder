"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, History, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedMessage, ParsedRunStep, RunRow } from "@/lib/server/types";
import { formatElapsed } from "@/lib/run-phases";

type SnapshotMeta = {
  id: string;
  runId: string;
  summary: string;
  fileCount: number;
  createdAt: number;
};

interface ActivityPanelProps {
  messages: ParsedMessage[];
  currentRun: RunRow | null;
  runHistory: RunRow[];
  steps: ParsedRunStep[];
  snapshots: SnapshotMeta[];
  isRunning: boolean;
  error: string;
  hasProject: boolean;
  onSendMessage: (content: string) => Promise<void>;
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatRunDuration(run: RunRow): string | null {
  if (!run.started_at || !run.finished_at) return null;
  return formatElapsed(Math.max(0, run.finished_at - run.started_at));
}

function summarizeRunLabel(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "Build request";
  return compact.length > 96 ? `${compact.slice(0, 96).trim()}...` : compact;
}

function runStatusMeta(run: RunRow): { label: string; className: string } {
  switch (run.status) {
    case "completed":
      return { label: "Completed", className: "text-[#1a7f37] bg-[#1a7f37]/10 border-[#1a7f37]/15" };
    case "failed":
      return { label: "Failed", className: "text-[#d1242f] bg-[#d1242f]/10 border-[#d1242f]/15" };
    case "cancelled":
      return { label: "Cancelled", className: "text-[#9a6700] bg-[#9a6700]/10 border-[#9a6700]/15" };
    default:
      return { label: "Running", className: "text-[#0071e3] bg-[#0071e3]/10 border-[#0071e3]/15" };
  }
}

function stepStatusDotClass(status: ParsedRunStep["status"]): string {
  switch (status) {
    case "complete":
      return "bg-[#1a7f37]";
    case "error":
      return "bg-[#d1242f]";
    case "running":
      return "bg-[#0071e3]";
    default:
      return "bg-black/[0.15]";
  }
}

export function ActivityPanel({
  messages,
  currentRun,
  runHistory,
  steps,
  snapshots,
  isRunning,
  error,
  hasProject,
  onSendMessage,
  onRestoreSnapshot,
}: ActivityPanelProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [expandedStepId, setExpandedStepId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, steps, isRunning]);

  const snapshotByRunId = React.useMemo(() => {
    const map = new Map<string, SnapshotMeta>();
    for (const snapshot of snapshots) {
      map.set(snapshot.runId, snapshot);
    }
    return map;
  }, [snapshots]);

  const messageById = React.useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const pastRuns = React.useMemo(() => {
    const merged = [...runHistory];
    if (currentRun && !merged.some((run) => run.id === currentRun.id)) {
      merged.unshift(currentRun);
    }
    return merged
      .filter((run) => !(isRunning && currentRun && run.id === currentRun.id))
      .sort((a, b) => b.created_at - a.created_at);
  }, [currentRun, isRunning, runHistory]);

  const handleSend = async () => {
    if (!inputValue.trim() || isSubmitting || isRunning || !hasProject) return;
    const content = inputValue.trim();
    setInputValue("");
    setIsSubmitting(true);
    try {
      await onSendMessage(content);
    } catch {
      setInputValue(content);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 space-y-6">
        {messages.length === 0 && !isRunning ? (
          <div className="flex h-40 flex-col items-center justify-center text-center">
            <p className="text-[13px] text-[#86868b]">No activity yet.</p>
          </div>
        ) : null}

        {messages.length > 0 ? (
          <div className="space-y-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn("flex flex-col max-w-[92%]", message.role === "user" ? "ml-auto items-end" : "mr-auto items-start")}
              >
                <span className="mb-1 px-1 text-[11px] font-medium text-[#a1a1a6]">
                  {message.role === "user" ? "You" : "Dexter"} · {formatTimestamp(message.createdAt)}
                </span>
                <div
                  className={cn(
                    "rounded-[12px] px-3.5 py-2.5 text-[13.5px] leading-relaxed",
                    message.role === "user"
                      ? "bg-[#0071e3] text-white rounded-tr-[4px]"
                      : "bg-[#f5f5f7] text-[#1d1d1f] rounded-tl-[4px]"
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {isRunning ? (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 px-1">
              <Loader2 className="h-3 w-3 animate-spin text-[#0071e3]" />
              <p className="text-label text-[#0071e3]">Live steps</p>
            </div>

            {steps.length === 0 ? (
              <div className="rounded-[10px] border border-black/[0.08] bg-white px-3.5 py-3">
                <p className="text-[13px] text-[#86868b]">Preparing run steps...</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {steps.map((step) => {
                  const isExpanded = expandedStepId === step.id;
                  return (
                    <div key={step.id} className="rounded-[10px] border border-black/[0.08] bg-white overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setExpandedStepId((curr) => (curr === step.id ? null : step.id))}
                        aria-expanded={isExpanded}
                        className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left"
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            stepStatusDotClass(step.status),
                            step.status === "running" && "animate-pulse"
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#1d1d1f]">
                          {step.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-[#a1a1a6]">
                          {isExpanded ? "Hide" : "Details"}
                        </span>
                      </button>
                      <AnimatePresence initial={false}>
                        {isExpanded ? (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                            className="overflow-hidden"
                          >
                            <div className="border-t border-black/[0.06] bg-[#fafafa] px-3.5 py-2.5">
                              <p className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[#6e6e73]">
                                {step.detail || "No additional detail for this step."}
                              </p>
                            </div>
                          </motion.div>
                        ) : null}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : null}

        {pastRuns.length > 0 ? (
          <div className="space-y-2 border-t border-black/[0.06] pt-5">
            <div className="flex items-center gap-1.5 px-1">
              <History className="h-3 w-3 text-[#a1a1a6]" />
              <p className="text-label">Past runs</p>
            </div>
            <div className="space-y-1.5">
              {pastRuns.map((run) => {
                const prompt = messageById.get(run.trigger_message_id)?.content ?? "Build request";
                const meta = runStatusMeta(run);
                const duration = formatRunDuration(run);
                const snapshot = snapshotByRunId.get(run.id);
                return (
                  <div key={run.id} className="rounded-[10px] border border-black/[0.08] bg-white px-3.5 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-[12.5px] text-[#1d1d1f]">
                        {summarizeRunLabel(prompt)}
                      </p>
                      <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium", meta.className)}>
                        {meta.label}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[#a1a1a6]">
                        {formatTimestamp(run.created_at)}
                        {duration ? ` · ${duration}` : ""}
                      </span>
                      {snapshot ? (
                        <button
                          type="button"
                          onClick={() => void onRestoreSnapshot(snapshot.id)}
                          className="text-[11px] font-medium text-[#0071e3] hover:text-[#0058b0] rounded-[4px]"
                        >
                          Restore this version
                        </button>
                      ) : null}
                    </div>
                    {run.error ? (
                      <p className="mt-1.5 text-[11.5px] text-[#d1242f]">{run.error}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-black/[0.08] bg-white px-4 py-3">
        {error ? (
          <div role="alert" className="mb-2.5 rounded-[10px] border border-[#d1242f]/20 bg-[#d1242f]/5 px-3 py-2 text-[12.5px] text-[#d1242f]">
            {error}
          </div>
        ) : null}
        <div className="flex items-end gap-2 rounded-[12px] border border-black/[0.1] bg-[#fafafa] px-3 py-2 focus-within:border-[#0071e3]/40 focus-within:ring-2 focus-within:ring-[#0071e3]/10 transition-colors">
          <label htmlFor="activity-composer" className="sr-only">
            Send a follow-up instruction to Dexter
          </label>
          <textarea
            id="activity-composer"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSend();
              }
            }}
            disabled={isSubmitting || isRunning || !hasProject}
            placeholder={hasProject ? "Ask Dexter to change something..." : "Start a build to chat here"}
            rows={1}
            className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-[13.5px] text-[#1d1d1f] placeholder:text-[#a1a1a6] outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={!inputValue.trim() || isSubmitting || isRunning || !hasProject}
            aria-label="Send message"
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors",
              !inputValue.trim() || isSubmitting || isRunning || !hasProject
                ? "bg-black/[0.06] text-[#c7c7cc]"
                : "bg-[#0071e3] text-white hover:bg-[#0077ed]"
            )}
          >
            {isSubmitting || isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUp className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
