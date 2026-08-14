"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-tight transition-colors",
    {
        variants: {
            variant: {
                default: "bg-[#f5f5f7] text-[#6e6e73] border border-black/[0.06]",
                success: "bg-[#1a7f37]/10 text-[#1a7f37] border border-[#1a7f37]/15",
                warning: "bg-[#9a6700]/10 text-[#9a6700] border border-[#9a6700]/15",
                error: "bg-[#d1242f]/10 text-[#d1242f] border border-[#d1242f]/15",
                info: "bg-[#0071e3]/10 text-[#0071e3] border border-[#0071e3]/15",
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
                <span className="relative flex h-1.5 w-1.5">
                    {pulse && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
                    )}
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                </span>
            )}
            {children}
        </div>
    );
}

export { Badge, badgeVariants };
