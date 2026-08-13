"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: "default" | "circular" | "text";
}

function Skeleton({ className, variant = "default", ...props }: SkeletonProps) {
    const variants = {
        default: "rounded-lg",
        circular: "rounded-full",
        text: "rounded-md h-4",
    };

    return (
        <div
            className={cn(
                "shimmer",
                variants[variant],
                className
            )}
            {...props}
        />
    );
}

// Skeleton group for cards
function SkeletonCard({ className }: { className?: string }) {
    return (
        <div className={cn("space-y-4 p-5 bg-[#111218] rounded-xl border border-white/6", className)}>
            <Skeleton className="h-32 w-full" />
            <div className="space-y-2">
                <Skeleton variant="text" className="w-3/4" />
                <Skeleton variant="text" className="w-1/2" />
            </div>
            <div className="flex gap-2">
                <Skeleton className="h-6 w-16 rounded-full" />
                <Skeleton className="h-6 w-16 rounded-full" />
            </div>
        </div>
    );
}

// Skeleton for text lines
function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
    return (
        <div className={cn("space-y-2", className)}>
            {Array.from({ length: lines }).map((_, i) => (
                <Skeleton
                    key={i}
                    variant="text"
                    className={cn(
                        i === lines - 1 ? "w-2/3" : "w-full"
                    )}
                />
            ))}
        </div>
    );
}

export { Skeleton, SkeletonCard, SkeletonLines };
