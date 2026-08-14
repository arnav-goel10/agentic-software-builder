"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { ArrowUp, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ExampleBrief {
    label: string;
    prompt: string;
}

export const EXAMPLE_BRIEFS: ExampleBrief[] = [
    {
        label: "Counter app",
        prompt:
            "A counter app with increment, decrement, and reset buttons, plus a running history of the last 5 values.",
    },
    {
        label: "Todo list",
        prompt:
            "A todo list where I can add tasks, mark them complete, and delete them, with a live count of tasks remaining.",
    },
    {
        label: "Habit tracker",
        prompt:
            "A daily habit tracker with a list of habits I can check off each day and a weekly streak view for each one.",
    },
    {
        label: "Notes app",
        prompt:
            "A simple notes app where I can create, edit, and delete short text notes, listed in a sidebar sorted by last edited.",
    },
    {
        label: "Quiz game",
        prompt:
            "A multiple-choice quiz game with five questions, a running score counter, and a results screen at the end.",
    },
];

interface PromptComposerProps {
    onSubmit?: (prompt: string) => Promise<void> | void;
    size?: "default" | "large";
    value?: string;
    onValueChange?: (value: string) => void;
}

export function PromptComposer({ onSubmit, size = "default", value, onValueChange }: PromptComposerProps) {
    const [internalPrompt, setInternalPrompt] = React.useState("");
    const [isFocused, setIsFocused] = React.useState(false);
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    const isControlled = value !== undefined;
    const prompt = isControlled ? value : internalPrompt;

    const setPrompt = React.useCallback(
        (next: string) => {
            if (!isControlled) {
                setInternalPrompt(next);
            }
            onValueChange?.(next);
        },
        [isControlled, onValueChange]
    );

    const applyExample = React.useCallback(
        (text: string) => {
            setPrompt(text);
            requestAnimationFrame(() => {
                const element = textareaRef.current;
                if (!element) return;
                element.focus();
                element.setSelectionRange(text.length, text.length);
            });
        },
        [setPrompt]
    );

    const handleSubmit = React.useCallback(async () => {
        if (prompt.trim() && !isSubmitting) {
            setIsSubmitting(true);
            try {
                await onSubmit?.(prompt);
            } finally {
                setIsSubmitting(false);
            }
        }
    }, [isSubmitting, onSubmit, prompt]);

    const handleKeyDown = async (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            await handleSubmit();
        }
    };

    const isLarge = size === "large";

    return (
        <div className="w-full max-w-2xl mx-auto">
            <div
                className={cn(
                    "relative rounded-[16px] bg-white border transition-all duration-200 ease-out",
                    isFocused ? "border-[#0071e3]/40 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_0_0_4px_rgba(0,113,227,0.08)]" : "border-black/[0.08] shadow-sm"
                )}
            >
                <div className={cn(isLarge ? "px-5 pt-5 pb-3" : "px-4 pt-4 pb-2")}>
                    <label htmlFor="dexter-composer" className="sr-only">
                        Describe the app you want Dexter to build
                    </label>
                    <textarea
                        id="dexter-composer"
                        ref={textareaRef}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onFocus={() => setIsFocused(true)}
                        onBlur={() => setIsFocused(false)}
                        onKeyDown={handleKeyDown}
                        placeholder="Describe the app you want Dexter to build..."
                        className={cn(
                            "w-full bg-transparent border-none outline-none resize-none",
                            "text-[#1d1d1f] placeholder:text-[#a1a1a6]",
                            "leading-relaxed",
                            "focus:outline-none focus:ring-0",
                            isLarge ? "min-h-[88px] text-[17px]" : "min-h-[64px] text-[15px]"
                        )}
                        rows={isLarge ? 3 : 2}
                    />
                </div>

                <div className="flex items-center justify-between px-4 py-3 border-t border-black/[0.06]">
                    <span className="text-[12px] text-[#a1a1a6] font-mono hidden sm:inline">⌘ + Enter to build</span>
                    <motion.button
                        onClick={() => void handleSubmit()}
                        disabled={!prompt.trim() || isSubmitting}
                        whileTap={{ scale: prompt.trim() ? 0.98 : 1 }}
                        transition={{ duration: 0.15 }}
                        className={cn(
                            "ml-auto flex items-center gap-2 px-5 py-2.5 rounded-[10px] font-medium text-[14px]",
                            "bg-[#0071e3] text-white shadow-sm",
                            "disabled:opacity-40 disabled:cursor-not-allowed",
                            "hover:bg-[#0077ed] active:bg-[#0068d1]",
                            "transition-colors duration-150"
                        )}
                    >
                        {isSubmitting ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Building...
                            </>
                        ) : (
                            <>
                                Build
                                <ArrowUp className="w-4 h-4" />
                            </>
                        )}
                    </motion.button>
                </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                {EXAMPLE_BRIEFS.map((example) => (
                    <button
                        key={example.label}
                        type="button"
                        onClick={() => applyExample(example.prompt)}
                        className={cn(
                            "px-3 py-1.5 rounded-full text-[13px] font-medium",
                            "bg-white border border-black/[0.08] text-[#6e6e73] shadow-sm",
                            "hover:text-[#1d1d1f] hover:border-black/[0.14] transition-colors duration-150"
                        )}
                    >
                        {example.label}
                    </button>
                ))}
            </div>
        </div>
    );
}
