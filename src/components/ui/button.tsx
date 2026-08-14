"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[10px] text-[13px] font-medium transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] focus-visible:ring-offset-2 focus-visible:ring-offset-[#fafafa] disabled:pointer-events-none disabled:opacity-40 active:scale-[0.98]",
    {
        variants: {
            variant: {
                default: "bg-[#0071e3] text-white shadow-sm hover:bg-[#0077ed] active:bg-[#0068d1]",
                secondary:
                    "bg-white text-[#1d1d1f] border border-black/[0.08] shadow-sm hover:bg-[#f5f5f7] hover:border-black/[0.12]",
                ghost: "text-[#6e6e73] hover:text-[#1d1d1f] hover:bg-black/[0.04]",
                outline:
                    "border border-black/[0.12] bg-transparent text-[#1d1d1f] hover:bg-black/[0.03] hover:border-black/[0.18]",
                danger: "bg-[#d1242f]/10 text-[#d1242f] border border-[#d1242f]/20 hover:bg-[#d1242f]/15",
            },
            size: {
                default: "h-10 px-4 py-2",
                sm: "h-8 px-3 text-xs",
                lg: "h-12 px-6 text-[15px]",
                xl: "h-[52px] px-8 text-base",
                icon: "h-10 w-10",
                "icon-sm": "h-8 w-8",
                "icon-lg": "h-12 w-12",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button";
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        );
    }
);
Button.displayName = "Button";

export { Button, buttonVariants };
