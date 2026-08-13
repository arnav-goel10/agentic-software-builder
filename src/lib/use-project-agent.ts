"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GeneratedFile,
  ParsedMessage,
  ParsedRunArtifact,
  ParsedRunStep,
  RunRow,
} from "@/lib/server/types";

type ProjectRecord = {
  id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  current_snapshot_id: string | null;
  created_at: number;
  updated_at: number;
};

type ThreadRecord = {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
};

type SnapshotMeta = {
  id: string;
  projectId: string;
  runId: string;
  parentSnapshotId: string | null;
  summary: string;
  fileCount: number;
  createdAt: number;
};

type ProjectListItem = {
  project: ProjectRecord;
  currentSnapshot: {
    id: string;
    projectId: string;
    runId: string;
    parentSnapshotId: string | null;
    summary: string;
    files: GeneratedFile[];
    createdAt: number;
  } | null;
  latestRun: RunRow | null;
};

type ProjectDetailsResponse = {
  project: ProjectRecord;
  thread: ThreadRecord;
  currentSnapshot: {
    id: string;
    projectId: string;
    runId: string;
    parentSnapshotId: string | null;
    summary: string;
    files: GeneratedFile[];
    createdAt: number;
  } | null;
  latestRun: RunRow | null;
};

type MessagesResponse = {
  thread: ThreadRecord;
  messages: ParsedMessage[];
};

type RunsResponse = {
  run: RunRow;
  steps: ParsedRunStep[];
  artifacts: ParsedRunArtifact[];
};

type RunsListResponse = {
  runs: RunRow[];
};

type SnapshotsResponse = {
  snapshots: SnapshotMeta[];
};



type UseProjectAgentInput = {
  initialProjectId?: string | null;
};


const ACTIVE_RUN_STATUSES = new Set(["queued", "planning", "executing", "validating", "repairing"]);
const MAX_UI_ERROR_LENGTH = 280;

function isActiveRunStatus(status: string | undefined): boolean {
  if (!status) return false;
  return ACTIVE_RUN_STATUSES.has(status);
}

function deriveProjectName(prompt: string): string {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "Untitled Project";
  }

  const short = cleaned.length > 48 ? `${cleaned.slice(0, 48).trim()}...` : cleaned;
  return short;
}

function compactUiError(raw: string): string {
  const flattened = raw.replace(/\s+/g, " ").trim();
  if (!flattened) {
    return "Something went wrong. Please retry.";
  }
  if (flattened.length <= MAX_UI_ERROR_LENGTH) {
    return flattened;
  }
  return `${flattened.slice(0, MAX_UI_ERROR_LENGTH)}...`;
}

function toUiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Unknown error");
  const normalized = raw.toLowerCase();

  if (
    normalized.includes("resource_exhausted") ||
    normalized.includes("quota") ||
    normalized.includes("rate limit") ||
    normalized.includes("429")
  ) {
    return "API quota exceeded. Check your plan/rate limits and try again.";
  }

  if (
    normalized.includes("unauthenticated") ||
    normalized.includes("permission denied") ||
    normalized.includes("api key")
  ) {
    return "Model authentication failed. Verify your provider API keys and model access.";
  }

  if (normalized.includes("active run")) {
    return "A run is already active for this project. Wait for it to finish or open another project.";
  }

  if (normalized.includes("timeout") || normalized.includes("deadline")) {
    return "Request timed out. Please retry.";
  }

  return compactUiError(raw);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: string; details?: string }
    | null;

  if (!response.ok) {
    const message = payload?.error ?? `Request failed: ${response.status}`;
    const details = payload?.details ? ` ${payload.details}` : "";
    throw new Error(toUiError(`${message}${details}`));
  }

  return payload as T;
}

