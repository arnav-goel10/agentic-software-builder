"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { TopBar } from "@/components/top-bar";
import { ProjectCard } from "@/components/project-card";
import { toProjectView, type ApiProjectItem, type ProjectView } from "@/lib/project-view";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = React.useState<ProjectView[]>([]);
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
      setProjects(data.projects.map(toProjectView));
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
    <div className="min-h-screen bg-[#fafafa]">
      <TopBar variant="marketing" />

      <main className="px-6 py-12">
        <div className="max-w-5xl mx-auto">
          <div className="mb-8">
            <h1 className="text-title text-[#1d1d1f] mb-1">Projects</h1>
            <p className="text-[13px] text-[#86868b]">Every build Dexter has produced, newest first</p>
          </div>

          {error ? (
            <div role="alert" className="mb-6 rounded-[12px] border border-[#d1242f]/20 bg-[#d1242f]/5 px-4 py-3 text-sm text-[#d1242f]">
              {error}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-4">
            {loading ? (
              Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={`project-skeleton-${index}`}
                  className="w-[280px] h-[160px] rounded-[14px] border border-black/[0.08] bg-white shimmer"
                />
              ))
            ) : projects.length > 0 ? (
              projects.map((project, index) => (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(index, 8) * 0.04, ease: [0.16, 1, 0.3, 1] }}
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
              <div className="w-full rounded-[14px] border border-dashed border-black/[0.12] bg-white/60 px-6 py-16 text-center">
                <p className="text-[14px] font-medium text-[#1d1d1f] mb-1">No projects yet</p>
                <p className="text-[13px] text-[#86868b]">
                  Head back to the home page and describe your first build.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
