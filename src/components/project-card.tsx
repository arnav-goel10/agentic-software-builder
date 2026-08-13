"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Clock, ExternalLink, MoreHorizontal, Trash2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn, formatRelativeTime } from "@/lib/utils";
import type { Project } from "@/lib/mock-data";

interface ProjectCardProps {
    project: Project;
    onClick?: () => void;
    onDelete?: (projectId: string) => void;
    isDeleting?: boolean;
}

const statusConfig = {
    building: { variant: "purple" as const, label: "Building", dot: true, pulse: true },
    live: { variant: "success" as const, label: "Live", dot: true, pulse: false },
    paused: { variant: "warning" as const, label: "Paused", dot: false, pulse: false },
    draft: { variant: "default" as const, label: "Draft", dot: false, pulse: false },
};

const stackIcons: Record<string, string> = {
    "Next.js": "⚡",
    "React": "⚛️",
    "TypeScript": "📘",
    "Supabase": "🔥",
    "OpenAI": "🤖",
    "Tailwind": "🎨",
    "Stripe": "💳",
    "Prisma": "🔷",
    "Socket.io": "🔌",
    "PostgreSQL": "🐘",
    "MDX": "📝",
    "Vercel": "▲",
};

export function ProjectCard({ project, onClick, onDelete, isDeleting = false }: ProjectCardProps) {
    const status = statusConfig[project.status];

    return (
        <motion.div
            onClick={onClick}
            className={cn(
                "group relative flex-shrink-0 w-[280px] rounded-xl overflow-hidden cursor-pointer",
                "bg-[#111218] border border-white/6",
                "transition-all duration-300"
            )}
            whileHover={{
                y: -4,
                boxShadow: "0 20px 40px rgba(0, 0, 0, 0.4), 0 0 40px rgba(139, 92, 246, 0.08)"
            }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
            {/* Preview Image */}
            <div className="relative h-36 bg-gradient-to-br from-[#1C1D24] to-[#16171D] overflow-hidden">
                {/* Gradient overlay */}
                <div className="absolute inset-0 bg-gradient-to-t from-[#111218] via-transparent to-transparent z-10" />

                {/* Mock preview content */}
                <div className="absolute inset-4 rounded-lg bg-[#0B0B0F] border border-white/10 p-3 flex flex-col gap-2">
                    <div className="h-2 w-16 rounded bg-white/10" />
                    <div className="h-2 w-24 rounded bg-white/5" />
                    <div className="flex-1 flex gap-2 mt-2">
                        <div className="flex-1 rounded bg-purple-500/10 border border-purple-500/20" />
                        <div className="w-12 rounded bg-cyan-500/10 border border-cyan-500/20" />
                    </div>
                </div>

                {/* Hover overlay */}
                <motion.div
                    className="absolute inset-0 bg-purple-500/10 z-20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    initial={false}
                >
                    <div className="p-2 rounded-full bg-white/10 backdrop-blur-sm">
                        <ExternalLink className="w-5 h-5 text-white" />
                    </div>
                </motion.div>

                {/* Status badge */}
                <div className="absolute top-3 left-3 z-20">
                    <Badge variant={status.variant} dot={status.dot} pulse={status.pulse}>
                        {status.label}
                    </Badge>
                </div>

                {/* Top-right action */}
                {onDelete ? (
                    <motion.button
                        className={cn(
                            "absolute top-3 right-3 z-20 p-1.5 rounded-lg backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity",
                            "bg-black/40 text-white/80 hover:text-white",
                            "disabled:opacity-50 disabled:cursor-not-allowed"
                        )}
                        whileHover={{ scale: isDeleting ? 1 : 1.05 }}
                        whileTap={{ scale: isDeleting ? 1 : 0.95 }}
                        disabled={isDeleting}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!isDeleting) {
                                onDelete(project.id);
                            }
                        }}
                        title="Delete project"
                    >
                        <Trash2 className="w-4 h-4" />
                    </motion.button>
                ) : (
                    <motion.button
                        className="absolute top-3 right-3 z-20 p-1.5 rounded-lg bg-black/40 backdrop-blur-sm text-white/70 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <MoreHorizontal className="w-4 h-4" />
                    </motion.button>
                )}
            </div>

            {/* Content */}
            <div className="p-4">
                {/* Title & Description */}
                <h3 className="text-sm font-medium text-[#E6E6EB] mb-1 group-hover:text-white transition-colors">
                    {project.name}
                </h3>
                <p className="text-xs text-[#6B7280] mb-3 line-clamp-1">
                    {project.description}
                </p>

                {/* Footer */}
                <div className="flex items-center justify-between">
                    {/* Stack */}
                    <div className="flex items-center gap-1">
                        {project.stack.slice(0, 3).map((tech) => (
                            <span
                                key={tech}
                                className="w-6 h-6 rounded-md bg-white/5 flex items-center justify-center text-xs"
                                title={tech}
                            >
                                {stackIcons[tech] || "📦"}
                            </span>
                        ))}
                        {project.stack.length > 3 && (
                            <span className="text-xs text-[#6B7280] ml-1">
                                +{project.stack.length - 3}
                            </span>
                        )}
                    </div>

                    {/* Last edited */}
                    <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                        <Clock className="w-3 h-3" />
                        {formatRelativeTime(project.lastEdited)}
                    </div>
                </div>
            </div>

            {/* Bottom gradient line on hover */}
            <motion.div
                className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#6366F1] via-[#8B5CF6] to-[#A855F7] opacity-0 group-hover:opacity-100 transition-opacity"
            />
        </motion.div>
    );
}
