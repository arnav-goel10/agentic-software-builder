"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors",
    {
        variants: {
            variant: {
                default: "bg-white/10 text-[#E6E6EB] border border-white/10",
                success: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20",
                warning: "bg-amber-500/15 text-amber-400 border border-amber-500/20",
                error: "bg-red-500/15 text-red-400 border border-red-500/20",
                info: "bg-cyan-500/15 text-cyan-400 border border-cyan-500/20",
                purple: "bg-purple-500/15 text-purple-400 border border-purple-500/20",
                gradient: "bg-gradient-to-r from-[#6366F1]/20 to-[#A855F7]/20 text-purple-300 border border-purple-500/20",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
);

export interface BadgeProps
    extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
    dot?: boolean;
    pulse?: boolean;
}

function Badge({ className, variant, dot, pulse, children, ...props }: BadgeProps) {
    return (
        <div className={cn(badgeVariants({ variant }), className)} {...props}>
            {dot && (
                <span className="relative flex h-2 w-2">
                    {pulse && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
                    )}
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
                </span>
            )}
            {children}
        </div>
    );
}

export { Badge, badgeVariants };