export function useProjectAgent({ initialProjectId }: UseProjectAgentInput = {}) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [activeProject, setActiveProject] = useState<ProjectRecord | null>(null);
  const [activeThread, setActiveThread] = useState<ThreadRecord | null>(null);
  const [messages, setMessages] = useState<ParsedMessage[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [currentFiles, setCurrentFiles] = useState<GeneratedFile[]>([]);
  const [currentRun, setCurrentRun] = useState<RunRow | null>(null);
  const [runHistory, setRunHistory] = useState<RunRow[]>([]);
  const [steps, setSteps] = useState<ParsedRunStep[]>([]);
  const [artifacts, setArtifacts] = useState<ParsedRunArtifact[]>([]);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const [error, setError] = useState<string>("");

  const eventSourceRef = useRef<EventSource | null>(null);
  const isRunningRef = useRef(false);

  useEffect(() => {
    isRunningRef.current = isRunning;
  }, [isRunning]);

  const closeStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await fetchJson<{ projects: ProjectListItem[] }>("/api/projects");
    setProjects(data.projects);
    return data.projects;
  }, []);

  const upsertRunHistory = useCallback((run: RunRow) => {
    setRunHistory((prev) => {
      const next = [...prev];
      const index = next.findIndex((item) => item.id === run.id);
      if (index >= 0) {
        next[index] = run;
      } else {
        next.unshift(run);
      }
      next.sort((a, b) => b.created_at - a.created_at);
      return next;
    });
  }, []);

  const refreshRun = useCallback(async (projectId: string, runId: string) => {
    const data = await fetchJson<RunsResponse>(`/api/projects/${projectId}/runs/${runId}`);
    setCurrentRun(data.run);
    upsertRunHistory(data.run);
    setSteps(data.steps);
    setArtifacts(data.artifacts ?? []);
    setIsRunning(isActiveRunStatus(data.run.status));
    return data;
  }, [upsertRunHistory]);

  const refreshRuns = useCallback(async (projectId: string) => {
    const data = await fetchJson<RunsListResponse>(`/api/projects/${projectId}/runs`);
    setRunHistory(data.runs);
    return data.runs;
  }, []);

  const refreshSnapshots = useCallback(async (projectId: string) => {
    const data = await fetchJson<SnapshotsResponse>(`/api/projects/${projectId}/snapshots`);
    setSnapshots(data.snapshots);
    return data.snapshots;
  }, []);

  const refreshMessages = useCallback(async (projectId: string) => {
    const data = await fetchJson<MessagesResponse>(`/api/projects/${projectId}/messages`);
    setActiveThread(data.thread);
    setMessages(data.messages);
    return data;
  }, []);

  const refreshProjectData = useCallback(
    async (projectId: string) => {
      const details = await fetchJson<ProjectDetailsResponse>(`/api/projects/${projectId}`);
      setActiveProject(details.project);
      setActiveThread(details.thread);
      setCurrentFiles(details.currentSnapshot?.files ?? []);
      setCurrentRun(details.latestRun);
      await Promise.all([
        refreshMessages(projectId),
        refreshSnapshots(projectId),
        refreshRuns(projectId),
        loadProjects(),
      ]);
      if (details.latestRun) {
        await refreshRun(projectId, details.latestRun.id);
      } else {
        setSteps([]);
        setArtifacts([]);
        setIsRunning(false);
      }
    },
    [loadProjects, refreshMessages, refreshRun, refreshRuns, refreshSnapshots]
  );

  const connectRunStream = useCallback(
    (projectId: string, runId: string) => {
      closeStream();
      let reconnectAttempts = 0;
      const MAX_RECONNECT_ATTEMPTS = 5;

      const connect = () => {
        const stream = new EventSource(`/api/projects/${projectId}/runs/${runId}/stream`);
        eventSourceRef.current = stream;
        setIsRunning(true);

        type StreamOperation = {
          op: "upsert" | "delete" | "json_manifest_update";
          path: string;
          code?: string;
          language?: string;
        };

        const applyStreamOperations = (rawOperations: unknown) => {
          if (!Array.isArray(rawOperations) || rawOperations.length === 0) {
            return;
          }
          const operations = rawOperations as StreamOperation[];
          setCurrentFiles((prevFiles) => {
            const finalMap = new Map(prevFiles.map((file) => [file.name, file]));
            for (const operation of operations) {
              if (
                operation.op === "upsert" &&
                typeof operation.path === "string" &&
                typeof operation.code === "string"
              ) {
                finalMap.set(operation.path, {
                  name: operation.path,
                  code: operation.code,
                  language: operation.language,
                });
                continue;
              }
              if (operation.op === "delete" && typeof operation.path === "string") {
                finalMap.delete(operation.path);
              }
            }
            return Array.from(finalMap.values());
          });
        };

        // Incremental state merge for step events — avoids full refetch
        const mergeStep = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data?.step) {
              setSteps((prev) => {
                const idx = prev.findIndex((s) => s.id === data.step.id);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = data.step;
                  return next;
                }
                return [...prev, data.step];
              });
            }
            // Update run status from event payload
            if (data?.run) {
              setCurrentRun(data.run);
              upsertRunHistory(data.run);
            }
            applyStreamOperations(data?.operations);
          } catch {
            // Fallback: full refresh if parse fails
            void refreshRun(projectId, runId).catch(() => undefined);
          }
        };

        // Lightweight handlers that merge state locally
        stream.addEventListener("run_snapshot", mergeStep);
        stream.addEventListener("run_started", mergeStep);
        stream.addEventListener("step", mergeStep);
        stream.addEventListener("coder_started", mergeStep);
        stream.addEventListener("run_heartbeat", (event) => {
          try {
            const data = JSON.parse(event.data) as { phase?: string; taskId?: string };
            if (data?.phase) {
              setCurrentRun((prev) => {
                if (!prev) return prev;
                if (!isActiveRunStatus(prev.status)) {
                  return { ...prev, status: "executing" };
                }
                return prev;
              });
            }
          } catch {
            // no-op
          }
        });
        stream.addEventListener("phase_timeout", (event) => {
          try {
            const data = JSON.parse(event.data) as {
              phase?: string;
              model?: string;
              detail?: string;
            };
            const phaseLabel = data.phase ? `phase ${data.phase}` : "a model phase";
            const modelLabel = data.model ? ` (${data.model})` : "";
            const detail = data.detail ? ` ${data.detail}` : "";
            setError(
              compactUiError(
                `Model timeout detected in ${phaseLabel}${modelLabel}.${detail}`
              )
            );
          } catch {
            setError("Model timeout detected; retrying with fallback.");
          }
        });
        stream.addEventListener("preview_ready", () => {
          // Reserved for future server-side preview orchestration.
        });
        stream.addEventListener("preview_reused", () => {
          // Reserved for future server-side preview orchestration.
        });
        stream.addEventListener("spec_progress", (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.requirements) {
              setSteps((prev) => {
                const idx = prev.findIndex((s) => s.phase === "spec");
                if (idx >= 0) {
                  const next = [...prev];
                  const count = data.requirements.length;
                  next[idx] = {
                    ...next[idx],
                    detail: `Deriving ${count} requirement${count === 1 ? "" : "s"}...`
                  };
                  return next;
                }
                return prev;
              });
            }
          } catch { }
        });
        stream.addEventListener("architect_progress", (event) => {
          try {
            const data = JSON.parse(event.data);
            const taskCount = Array.isArray(data.tasks) ? data.tasks.length : 0;
            const nodeCount = Array.isArray(data.nodes) ? data.nodes.length : 0;
            if (taskCount > 0 || nodeCount > 0) {
              setSteps((prev) => {
                const next = [...prev];
                if (taskCount > 0) {
                  const architectIdx = next.findIndex((step) => step.phase === "architect" && step.status === "running");
                  if (architectIdx >= 0) {
                    const label = next[architectIdx].title.toLowerCase().includes("outline")
                      ? "Plan outline"
                      : "Architect";
                    next[architectIdx] = {
                      ...next[architectIdx],
                      detail: `${label}: ${taskCount} task${taskCount === 1 ? "" : "s"} drafted...`,
                    };
                  }
                }
                if (nodeCount > 0) {
                  const scaffoldIdx = next.findIndex(
                    (step) =>
                      step.phase === "scaffold" &&
                      step.status === "running" &&
                      /skeleton dag/i.test(step.title)
                  );
                  if (scaffoldIdx >= 0) {
                    next[scaffoldIdx] = {
                      ...next[scaffoldIdx],
                      detail: `Skeleton DAG: ${nodeCount} node${nodeCount === 1 ? "" : "s"} drafted...`,
                    };
                  }
                }
                return next;
              });
            }
          } catch { }
        });
        stream.addEventListener("qa_progress", (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.acceptance || data.score !== undefined || data.hardBlockers || data.softBlockers) {
              setSteps((prev) => {
                const idx = prev.findIndex((s) => s.phase === "qa");
                if (idx >= 0) {
                  const next = [...prev];
                  const count = data.acceptance?.length ?? 0;
                  const hardCount = Array.isArray(data.hardBlockers) ? data.hardBlockers.length : 0;
                  const softCount = Array.isArray(data.softBlockers) ? data.softBlockers.length : 0;
                  const scorePrefix = data.score !== undefined ? `[Score: ${data.score}] ` : "";
                  next[idx] = {
                    ...next[idx],
                    detail: `${scorePrefix}Evaluating ${count} acceptance criteria · hard=${hardCount} soft=${softCount}...`
                  };
                  return next;
                }
                return prev;
              });
            }
          } catch { }
        });
        stream.addEventListener("coder_progress", (event) => {
          try {
            const data = JSON.parse(event.data);
            if (data.taskId && data.operations) {
              applyStreamOperations(data.operations);

              setSteps((prev) => {
                const next = [...prev];
                const total = data.operations.length;
                const recentOps = data.operations.slice(-3) as Array<{ path?: unknown }>;
                const paths = recentOps
                  .map((op) => (typeof op.path === "string" && op.path ? op.path : "(unknown)"))
                  .join(", ");

                if (typeof data.taskId === "string" && data.taskId.startsWith("skeleton-tier-")) {
                  const scaffoldIdx = next.findIndex(
                    (step) =>
                      step.phase === "scaffold" &&
                      step.status === "running" &&
                      /generate skeleton files/i.test(step.title)
                  );
                  if (scaffoldIdx >= 0) {
                    next[scaffoldIdx] = {
                      ...next[scaffoldIdx],
                      detail: `Skeleton generation (${data.taskId}): ${total} update${total === 1 ? "" : "s"} · ${paths}...`,
                    };
                    return next;
                  }
                }

                if (typeof data.taskId === "string" && data.taskId.startsWith("fill-")) {
                  const fillIdx = next.findIndex(
                    (step) => step.phase === "coder" && step.status === "running"
                  );
                  if (fillIdx >= 0) {
                    next[fillIdx] = {
                      ...next[fillIdx],
                      detail: `Fill parallel: ${total} update${total === 1 ? "" : "s"} · ${paths}...`,
                    };
                    return next;
                  }
                }

                if (typeof data.taskId === "string" && /^fix[-_]/i.test(data.taskId)) {
                  const fixIdx = next.findIndex(
                    (step) => step.phase === "repair" && step.status === "running"
                  );
                  if (fixIdx >= 0) {
                    next[fixIdx] = {
                      ...next[fixIdx],
                      detail: `Fix DAG: ${total} operation${total === 1 ? "" : "s"} · ${paths}...`,
                    };
                    return next;
                  }
                }

                const coderIdx = next.findIndex((step) => step.phase === "coder" && step.status === "running");
                if (coderIdx >= 0) {
                  next[coderIdx] = {
                    ...next[coderIdx],
                    detail: `Coder progress: ${total} operation${total === 1 ? "" : "s"} · ${paths}...`,
                  };
                }
                return next;
              });
            }
          } catch { }
        });
        stream.addEventListener("coder_completed", mergeStep);
        stream.addEventListener("coder_noop_classified", (event) => {
          try {
            const data = JSON.parse(event.data) as {
              taskId?: string;
              detail?: string;
            };
            if (!data.taskId) return;
            setSteps((prev) => {
              const idx = prev.findIndex((step) => step.payload?.taskId === data.taskId && step.phase === "coder");
              if (idx < 0) return prev;
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                detail: data.detail
                  ? `${next[idx].detail}\n${data.detail}`
                  : next[idx].detail,
              };
              return next;
            });
          } catch {
            // no-op
          }
        });
        stream.addEventListener("coder_deferred", (event) => {
          try {
            const data = JSON.parse(event.data) as {
              taskId?: string;
              detail?: string;
            };
            if (!data.taskId) return;
            setSteps((prev) => {
              const idx = prev.findIndex((step) => step.payload?.taskId === data.taskId && step.phase === "coder");
              if (idx < 0) return prev;
              const next = [...prev];
              next[idx] = {
                ...next[idx],
                detail: data.detail
                  ? `${next[idx].detail}\nDeferred: ${data.detail}`
                  : `${next[idx].detail}\nDeferred to later repair/QA.`,
              };
              return next;
            });
          } catch {
            // no-op
          }
        });
        stream.addEventListener("context_compacted", (event) => {
          try {
            const data = JSON.parse(event.data) as {
              detail?: string;
            };
            const detail = data?.detail;
            if (detail) {
              setError((prev) => (prev ? prev : compactUiError(detail)));
            }
          } catch {
            // no-op
          }
        });
        stream.addEventListener("memory_cards_updated", () => {
          // Reserved for memory activity indicators (future UI surface).
        });
        stream.addEventListener("validation_failed", mergeStep);
        stream.addEventListener("repair_started", mergeStep);

        // Terminal events — do a single full refresh for files/messages
        stream.addEventListener("run_completed", () => {
          setIsRunning(false);
          closeStream();
          void refreshProjectData(projectId);
        });

        stream.addEventListener("run_failed", (event) => {
          setIsRunning(false);
          try {
            const data = JSON.parse(event.data);
            if (data?.run) setCurrentRun(data.run);
            if (data?.error) setError(compactUiError(data.error));
          } catch {
            // ignore parse errors
          }
          closeStream();
          void refreshProjectData(projectId);
        });

        // Auto-reconnect with exponential backoff
        stream.onerror = () => {
          stream.close();
          eventSourceRef.current = null;

          if (!isRunningRef.current) return;

          // Before retrying, verify the run still exists and is active.
          // If the run was deleted (404) or failed, this will throw or return a non-active status.
          refreshRun(projectId, runId)
            .then((runData) => {
              if (isActiveRunStatus(runData.run.status) && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
                reconnectAttempts++;
                setTimeout(() => {
                  if (isRunningRef.current) {
                    connect();
                  }
                }, delay);
              } else {
                // Run is finished or invalid — stop retrying
                setIsRunning(false);
                closeStream();
              }
            })
            .catch(() => {
              // Run fetch failed (e.g. 404 Not Found) — stop retrying
              setIsRunning(false);
              closeStream();
            });
        };

        // Reset reconnect counter on successful connection
        stream.onopen = () => {
          reconnectAttempts = 0;
        };
      };

      connect();
    },
    [closeStream, refreshProjectData, refreshRun, upsertRunHistory]
  );

  const openProject = useCallback(
    async (projectId: string) => {
      setError("");
      setIsLoadingProject(true);
      try {
        const details = await fetchJson<ProjectDetailsResponse>(`/api/projects/${projectId}`);
        setActiveProject(details.project);
        setActiveThread(details.thread);
        setCurrentFiles(details.currentSnapshot?.files ?? []);
        setCurrentRun(details.latestRun);
        setIsRunning(isActiveRunStatus(details.latestRun?.status));

        await Promise.all([
          refreshMessages(projectId),
          refreshSnapshots(projectId),
          refreshRuns(projectId),
          loadProjects(),
        ]);

        if (details.latestRun) {
          try {
            await refreshRun(projectId, details.latestRun.id);
            if (isActiveRunStatus(details.latestRun.status)) {
              connectRunStream(projectId, details.latestRun.id);
            } else {
              closeStream();
            }
          } catch (err) {
            console.warn("Failed to load latest run (orphan reference?):", err);
            // If the run is missing, clear it from the UI state so we don't try to reuse it
            setCurrentRun(null);
            setRunHistory((prev) => prev.filter((run) => run.id !== details.latestRun?.id));
            setSteps([]);
            setArtifacts([]);
            closeStream();
          }
        } else {
          setSteps([]);
          setArtifacts([]);
          closeStream();
        }
      } finally {
        setIsLoadingProject(false);
      }
    },
    [
      closeStream,
      connectRunStream,
      loadProjects,
      refreshMessages,
      refreshRun,
      refreshRuns,
      refreshSnapshots,
    ]
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!activeProject || !activeThread) {
        const message = "Select or create a project first";
        setError(message);
        throw new Error(message);
      }

      setError("");

      try {
        const created = await fetchJson<{ message: ParsedMessage; threadId: string }>(
          `/api/projects/${activeProject.id}/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              content,
              threadId: activeThread.id,
            }),
          }
        );

        setMessages((prev) => [...prev, created.message]);

        const run = await fetchJson<{ runId: string }>(`/api/projects/${activeProject.id}/runs`, {
          method: "POST",
          body: JSON.stringify({
            threadId: activeThread.id,
            messageId: created.message.id,
          }),
        });

        setCurrentRun({
          id: run.runId,
          project_id: activeProject.id,
          thread_id: activeThread.id,
          trigger_message_id: created.message.id,
          status: "queued",
          model: "",
          error: null,
          created_at: Date.now(),
          started_at: null,
          finished_at: null,
        });
        upsertRunHistory({
          id: run.runId,
          project_id: activeProject.id,
          thread_id: activeThread.id,
          trigger_message_id: created.message.id,
          status: "queued",
          model: "",
          error: null,
          created_at: Date.now(),
          started_at: null,
          finished_at: null,
        });
        setSteps([]);
        setArtifacts([]);
        connectRunStream(activeProject.id, run.runId);
      } catch (runError) {
        const message = toUiError(runError);
        setError(message);
        throw runError;
      }
    },
    [activeProject, activeThread, connectRunStream, upsertRunHistory]
  );

  const restoreSnapshot = useCallback(
    async (snapshotId: string) => {
      if (!activeProject) {
        throw new Error("No active project selected");
      }

      await fetchJson<{ project: ProjectRecord; currentSnapshot: { files: GeneratedFile[] } | null }>(
        `/api/projects/${activeProject.id}/snapshots/${snapshotId}/restore`,
        {
          method: "POST",
        }
      );

      await refreshProjectData(activeProject.id);
    },
    [activeProject, refreshProjectData]
  );



  const createProjectFromPrompt = useCallback(
    async (prompt: string) => {
      const created = await fetchJson<{ project: ProjectRecord; thread: ThreadRecord }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          name: deriveProjectName(prompt),
        }),
      });

      const message = await fetchJson<{ message: ParsedMessage; threadId: string }>(
        `/api/projects/${created.project.id}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            threadId: created.thread.id,
            content: prompt,
          }),
        }
      );

      const run = await fetchJson<{ runId: string }>(`/api/projects/${created.project.id}/runs`, {
        method: "POST",
        body: JSON.stringify({
          threadId: created.thread.id,
          messageId: message.message.id,
        }),
      });

      await loadProjects();

      return {
        projectId: created.project.id,
        threadId: created.thread.id,
        runId: run.runId,
      };
    },
    [loadProjects]
  );

  useEffect(() => {
    void loadProjects().catch((err) => {
      setError(toUiError(err));
    });
  }, [loadProjects]);

  useEffect(() => {
    if (!initialProjectId) {
      return;
    }

    void openProject(initialProjectId).catch((err) => {
      setError(toUiError(err));
    });
  }, [initialProjectId, openProject]);

  useEffect(() => {
    return () => {
      closeStream();
    };
  }, [closeStream]);

  const hasProject = useMemo(() => Boolean(activeProject), [activeProject]);

  return {
    projects,
    activeProject,
    activeThread,
    messages,
    snapshots,
    currentFiles,
    currentRun,
    runHistory,
    steps,
    artifacts,
    isLoadingProject,
    isRunning,
    error,
    hasProject,
    loadProjects,
    openProject,
    sendMessage,
    restoreSnapshot,
    createProjectFromPrompt,
    refreshProjectData,
  };
}
