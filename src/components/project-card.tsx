"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Clock, FileText, Trash2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { ProjectView } from "@/lib/project-view";

interface ProjectCardProps {
    project: ProjectView;
    onClick?: () => void;
    onDelete?: (projectId: string) => void;
    isDeleting?: boolean;
}

const statusConfig: Record<ProjectView["status"], { variant: "info" | "success" | "warning" | "default"; label: string; dot: boolean; pulse: boolean }> = {
    building: { variant: "info", label: "Building", dot: true, pulse: true },
    live: { variant: "success", label: "Complete", dot: true, pulse: false },
    paused: { variant: "warning", label: "Needs attention", dot: false, pulse: false },
    draft: { variant: "default", label: "Draft", dot: false, pulse: false },
};

export function ProjectCard({ project, onClick, onDelete, isDeleting = false }: ProjectCardProps) {
    const status = statusConfig[project.status];

    return (
        <motion.div
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onClick?.();
                }
            }}
            className={cn(
                "group relative flex-shrink-0 w-[280px] rounded-[14px] overflow-hidden cursor-pointer text-left",
                "bg-white border border-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)]",
                "transition-all duration-200 ease-out",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] focus-visible:ring-offset-2"
            )}
            whileHover={{ y: -2, boxShadow: "0 4px 12px rgba(0,0,0,0.06), 0 16px 32px -16px rgba(0,0,0,0.16)" }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
            <div className="p-4">
                <div className="flex items-start justify-between gap-2 mb-3">
                    <Badge variant={status.variant} dot={status.dot} pulse={status.pulse}>
                        {status.label}
                    </Badge>
                    {onDelete ? (
                        <button
                            type="button"
                            aria-label={`Delete ${project.name}`}
                            className={cn(
                                "p-1.5 rounded-[8px] text-[#a1a1a6] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition-opacity",
                                "hover:text-[#d1242f] hover:bg-[#d1242f]/10",
                                "disabled:opacity-50 disabled:cursor-not-allowed"
                            )}
                            disabled={isDeleting}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (!isDeleting) {
                                    onDelete(project.id);
                                }
                            }}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    ) : null}
                </div>

                <h3 className="text-[14px] font-semibold text-[#1d1d1f] mb-1 truncate tracking-tight">
                    {project.name}
                </h3>
                <p className="text-[12.5px] text-[#6e6e73] mb-4 line-clamp-2 min-h-[32px]">
                    {project.description}
                </p>

                <div className="flex items-center justify-between text-[12px] text-[#86868b] pt-3 border-t border-black/[0.06]">
                    <span className="flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5" />
                        {project.fileCount} {project.fileCount === 1 ? "file" : "files"}
                    </span>
                    <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        {formatRelativeTime(project.lastEdited)}
                    </span>
                </div>
            </div>
        </motion.div>
    );
}
