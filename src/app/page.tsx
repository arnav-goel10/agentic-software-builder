"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ChevronRight, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { TopNav } from "@/components/top-nav";
import { PromptComposer } from "@/components/prompt-composer";
import { ProjectCard } from "@/components/project-card";
import { TemplateCard } from "@/components/template-card";
import { templates, type Project } from "@/lib/mock-data";

type ApiProjectItem = {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    updated_at: number;
  };
  latestRun: {
    status: string;
    model: string;
  } | null;
  currentSnapshot: {
    id: string;
    summary: string;
    files: Array<{ name: string }>;
  } | null;
};

const ACTIVE_RUN_STATUSES = new Set(["queued", "planning", "executing", "validating", "repairing"]);

function mapRunStatusToProjectStatus(status: string | undefined): Project["status"] {
  if (!status) {
    return "draft";
  }
  if (ACTIVE_RUN_STATUSES.has(status)) {
    return "building";
  }
  if (status === "completed") {
    return "live";
  }
  if (status === "failed" || status === "cancelled") {
    return "paused";
  }
  return "draft";
}

function deriveProjectStack(item: ApiProjectItem): string[] {
  const stack = new Set<string>();
  const fileNames = item.currentSnapshot?.files?.map((file) => file.name.toLowerCase()) ?? [];

  if (fileNames.some((name) => name.endsWith(".tsx") || name.endsWith(".jsx"))) {
    stack.add("React");
  }
  if (fileNames.some((name) => name.endsWith(".ts") || name.endsWith(".tsx"))) {
    stack.add("TypeScript");
  }
  if (fileNames.some((name) => name.endsWith(".css"))) {
    stack.add("Tailwind");
  }
  if (item.latestRun?.model) {
    stack.add(item.latestRun.model);
  }
  if (stack.size === 0) {
    stack.add("Dexter");
  }

  return Array.from(stack).slice(0, 4);
}

function toProjectCard(item: ApiProjectItem): Project {
  return {
    id: item.project.id,
    name: item.project.name,
    description:
      item.project.description?.trim() ||
      item.currentSnapshot?.summary ||
      "Saved project",
    status: mapRunStatusToProjectStatus(item.latestRun?.status),
    lastEdited: new Date(item.project.updated_at),
    previewUrl: "",
    stack: deriveProjectStack(item),
  };
}

export default function HomePage() {
  const router = useRouter();
  const [error, setError] = React.useState("");
  const [recentProjects, setRecentProjects] = React.useState<Project[]>([]);
  const [recentProjectsError, setRecentProjectsError] = React.useState("");
  const [isRecentProjectsLoading, setIsRecentProjectsLoading] = React.useState(true);
  const [deletingProjectId, setDeletingProjectId] = React.useState<string | null>(null);

  const loadRecentProjects = React.useCallback(async () => {
    setIsRecentProjectsLoading(true);
    setRecentProjectsError("");
    try {
      const response = await fetch("/api/projects");
      const data = (await response.json()) as { projects?: ApiProjectItem[]; error?: string };
      if (!response.ok || !data.projects) {
        throw new Error(data.error ?? "Failed to load recent projects");
      }
      setRecentProjects(data.projects.map(toProjectCard));
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

  return (
    <div className="min-h-screen bg-[#0B0B0F]">
      {/* Sidebar */}
      <Sidebar activeItem="home" />

      {/* Top Navigation */}
      <TopNav variant="home" />

      {/* Main Content */}
      <main className="pl-[72px] pt-16">
        {/* Background gradient effects */}
        <div className="fixed inset-0 pointer-events-none overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-purple-500/5 rounded-full blur-[120px]" />
          <div className="absolute top-1/4 right-0 w-[400px] h-[400px] bg-cyan-500/5 rounded-full blur-[100px]" />
        </div>

        {/* Hero Section */}
        <section className="relative px-12 pt-20 pb-16">
          <div className="max-w-4xl mx-auto text-center">
            {/* Badge */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
              className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-500/10 border border-purple-500/20 mb-8"
            >
              <Sparkles className="w-4 h-4 text-purple-400" />
              <span className="text-sm text-purple-300">AI-Powered Development</span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-display gradient-text mb-6"
            >
              Build production software
              <br />
              at the speed of thought.
            </motion.h1>

            {/* Subtext */}
            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-xl text-[#9CA3AF] mb-12 max-w-2xl mx-auto"
            >
              Dexter plans, builds, and iterates with you, from first prompt to
              production-ready experience.
            </motion.p>

            {/* Prompt Composer */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.3 }}
            >
              <PromptComposer size="large" onSubmit={onComposerSubmit} />
              {error ? (
                <p className="mt-3 text-sm text-red-300">{error}</p>
              ) : null}
            </motion.div>
          </div>
        </section>

        {/* Recent Builds Section */}
        <section className="relative px-12 py-12">
          <div className="max-w-7xl mx-auto">
            {/* Section Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-title text-[#E6E6EB] mb-1">Recent Builds</h2>
                <p className="text-sm text-[#6B7280]">Pick up where you left off</p>
              </div>
              <motion.button
                className="flex items-center gap-1 text-sm text-[#9CA3AF] hover:text-[#E6E6EB] transition-colors"
                whileHover={{ x: 4 }}
                onClick={() => router.push("/projects")}
              >
                View all
                <ChevronRight className="w-4 h-4" />
              </motion.button>
            </div>

            {recentProjectsError ? (
              <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {recentProjectsError}
              </div>
            ) : null}

            {/* Horizontal Scroll Cards */}
            <div className="relative -mx-12 px-12">
              <div className="flex gap-5 overflow-x-auto pb-4 no-scrollbar">
                {isRecentProjectsLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={`recent-skeleton-${i}`}
                      className="w-[280px] h-[238px] rounded-xl border border-white/6 bg-[#111218] shimmer"
                    />
                  ))
                ) : recentProjects.length > 0 ? (
                  recentProjects.map((project, i) => (
                    <motion.div
                      key={project.id}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.4, delay: i * 0.08 }}
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
                  <div className="w-full rounded-xl border border-white/10 bg-[#111218] px-5 py-8 text-sm text-[#9CA3AF]">
                    No projects yet. Generate your first build above to populate recent projects.
                  </div>
                )}
              </div>

              {/* Fade gradients */}
              <div className="absolute left-0 top-0 bottom-4 w-12 bg-gradient-to-r from-[#0B0B0F] to-transparent pointer-events-none" />
              <div className="absolute right-0 top-0 bottom-4 w-12 bg-gradient-to-l from-[#0B0B0F] to-transparent pointer-events-none" />
            </div>
          </div>
        </section>

        {/* Templates Section */}
        <section className="relative px-12 py-12 pb-24">
          <div className="max-w-7xl mx-auto">
            {/* Section Header */}
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-title text-[#E6E6EB] mb-1">Templates</h2>
                <p className="text-sm text-[#6B7280]">Start with a proven foundation</p>
              </div>
              <motion.button
                className="flex items-center gap-1 text-sm text-[#9CA3AF] hover:text-[#E6E6EB] transition-colors"
                whileHover={{ x: 4 }}
              >
                Browse all
                <ChevronRight className="w-4 h-4" />
              </motion.button>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {templates.map((template, i) => (
                <motion.div
                  key={template.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: i * 0.08 }}
                >
                  <TemplateCard template={template} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
