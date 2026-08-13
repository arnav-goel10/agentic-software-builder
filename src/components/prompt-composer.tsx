"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mic, Paperclip, Sparkles, ArrowUp, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

const suggestions = [
    "Build a fintech app with crypto portfolio tracking",
    "Create an AI-powered writing assistant",
    "Design a marketplace like Airbnb",
    "Build a team collaboration tool",
];

interface PromptComposerProps {
    onSubmit?: (prompt: string) => Promise<void> | void;
    size?: "default" | "large";
}

export function PromptComposer({ onSubmit, size = "default" }: PromptComposerProps) {
    const [prompt, setPrompt] = React.useState("");
    const [isFocused, setIsFocused] = React.useState(false);
    const [showSuggestions, setShowSuggestions] = React.useState(false);
    const [isSubmitting, setIsSubmitting] = React.useState(false);
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);

    const applySuggestion = React.useCallback((value: string) => {
        setPrompt(value);
        setShowSuggestions(false);
        setIsFocused(true);

        requestAnimationFrame(() => {
            const element = textareaRef.current;
            if (!element) return;
            element.focus();
            const cursor = value.length;
            element.setSelectionRange(cursor, cursor);
        });
    }, []);

    const handleSubmit = async () => {
        if (prompt.trim() && !isSubmitting) {
            setIsSubmitting(true);
            try {
                await onSubmit?.(prompt);
            } finally {
                setIsSubmitting(false);
            }
        }
    };

    const handleKeyDown = async (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            await handleSubmit();
        }
    };

    const isLarge = size === "large";

    return (
        <div className="w-full max-w-3xl mx-auto">
            {/* Main Composer */}
            <motion.div
                className={cn(
                    "relative rounded-2xl overflow-hidden",
                    "transition-all duration-300",
                    isFocused ? "shadow-2xl" : "shadow-lg"
                )}
                animate={{
                    boxShadow: isFocused
                        ? "0 0 60px rgba(139, 92, 246, 0.15), 0 0 100px rgba(34, 211, 238, 0.05)"
                        : "0 8px 32px rgba(0, 0, 0, 0.4)",
                }}
            >
                {/* Gradient border */}
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-r from-[#6366F1] via-[#8B5CF6] to-[#22D3EE] opacity-20" />
                <div className="absolute inset-[1px] rounded-2xl bg-[#111218]" />

                {/* Inner content */}
                <div className="relative">
                    {/* Textarea */}
                    <div
                        className={cn(
                            isLarge ? "px-6 pt-5 pb-4" : "px-5 pt-4 pb-3"
                        )}
                    >
                        <textarea
                            ref={textareaRef}
                            value={prompt}
                            onChange={(e) => {
                                setPrompt(e.target.value);
                                setShowSuggestions(e.target.value.length === 0);
                            }}
                            onFocus={() => {
                                setIsFocused(true);
                                setShowSuggestions(prompt.length === 0);
                            }}
                            onBlur={() => {
                                setIsFocused(false);
                                setTimeout(() => setShowSuggestions(false), 200);
                            }}
                            onKeyDown={handleKeyDown}
                            placeholder="Describe the product you want Dexter to ship..."
                            className={cn(
                                "w-full bg-transparent border-none outline-none resize-none",
                                "text-[#E6E6EB] placeholder:text-[#4B5563]",
                                "leading-relaxed",
                                "focus:outline-none focus:ring-0 focus:shadow-none",
                                "focus-visible:!outline-none focus-visible:!ring-0 focus-visible:!shadow-none",
                                isLarge ? "min-h-[92px] text-lg" : "min-h-[68px] text-base"
                            )}
                            rows={isLarge ? 3 : 2}
                        />
                    </div>

                    {/* Bottom toolbar */}
                    <div className="flex items-center justify-between px-4 py-3 border-t border-white/6">
                        {/* Left actions */}
                        <div className="flex items-center gap-2">
                            <motion.button
                                className="p-2 rounded-lg text-[#6B7280] hover:text-[#E6E6EB] hover:bg-white/5 transition-colors"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                            >
                                <Paperclip className="w-4 h-4" />
                            </motion.button>
                            <motion.button
                                className="p-2 rounded-lg text-[#6B7280] hover:text-[#E6E6EB] hover:bg-white/5 transition-colors"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                            >
                                <Mic className="w-4 h-4" />
                            </motion.button>
                            <motion.button
                                className="p-2 rounded-lg text-[#6B7280] hover:text-[#E6E6EB] hover:bg-white/5 transition-colors"
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                            >
                                <Layers className="w-4 h-4" />
                            </motion.button>
                        </div>

                        {/* Generate button */}
                        <motion.button
                            onClick={handleSubmit}
                            disabled={!prompt.trim() || isSubmitting}
                            className={cn(
                                "flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm",
                                "bg-gradient-to-r from-[#6366F1] via-[#8B5CF6] to-[#A855F7]",
                                "text-white shadow-lg shadow-purple-500/25",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                                "hover:shadow-purple-500/40 hover:brightness-110",
                                "transition-all duration-200"
                            )}
                            whileHover={{ scale: prompt.trim() ? 1.02 : 1 }}
                            whileTap={{ scale: prompt.trim() ? 0.98 : 1 }}
                        >
                            <Sparkles className="w-4 h-4" />
                            {isSubmitting ? "Starting..." : "Generate"}
                            <ArrowUp className="w-4 h-4 ml-1" />
                        </motion.button>
                    </div>
                </div>
            </motion.div>

            {/* Suggestions dropdown */}
            <AnimatePresence>
                {showSuggestions && isFocused && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.15 }}
                        className="mt-2 p-2 rounded-xl bg-[#111218] border border-white/8 shadow-xl"
                    >
                        <p className="px-3 py-2 text-xs text-[#6B7280] uppercase tracking-wider">Suggestions</p>
                        {suggestions.map((suggestion, i) => (
                            <motion.button
                                key={i}
                                type="button"
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    applySuggestion(suggestion);
                                }}
                                onClick={() => applySuggestion(suggestion)}
                                className="w-full text-left px-3 py-2 rounded-lg text-sm text-[#9CA3AF] hover:text-[#E6E6EB] hover:bg-white/5 transition-colors"
                                whileHover={{ x: 4 }}
                            >
                                {suggestion}
                            </motion.button>
                        ))}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
