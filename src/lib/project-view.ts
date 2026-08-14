/**
 * Shared mapping from the /api/projects payload shape to the view model
 * used by ProjectCard on both the landing page and the projects list.
 * Replaces the old mock-data.ts fake content.
 */

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  status: "building" | "live" | "paused" | "draft";
  lastEdited: Date;
  fileCount: number;
  model: string | null;
}

export type ApiProjectItem = {
  project: {
    id: string;
    name: string;
    description: string | null;
    status: string;
    updated_at: number;
  };
  latestRun: {
    id?: string;
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

export function mapRunStatusToProjectStatus(status: string | undefined): ProjectView["status"] {
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

export function toProjectView(item: ApiProjectItem): ProjectView {
  return {
    id: item.project.id,
    name: item.project.name,
    description:
      item.project.description?.trim() || item.currentSnapshot?.summary || "No description yet",
    status: mapRunStatusToProjectStatus(item.latestRun?.status),
    lastEdited: new Date(item.project.updated_at),
    fileCount: item.currentSnapshot?.files?.length ?? 0,
    model: item.latestRun?.model || null,
  };
}
