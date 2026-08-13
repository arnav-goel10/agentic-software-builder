"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { TopNav } from "@/components/top-nav";
import { ProjectCard } from "@/components/project-card";
import type { Project } from "@/lib/mock-data";

type ApiProjectItem = {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    updated_at: number;
  };
  latestRun: {
    id: string;
    status: string;
    model?: string;
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
    description: item.project.description?.trim() || item.currentSnapshot?.summary || "Saved project",
    status: mapRunStatusToProjectStatus(item.latestRun?.status),
    lastEdited: new Date(item.project.updated_at),
    previewUrl: "",
    stack: deriveProjectStack(item),
  };
}

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [deletingProjectId, setDeletingProjectId] = React.useState<string | null>(null);

  const loadProjects = React.useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/projects");
      const data = (await response.json()) as { projects?: ApiProjectItem[]; error?: string };
      if (!response.ok || !data.projects) {
        throw new Error(data.error ?? "Failed to load projects");
      }
      setProjects(data.projects.map(toProjectCard));
    } catch (loadError) {
      setProjects([]);
      setError(loadError instanceof Error ? loadError.message : "Failed to load projects");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

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
      setError("");
      try {
        const response = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? "Failed to delete project");
        }
        setProjects((prev) => prev.filter((project) => project.id !== projectId));
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : "Failed to delete project");
      } finally {
        setDeletingProjectId(null);
      }
    },
    [deletingProjectId]
  );

  return (
    <div className="min-h-screen bg-[#0B0B0F]">
      <Sidebar activeItem="projects" />
      <TopNav variant="home" />

      <main className="pl-[72px] pt-20 px-12 pb-12">
        <div className="max-w-7xl mx-auto">
          <div className="mb-8">
            <h1 className="text-title text-[#E6E6EB] mb-1">Projects</h1>
            <p className="text-sm text-[#6B7280]">Pick up where you left off</p>
          </div>

          {error ? (
            <div className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-5">
            {loading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={`project-skeleton-${index}`}
                  className="w-[280px] h-[238px] rounded-xl border border-white/6 bg-[#111218] shimmer"
                />
              ))
            ) : projects.length > 0 ? (
              projects.map((project, index) => (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, delay: index * 0.05 }}
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
                No projects yet. Generate your first build on home to populate this list.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
