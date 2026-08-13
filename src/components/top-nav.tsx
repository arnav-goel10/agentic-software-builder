"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Search, Bell, CreditCard, ChevronDown } from "lucide-react";
import { Logo } from "./logo";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

interface TopNavProps {
    variant?: "home" | "workspace";
    projectName?: string;
}

export function TopNav({ variant = "home", projectName }: TopNavProps) {
    const [isSearchFocused, setIsSearchFocused] = React.useState(false);

    return (
        <header className="fixed top-0 left-[72px] right-0 z-30 h-16">
            {/* Background with subtle blur */}
            <div className="absolute inset-0 bg-[#0B0B0F]/80 backdrop-blur-xl border-b border-white/6" />

            <div className="relative h-full px-6 flex items-center justify-between">
                {/* Left section */}
                <div className="flex items-center gap-4">
                    {variant === "home" ? (
                        <Logo />
                    ) : (
                        <div className="flex items-center gap-3">
                            <h1 className="text-sm font-medium text-[#E6E6EB]">{projectName}</h1>
                            <span className="px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/20">
                                Live
                            </span>
                        </div>
                    )}
                </div>

                {/* Center - Global Search (Home variant) */}
                {variant === "home" && (
                    <motion.div
                        className={cn(
                            "absolute left-1/2 -translate-x-1/2 w-full max-w-lg",
                            "transition-all duration-300"
                        )}
                        animate={{ scale: isSearchFocused ? 1.02 : 1 }}
                    >
                        <div
                            className={cn(
                                "relative flex items-center gap-3 px-4 py-2.5 rounded-xl",
                                "bg-[#111218] border transition-all duration-200",
                                isSearchFocused
                                    ? "border-purple-500/50 shadow-lg shadow-purple-500/10"
                                    : "border-white/8 hover:border-white/12"
                            )}
                        >
                            <Search className="w-4 h-4 text-[#6B7280]" />
                            <input
                                type="text"
                                placeholder="What do you want to build today?"
                                className="flex-1 bg-transparent border-none outline-none text-sm text-[#E6E6EB] placeholder:text-[#6B7280]"
                                onFocus={() => setIsSearchFocused(true)}
                                onBlur={() => setIsSearchFocused(false)}
                            />
                            <kbd className="hidden sm:flex items-center gap-1 px-2 py-1 rounded-md bg-white/5 text-[10px] text-[#6B7280] font-mono">
                                <span>⌘</span>
                                <span>K</span>
                            </kbd>
                        </div>
                    </motion.div>
                )}

                {/* Right section */}
                <div className="flex items-center gap-2">
                    {/* Credits */}
                    <Button variant="ghost" size="sm" className="gap-2">
                        <CreditCard className="w-4 h-4" />
                        <span className="text-sm">1,250</span>
                    </Button>

                    {/* Notifications */}
                    <Button variant="ghost" size="icon-sm" className="relative">
                        <Bell className="w-4 h-4" />
                        <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-purple-500" />
                    </Button>

                    {/* Profile */}
                    <motion.button
                        className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-cyan-400 to-purple-500 flex items-center justify-center text-white text-xs font-medium">
                            A
                        </div>
                        <ChevronDown className="w-3 h-3 text-[#6B7280]" />
                    </motion.button>
                </div>
            </div>
        </header>
    );
}

// Floating toolbar for workspace
export function WorkspaceToolbar({ projectName = "My Project" }: { projectName?: string }) {
    return (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50">
            <motion.div
                className="flex items-center gap-4 px-4 py-2 rounded-2xl glass-strong shadow-xl"
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
                {/* Project name */}
                <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span className="text-sm font-medium text-[#E6E6EB]">{projectName}</span>
                </div>

                {/* Divider */}
                <div className="w-px h-5 bg-white/10" />

                {/* Environment badge */}
                <div className="flex items-center gap-2">
                    <button className="px-3 py-1 rounded-lg bg-emerald-500/15 text-emerald-400 text-xs font-medium border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors">
                        Live
                    </button>
                    <button className="px-3 py-1 rounded-lg text-[#9CA3AF] text-xs font-medium hover:bg-white/5 transition-colors">
                        Staging
                    </button>
                </div>

                {/* Divider */}
                <div className="w-px h-5 bg-white/10" />

                {/* Deploy button */}
                <Button size="sm" className="gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Deploy
                </Button>
            </motion.div>
        </div>
    );
}
