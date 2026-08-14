"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { PromptComposer } from "@/components/prompt-composer";
import { ProjectCard } from "@/components/project-card";
import { toProjectView, type ApiProjectItem, type ProjectView } from "@/lib/project-view";

export default function HomePage() {
  const router = useRouter();
  const [error, setError] = React.useState("");
  const [recentProjects, setRecentProjects] = React.useState<ProjectView[]>([]);
  const [recentProjectsError, setRecentProjectsError] = React.useState("");
  const [isRecentProjectsLoading, setIsRecentProjectsLoading] = React.useState(true);
  const [deletingProjectId, setDeletingProjectId] = React.useState<string | null>(null);
  const [isMockProvider, setIsMockProvider] = React.useState(false);

  const loadRecentProjects = React.useCallback(async () => {
    setIsRecentProjectsLoading(true);
    setRecentProjectsError("");
    try {
      const response = await fetch("/api/projects");
      const data = (await response.json()) as { projects?: ApiProjectItem[]; error?: string };
      if (!response.ok || !data.projects) {
        throw new Error(data.error ?? "Failed to load recent projects");
      }
      setRecentProjects(data.projects.slice(0, 6).map(toProjectView));
    } catch (loadError) {
      setRecentProjectsError(
        loadError instanceof Error ? loadError.message : "Failed to load recent projects"
      );
      setRecentProjects([]);
    } finally {
      setIsRecentProjectsLoading(false);
    }
  }, []);

  const handlePromptSubmit = React.useCallback(
    async (prompt: string) => {
      setError("");

      const projectName = prompt.trim().slice(0, 48) || "Untitled Project";
      const createdProjectResponse = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }),
      });
      const createdProjectData = (await createdProjectResponse.json()) as {
        project?: { id: string };
        thread?: { id: string };
        error?: string;
      };

      if (!createdProjectResponse.ok || !createdProjectData.project || !createdProjectData.thread) {
        throw new Error(createdProjectData.error ?? "Failed to create project");
      }

      const messageResponse = await fetch(
        `/api/projects/${createdProjectData.project.id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadId: createdProjectData.thread.id,
            content: prompt,
          }),
        }
      );
      const messageData = (await messageResponse.json()) as {
        message?: { id: string };
        error?: string;
      };

      if (!messageResponse.ok || !messageData.message) {
        throw new Error(messageData.error ?? "Failed to create message");
      }

      const runResponse = await fetch(`/api/projects/${createdProjectData.project.id}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: createdProjectData.thread.id,
          messageId: messageData.message.id,
        }),
      });
      const runData = (await runResponse.json()) as { error?: string };

      if (!runResponse.ok) {
        throw new Error(runData.error ?? "Failed to start run");
      }

      router.push(`/sandbox?projectId=${createdProjectData.project.id}`);
    },
    [router]
  );

  const handleDeleteProject = React.useCallback(
    async (projectId: string, projectName: string) => {
      if (deletingProjectId) {
        return;
      }

      const confirmed = window.confirm(`Delete "${projectName}"? This cannot be undone.`);
      if (!confirmed) {
        return;
      }

      setDeletingProjectId(projectId);
      setRecentProjectsError("");

      try {
        const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? "Failed to delete project");
        }

        setRecentProjects((prev) => prev.filter((project) => project.id !== projectId));
      } catch (deleteError) {
        setRecentProjectsError(
          deleteError instanceof Error ? deleteError.message : "Failed to delete project"
        );
      } finally {
        setDeletingProjectId(null);
      }
    },
    [deletingProjectId]
  );

  const onComposerSubmit = React.useCallback(
    async (prompt: string) => {
      try {
        await handlePromptSubmit(prompt);
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Failed to start project build"
        );
      }
    },
    [handlePromptSubmit]
  );

  React.useEffect(() => {
    void loadRecentProjects();
  }, [loadRecentProjects]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/config");
        const data = (await response.json()) as { isMock?: boolean };
        if (!cancelled) {
          setIsMockProvider(Boolean(data.isMock));
        }
      } catch {
        // Config check is best-effort; default to hiding the pill.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#fafafa]">
      <TopBar variant="marketing" />

      <main>
        {/* Hero */}
        <section className="px-6 pt-20 pb-16 sm:pt-28">
          <div className="max-w-3xl mx-auto text-center">
            <motion.h1
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="text-display text-[#1d1d1f] mb-5"
            >
              Describe it. Watch it get built.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.04, ease: [0.16, 1, 0.3, 1] }}
              className="text-[17px] text-[#6e6e73] mb-10 max-w-xl mx-auto leading-relaxed"
            >
              Spec, plan, scaffold, code, validate: every phase gated, every file
              accounted for.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            >
              {isMockProvider ? (
                <div className="mb-4 flex justify-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white px-3 py-1 text-[12px] font-medium text-[#6e6e73] shadow-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#86868b]" />
                    Demo mode — deterministic build
                  </span>
                </div>
              ) : null}

              <PromptComposer size="large" onSubmit={onComposerSubmit} />
              {error ? (
                <p role="alert" className="mt-3 text-sm text-[#d1242f] text-center">
                  {error}
                </p>
              ) : null}
            </motion.div>
          </div>
        </section>

        {/* Recent Builds */}
        <section className="px-6 py-12 pb-24">
          <div className="max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-title text-[#1d1d1f] mb-1">Recent builds</h2>
                <p className="text-[13px] text-[#86868b]">Pick up where you left off</p>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 text-[13px] font-medium text-[#6e6e73] hover:text-[#1d1d1f] transition-colors rounded-[6px]"
                onClick={() => router.push("/projects")}
              >
                View all
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {recentProjectsError ? (
              <div role="alert" className="mb-4 rounded-[12px] border border-[#d1242f]/20 bg-[#d1242f]/5 px-4 py-3 text-sm text-[#d1242f]">
                {recentProjectsError}
              </div>
            ) : null}

            <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
              {isRecentProjectsLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={`recent-skeleton-${i}`}
                    className="w-[280px] h-[160px] rounded-[14px] border border-black/[0.08] bg-white shimmer shrink-0"
                  />
                ))
              ) : recentProjects.length > 0 ? (
                recentProjects.map((project, i) => (
                  <motion.div
                    key={project.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <ProjectCard
                      project={project}
                      onClick={() => router.push(`/sandbox?projectId=${project.id}`)}
                      onDelete={(projectId) => void handleDeleteProject(projectId, project.name)}
                      isDeleting={deletingProjectId === project.id}
                    />
                  </motion.div>
                ))
              ) : (
                <div className="w-full rounded-[14px] border border-dashed border-black/[0.12] bg-white/60 px-6 py-12 text-center">
                  <p className="text-[14px] font-medium text-[#1d1d1f] mb-1">No builds yet</p>
                  <p className="text-[13px] text-[#86868b]">
                    Describe an app above and Dexter will build it for you.
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
