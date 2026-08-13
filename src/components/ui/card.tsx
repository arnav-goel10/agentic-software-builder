"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: "default" | "glass" | "elevated" | "gradient-border";
    hoverable?: boolean;
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
    ({ className, variant = "default", hoverable = false, children, ...props }, ref) => {
        const variants = {
            default: "bg-[#111218] border border-white/6",
            glass: "glass",
            elevated: "bg-[#16171D] border border-white/10 shadow-lg",
            "gradient-border": "gradient-border",
        };

        const baseStyles = cn(
            "rounded-xl p-5 transition-all duration-300",
            variants[variant],
            hoverable && "hover:translate-y-[-2px] hover:shadow-xl hover:border-white/15 cursor-pointer",
            className
        );

        if (hoverable) {
            return (
                <motion.div
                    ref={ref}
                    className={baseStyles}
                    whileHover={{ y: -4, boxShadow: "0 16px 48px rgba(0, 0, 0, 0.4)" }}
                    transition={{ type: "spring", stiffness: 300, damping: 20 }}
                >
                    {children}
                </motion.div>
            );
        }

        return (
            <div ref={ref} className={baseStyles} {...props}>
                {children}
            </div>
        );
    }
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn("flex flex-col gap-1.5 pb-4", className)}
        {...props}
    />
));
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<
    HTMLHeadingElement,
    React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
    <h3
        ref={ref}
        className={cn("text-lg font-semibold text-[#E6E6EB] tracking-tight", className)}
        {...props}
    />
));
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<
    HTMLParagraphElement,
    React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
    <p
        ref={ref}
        className={cn("text-sm text-[#9CA3AF]", className)}
        {...props}
    />
));
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div ref={ref} className={cn("", className)} {...props} />
));
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
    <div
        ref={ref}
        className={cn("flex items-center pt-4 border-t border-white/6", className)}
        {...props}
    />
));
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
