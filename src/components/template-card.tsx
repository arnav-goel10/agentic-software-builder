"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, Star } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import type { Template } from "@/lib/mock-data";

interface TemplateCardProps {
    template: Template;
    onClick?: () => void;
}

const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
    Business: { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/20" },
    "AI/ML": { bg: "bg-purple-500/10", text: "text-purple-400", border: "border-purple-500/20" },
    Finance: { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/20" },
    "E-commerce": { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/20" },
    DevTools: { bg: "bg-cyan-500/10", text: "text-cyan-400", border: "border-cyan-500/20" },
    Marketing: { bg: "bg-pink-500/10", text: "text-pink-400", border: "border-pink-500/20" },
};

export function TemplateCard({ template, onClick }: TemplateCardProps) {
    const colors = categoryColors[template.category] || categoryColors.Business;

    return (
        <motion.div
            onClick={onClick}
            className={cn(
                "group relative rounded-xl overflow-hidden cursor-pointer",
                "bg-[#111218] border border-white/6",
                "transition-all duration-300"
            )}
            whileHover={{
                y: -4,
                boxShadow: "0 20px 40px rgba(0, 0, 0, 0.4)"
            }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
        >
            {/* Preview */}
            <div className="relative aspect-[4/3] bg-gradient-to-br from-[#1C1D24] to-[#16171D] overflow-hidden">
                {/* Grid pattern overlay */}
                <div
                    className="absolute inset-0 opacity-20"
                    style={{
                        backgroundImage: `
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
            `,
                        backgroundSize: "20px 20px",
                    }}
                />

                {/* Mock UI preview */}
                <div className="absolute inset-4 rounded-lg bg-[#0B0B0F] border border-white/10 overflow-hidden">
                    {/* Mock header */}
                    <div className="h-6 border-b border-white/5 flex items-center gap-1.5 px-2">
                        <div className="w-2 h-2 rounded-full bg-red-400/80" />
                        <div className="w-2 h-2 rounded-full bg-yellow-400/80" />
                        <div className="w-2 h-2 rounded-full bg-green-400/80" />
                    </div>

                    {/* Mock content */}
                    <div className="p-2 space-y-2">
                        <div className="h-4 w-3/4 rounded bg-white/10" />
                        <div className="h-3 w-1/2 rounded bg-white/5" />
                        <div className="h-16 w-full rounded bg-purple-500/10 border border-purple-500/20 mt-4" />
                    </div>
                </div>

                {/* Hover overlay */}
                <motion.div
                    className="absolute inset-0 bg-gradient-to-t from-purple-500/20 to-transparent z-10 flex items-end justify-center pb-6 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                    <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-sm text-white text-sm font-medium">
                        Use Template
                        <ArrowUpRight className="w-4 h-4" />
                    </div>
                </motion.div>

                {/* Popular badge */}
                {template.popular && (
                    <div className="absolute top-3 right-3 z-20">
                        <Badge variant="gradient" className="gap-1">
                            <Star className="w-3 h-3 fill-current" />
                            Popular
                        </Badge>
                    </div>
                )}
            </div>

            {/* Content */}
            <div className="p-4">
                {/* Category & Title */}
                <div className="flex items-center gap-2 mb-2">
                    <span className={cn(
                        "px-2 py-0.5 rounded-md text-xs font-medium border",
                        colors.bg, colors.text, colors.border
                    )}>
                        {template.category}
                    </span>
                </div>

                <h3 className="text-sm font-medium text-[#E6E6EB] mb-1 group-hover:text-white transition-colors">
                    {template.name}
                </h3>
                <p className="text-xs text-[#6B7280] line-clamp-2">
                    {template.description}
                </p>
            </div>

            {/* Bottom gradient line on hover */}
            <motion.div
                className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-[#6366F1] via-[#8B5CF6] to-[#A855F7] opacity-0 group-hover:opacity-100 transition-opacity"
            />
        </motion.div>
    );
}
