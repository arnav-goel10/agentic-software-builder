"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, Loader2, Send, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedMessage, ParsedRunStep, RunRow } from "@/lib/server/types";

type SnapshotMeta = {
  id: string;
  summary: string;
  fileCount: number;
  createdAt: number;
};

interface SandboxAgentPanelProps {
  projectName: string;
  messages: ParsedMessage[];
  currentRun: RunRow | null;
  runHistory: RunRow[];
  steps: ParsedRunStep[];
  snapshots: SnapshotMeta[];
  isRunning: boolean;
  error: string;
  onSendMessage: (content: string) => Promise<void>;
  onRestoreSnapshot: (snapshotId: string) => Promise<void>;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRunDuration(run: RunRow): string {
  if (!run.started_at || !run.finished_at) return "";
  const durationMs = Math.max(0, run.finished_at - run.started_at);
  const durationSeconds = Math.round(durationMs / 1000);
  if (durationSeconds < 60) {
    return `${durationSeconds}s`;
  }
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function summarizeRunLabel(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "Execution run";
  return compact.length > 72 ? `${compact.slice(0, 72).trim()}...` : compact;
}

function summarizeRunDetail(run: RunRow): string {
  if (run.error) {
    const compact = run.error.replace(/\s+/g, " ").trim();
    return compact.length > 140 ? `${compact.slice(0, 140).trim()}...` : compact;
  }
  if (run.status === "completed") {
    const duration = formatRunDuration(run);
    return duration ? `Completed in ${duration}` : "Completed";
  }
  if (run.status === "failed") return "Failed";
  if (run.status === "cancelled") return "Cancelled";
  return "In progress";
}

function formatRunStatus(status: RunRow["status"]): string {
  switch (status) {
    case "completed":
      return "COMPLETED";
    case "failed":
      return "FAILED";
    case "cancelled":
      return "CANCELLED";
    case "queued":
      return "QUEUED";
    case "planning":
    case "executing":
    case "validating":
    case "repairing":
      return "RUNNING";
    default:
      return "UNKNOWN";
  }
}

function stringifyStepTelemetry(step: ParsedRunStep): string {
  const payload = step.payload ?? {};
  const lines: string[] = [];

  const selectedModel = typeof payload.selectedModel === "string" ? payload.selectedModel : "";
  if (selectedModel) {
    lines.push(`MODEL: ${selectedModel}`);
  }

  const executionMode = typeof payload.executionMode === "string" ? payload.executionMode : "";
  if (executionMode) {
    lines.push(`MODE: ${executionMode}`);
  }

  const taskObjectiveType =
    typeof payload.taskObjectiveType === "string" ? payload.taskObjectiveType : "";
  if (taskObjectiveType) {
    lines.push(`OBJECTIVE: ${taskObjectiveType}`);
  }

  const candidates = Array.isArray(payload.modelCandidates)
    ? payload.modelCandidates.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (candidates.length > 0) {
    lines.push(`CANDIDATES: ${candidates.join(", ")}`);
  }

  if (typeof payload.reasoningEnabled === "boolean") {
    lines.push(`REASONING: ${payload.reasoningEnabled ? "ENABLED" : "DISABLED"}`);
  }

  if (typeof payload.phaseTimeoutMs === "number" && Number.isFinite(payload.phaseTimeoutMs)) {
    lines.push(`TIMEOUT_MS: ${payload.phaseTimeoutMs}`);
  }

  const ownedFiles = Array.isArray(payload.ownedFiles)
    ? payload.ownedFiles.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (ownedFiles.length > 0) {
    lines.push(`OWNED_FILES: ${ownedFiles.join(", ")}`);
  }

  const changedFiles = payload.changedFiles && typeof payload.changedFiles === "object"
    ? payload.changedFiles as {
      created?: string[];
      updated?: string[];
      deleted?: string[];
    }
    : null;
  if (changedFiles) {
    const created = Array.isArray(changedFiles.created) ? changedFiles.created.length : 0;
    const updated = Array.isArray(changedFiles.updated) ? changedFiles.updated.length : 0;
    const deleted = Array.isArray(changedFiles.deleted) ? changedFiles.deleted.length : 0;
    lines.push(`CHANGED: +${created} ~${updated} -${deleted}`);
  }

  if (
    typeof payload.attempt === "number" &&
    typeof payload.maxAttempts === "number"
  ) {
    lines.push(`QA_ATTEMPT: ${payload.attempt}/${payload.maxAttempts}`);
  }

  const hardBlockers = Array.isArray(payload.hardBlockers)
    ? payload.hardBlockers.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const softBlockers = Array.isArray(payload.softBlockers)
    ? payload.softBlockers.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  if (hardBlockers.length > 0 || softBlockers.length > 0) {
    lines.push(`BLOCKERS: hard=${hardBlockers.length} soft=${softBlockers.length}`);
  }

  if (typeof payload.blockingDecision === "string" && payload.blockingDecision) {
    lines.push(`QA_DECISION: ${payload.blockingDecision}`);
  }

  const noOpClassification =
    payload.noOpClassification && typeof payload.noOpClassification === "object"
      ? payload.noOpClassification as { classification?: string; reason?: string; deferred?: boolean }
      : null;
  if (noOpClassification?.classification) {
    lines.push(`NOOP: ${noOpClassification.classification}`);
    if (typeof noOpClassification.deferred === "boolean") {
      lines.push(`DEFERRED: ${noOpClassification.deferred ? "YES" : "NO"}`);
    }
    if (noOpClassification.reason) {
      lines.push(`NOOP_REASON: ${noOpClassification.reason}`);
    }
  }

  const contextStats =
    payload.retrievedContextStats && typeof payload.retrievedContextStats === "object"
      ? payload.retrievedContextStats as {
        tokenEstimate?: number;
        tokenBudget?: number;
        selectedCardIds?: unknown[];
      }
      : null;
  if (contextStats) {
    if (typeof contextStats.tokenEstimate === "number" && typeof contextStats.tokenBudget === "number") {
      lines.push(`CTX_TOKENS: ${contextStats.tokenEstimate}/${contextStats.tokenBudget}`);
    }
    const selectedCards = Array.isArray(contextStats.selectedCardIds) ? contextStats.selectedCardIds.length : 0;
    if (selectedCards > 0) {
      lines.push(`CTX_MEMORY_CARDS: ${selectedCards}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "";
}

export function SandboxAgentPanel({
  projectName,
  messages,
  currentRun,
  runHistory,
  steps,
  snapshots,
  isRunning,
  error,
  onSendMessage,
  onRestoreSnapshot,
}: SandboxAgentPanelProps) {
  const [inputValue, setInputValue] = React.useState("");
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [expandedStepId, setExpandedStepId] = React.useState<string | null>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (expandedStepId && !steps.some((step) => step.id === expandedStepId)) {
      setExpandedStepId(null);
    }
  }, [expandedStepId, steps]);

  // Auto-scroll to bottom when messages or steps change
  React.useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [messages, steps, isRunning]);

  const messageById = React.useMemo(() => {
    return new Map(messages.map((message) => [message.id, message]));
  }, [messages]);

  const summarizedRuns = React.useMemo(() => {
    const merged = [...runHistory];
    if (currentRun && !merged.some((run) => run.id === currentRun.id)) {
      merged.unshift(currentRun);
    }

    return merged
      .filter((run) => !(isRunning && currentRun && run.id === currentRun.id))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 8);
  }, [currentRun, isRunning, runHistory]);

  const handleSend = async () => {
    if (!inputValue.trim() || isSubmitting || isRunning) {
      return;
    }

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
    <div className="flex flex-col h-full bg-[#0B0B0F]/80 backdrop-blur-xl border-r border-white/10 w-[360px] relative overflow-hidden">
      {/* Background Texture Accents */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />

      {/* Header */}
      <div className="relative flex items-center justify-between px-4 py-4 border-b border-white/10 bg-white/5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border border-white/10 flex items-center justify-center overflow-hidden">
              <Bot className="w-5 h-5 text-cyan-400" />
              <motion.div
                animate={{ opacity: [0.3, 0.6, 0.3] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="absolute inset-0 bg-gradient-to-t from-cyan-500/10 to-transparent"
              />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-[#0B0B0F] flex items-center justify-center border border-white/10">
              <div className={cn("w-1.5 h-1.5 rounded-full", isRunning ? "bg-cyan-400 animate-pulse" : "bg-emerald-500")} />
            </div>
          </div>

          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[#E6E6EB] truncate tracking-tight">{projectName}</h2>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-mono text-cyan-500/80 uppercase tracking-widest">System Active</span>
              <span className="w-1 h-1 rounded-full bg-cyan-500/40" />
              <span className="text-[10px] font-mono text-white/40 uppercase tracking-widest">v2.4.0</span>
            </div>
          </div>
        </div>
      </div>

      {/* Snapshots Bar - Collapsed/Minimal */}
      {snapshots.length > 0 && (
        <div className="px-4 py-2 border-b border-white/5 bg-black/20 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="text-[10px] font-mono text-white/30 uppercase flex-shrink-0">Snapshots:</span>
          <div className="flex gap-1.5">
            {snapshots.slice(0, 5).map((snapshot) => (
              <button
                key={snapshot.id}
                onClick={() => void onRestoreSnapshot(snapshot.id)}
                title={snapshot.summary || "Restore point"}
                className="px-2 py-0.5 rounded border border-white/5 bg-white/5 text-[10px] text-white/60 hover:text-cyan-400 hover:border-cyan-500/30 transition-all font-mono whitespace-nowrap"
              >
                {formatTimestamp(snapshot.createdAt)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main Feed */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto px-4 py-6 space-y-6 scroll-smooth scrollbar-tactical"
      >
        <AnimatePresence initial={false}>
          {messages.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-col items-center justify-center h-48 text-center"
            >
              <div className="w-12 h-12 rounded-full border border-dashed border-white/10 flex items-center justify-center mb-4">
                <Send className="w-5 h-5 text-white/20" />
              </div>
              <p className="text-xs text-white/30 font-mono tracking-wide">AWAITING INPUT COMMAND</p>
            </motion.div>
          ) : (
            messages.map((message, idx) => (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, x: message.role === "user" ? 10 : -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx === messages.length - 1 ? 0 : 0 }}
                className={cn(
                  "group relative flex flex-col max-w-[90%]",
                  message.role === "user" ? "ml-auto items-end" : "mr-auto items-start"
                )}
              >
                {/* Status Label */}
                <div className={cn(
                  "flex items-center gap-2 mb-1.5 px-1",
                  message.role === "user" ? "flex-row-reverse" : "flex-row"
                )}>
                  <span className={cn(
                    "text-[9px] font-mono uppercase tracking-[0.2em]",
                    message.role === "user" ? "text-purple-400/80" : "text-cyan-400/80"
                  )}>
                    {message.role === "user" ? "AUTHORIZED_USER" : "SYSTEM_CORE"}
                  </span>
                  <span className="text-[9px] font-mono text-white/20">
                    {formatTimestamp(message.createdAt)}
                  </span>
                </div>

                {/* Bubble Content */}
                <div className={cn(
                  "relative px-4 py-3 rounded-2xl text-[13px] leading-relaxed shadow-lg transition-all border",
                  message.role === "user"
                    ? "bg-purple-600/10 border-purple-500/30 text-purple-50 rounded-tr-none hover:border-purple-500/50"
                    : "bg-white/5 border-white/10 text-white/90 rounded-tl-none hover:border-white/20"
                )}>
                  {/* Decorative Corner Accents for Agent */}
                  {message.role !== "user" && (
                    <>
                      <div className="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l border-cyan-500/50 rounded-tl-none" />
                      <div className="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r border-white/20" />
                    </>
                  )}

                  <p className="whitespace-pre-wrap break-words">
                    {message.content}
                  </p>

                  {/* Glow Effect */}
                  <div className={cn(
                    "absolute -inset-px rounded-2xl -z-10 blur-md opacity-20 pointer-events-none transition-opacity group-hover:opacity-40",
                    message.role === "user" ? "bg-purple-500" : "bg-cyan-500"
                  )} />
                </div>
              </motion.div>
            ))
          )}
        </AnimatePresence>

        {/* Past Runs — concise view only */}
        {summarizedRuns.length > 0 && (
          <div className="space-y-2.5 pt-4 border-t border-white/5">
            <div className="flex items-center gap-2 px-1">
              <div className="w-1 h-1 rounded-full bg-white/30" />
              <p className="text-[10px] font-mono uppercase tracking-widest text-white/35">Recent Executions</p>
            </div>

            <div className="space-y-1.5">
              {summarizedRuns.map((run) => {
                const prompt = messageById.get(run.trigger_message_id)?.content ?? "Execution run";
                const statusLabel = formatRunStatus(run.status);
                const detail = summarizeRunDetail(run);
                const statusTone =
                  run.status === "completed"
                    ? "text-emerald-300 border-emerald-500/20 bg-emerald-500/10"
                    : run.status === "failed"
                      ? "text-red-300 border-red-500/20 bg-red-500/10"
                      : run.status === "cancelled"
                        ? "text-amber-300 border-amber-500/20 bg-amber-500/10"
                        : "text-cyan-300 border-cyan-500/20 bg-cyan-500/10";

                return (
                  <div
                    key={run.id}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5"
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <p className="min-w-0 flex-1 truncate text-[11px] text-white/85">
                        {summarizeRunLabel(prompt)}
                      </p>
                      <span
                        className={cn(
                          "flex-shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wide border",
                          statusTone
                        )}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[9px] font-mono text-white/35">
                      <span>{formatTimestamp(run.created_at)}</span>
                      {formatRunDuration(run) && <span>· {formatRunDuration(run)}</span>}
                    </div>
                    <p className="mt-1 truncate text-[10px] text-white/50">{detail}</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Active Run — detailed live view */}
        {isRunning && (
          <div className="space-y-3 pt-4 border-t border-white/5">
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <div className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
                <p className="text-[10px] font-mono uppercase tracking-widest text-cyan-300/80">Current Execution</p>
              </div>
              <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20">
                <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                <span className="text-[9px] font-mono text-cyan-400 uppercase tracking-wider">Processing</span>
              </div>
            </div>

            <div className="space-y-1.5">
              {steps.length === 0 && (
                <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                  <p className="text-[11px] text-white/55">Preparing run steps...</p>
                </div>
              )}
              {steps.map((step) => {
                const isExpanded = expandedStepId === step.id;
                const statusConfigs = {
                  running: { color: "text-purple-400", led: "bg-purple-400", border: "border-purple-500/20", bg: "bg-purple-500/5" },
                  complete: { color: "text-emerald-400", led: "bg-emerald-500", border: "border-emerald-500/10", bg: "bg-black/20" },
                  error: { color: "text-red-400", led: "bg-red-500", border: "border-red-500/20", bg: "bg-red-500/5" },
                  pending: { color: "text-white/30", led: "bg-white/20", border: "border-white/5", bg: "transparent" }
                };

                const status = (step.status as keyof typeof statusConfigs) || "pending";
                const config = statusConfigs[status] || statusConfigs.pending;

                return (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "group rounded-lg border transition-all duration-300",
                      config.border,
                      config.bg,
                      isExpanded && "ring-1 ring-white/5 shadow-xl"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setExpandedStepId(curr => curr === step.id ? null : step.id)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left"
                    >
                      <div className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0 shadow-[0_0_8px_rgba(255,255,255,0.2)]", config.led, step.status === 'running' && "animate-pulse")} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className={cn("min-w-0 flex-1 text-[11px] font-medium truncate tracking-tight transition-colors", config.color)}>
                            {step.title}
                          </p>
                          <span className="flex-shrink-0 whitespace-nowrap pr-0.5 text-[9px] font-mono text-white/20 group-hover:text-white/40 transition-colors">
                            {isExpanded ? "[ CLOSE ]" : "[ INFO ]"}
                          </span>
                        </div>
                      </div>
                    </button>

                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="px-3 pb-3 border-t border-white/5 pt-2">
                            <div className="bg-black/30 rounded p-2.5 border border-white/5">
                              <p className="text-[11px] font-mono text-white/50 leading-relaxed whitespace-pre-wrap overflow-hidden">
                                {`> EXECUTE_DETAIL:\n${step.detail || 'Accessing sequence metadata...'}${(() => {
                                  const telemetry = stringifyStepTelemetry(step);
                                  return telemetry ? `\n\n> TELEMETRY:\n${telemetry}` : "";
                                })()}`}
                              </p>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })}
            </div>
          </div>
        )}

      </div>

      {/* Input Section - Tactical Command Style */}
      <div className="relative border-t border-white/10 p-4 bg-black/40 backdrop-blur-md">
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-3 rounded-lg bg-red-500/10 border border-red-500/20 p-2 text-[11px] text-red-200 flex gap-2"
          >
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            <p className="leading-tight opacity-90">{error}</p>
          </motion.div>
        )}

        <div className="relative group">
          {/* L-Bracket Accents */}
          <div className="absolute -top-1 -left-1 w-4 h-4 border-t border-l border-white/10 transition-colors group-focus-within:border-purple-500/40" />
          <div className="absolute -bottom-1 -right-1 w-4 h-4 border-b border-r border-white/10 transition-colors group-focus-within:border-purple-500/40" />

          <div className="relative rounded-lg bg-[#0B0B0F] border border-white/10 focus-within:ring-2 focus-within:ring-purple-500/10 focus-within:border-purple-500/30 overflow-hidden transition-all shadow-[0_4px_20px_rgba(0,0,0,0.5)]">
            <textarea
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              disabled={isSubmitting || isRunning}
              placeholder="INPUT COMMAND..."
              className="w-full bg-transparent border-none outline-none resize-none min-h-[100px] p-3 text-[13px] text-[#E6E6EB] placeholder:text-white/20 font-mono focus:ring-0"
            />

            <div className="flex items-center justify-between px-3 pb-3">
              <div className="flex gap-1">
                <div className="w-1 h-1 rounded-full bg-white/20" />
                <div className="w-1 h-1 rounded-full bg-white/20" />
                <div className="w-1 h-1 rounded-full bg-white/20" />
              </div>

              <button
                onClick={() => void handleSend()}
                disabled={!inputValue.trim() || isSubmitting || isRunning}
                className={cn(
                  "relative group/btn inline-flex items-center gap-2 pr-4 pl-3 py-1.5 rounded-md text-[11px] font-bold uppercase tracking-wider transition-all overflow-hidden border",
                  !inputValue.trim() || isSubmitting || isRunning
                    ? "bg-white/5 border-white/5 text-white/20 cursor-not-allowed"
                    : "bg-purple-600 border-purple-400/50 text-white shadow-[0_0_15px_rgba(168,85,247,0.3)] hover:shadow-[0_0_20px_rgba(168,85,247,0.5)]"
                )}
              >
                <AnimatePresence mode="wait">
                  {isSubmitting || isRunning ? (
                    <motion.div
                      key="loader"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="send"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                    >
                      <Send className="w-3 h-3 group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5 transition-transform" />
                    </motion.div>
                  )}
                </AnimatePresence>
                <span>{isRunning ? "PROCESS" : "TRANSMIT"}</span>

                {/* Hover light beam effect */}
                {!(!inputValue.trim() || isSubmitting || isRunning) && (
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover/btn:translate-x-full transition-transform duration-700" />
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Panel Footer Footer */}
        <div className="mt-4 flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            <div className="w-1 h-1 rounded-full bg-emerald-500 shadow-[0_0_5px_rgba(16,185,129,0.8)]" />
            <span className="text-[10px] font-mono text-white/30 uppercase tracking-widest">Quantum Encryption Active</span>
          </div>
        </div>
      </div>
    </div>
  );
}
