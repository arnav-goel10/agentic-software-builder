"use client";

import * as React from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
    Home,
    FolderKanban,
    Bot,
    ChevronRight,
    Sparkles,
    Terminal,
} from "lucide-react";
import { LogoMark } from "./logo";
import { cn } from "@/lib/utils";

const navItems = [
    { id: "home", label: "Home", icon: Home, href: "/" },
    { id: "sandbox", label: "Sandbox", icon: Terminal, href: "/sandbox" },
    { id: "projects", label: "Projects", icon: FolderKanban, href: "/projects" },
    { id: "agents", label: "Agents", icon: Bot, href: "/agents" },
];

interface SidebarProps {
    activeItem?: string;
}

export function Sidebar({ activeItem = "home" }: SidebarProps) {
    const [isExpanded, setIsExpanded] = React.useState(false);

    return (
        <motion.aside
            className="fixed left-0 top-0 z-40 h-screen"
            onMouseEnter={() => setIsExpanded(true)}
            onMouseLeave={() => setIsExpanded(false)}
            initial={false}
            animate={{ width: isExpanded ? 240 : 72 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
        >
            {/* Background */}
            <div className="absolute inset-0 bg-[#0B0B0F] border-r border-white/6" />

            {/* Gradient overlay */}
            <div className="absolute inset-0 bg-gradient-to-b from-purple-500/5 via-transparent to-transparent opacity-50" />

            <div className="relative h-full flex flex-col py-4">
                {/* Logo */}
                <div className="px-4 mb-6 flex items-center h-12">
                    <LogoMark />
                    <AnimatePresence>
                        {isExpanded && (
                            <motion.span
                                initial={{ opacity: 0, x: -10 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -10 }}
                                transition={{ duration: 0.15 }}
                                className="ml-3 text-lg font-semibold tracking-tight text-[#E6E6EB] whitespace-nowrap"
                            >
                                Dexter
                            </motion.span>
                        )}
                    </AnimatePresence>
                </div>

                {/* Main Navigation */}
                <nav className="flex-1 px-3 space-y-1">
                    {navItems.map((item) => (
                        <NavItem
                            key={item.id}
                            item={item}
                            isExpanded={isExpanded}
                            isActive={activeItem === item.id}
                        />
                    ))}
                </nav>

                {/* Divider */}
                <div className="mx-4 my-4 h-px bg-white/6" />

                {/* User Section */}
                <div className="px-3 pt-4 border-t border-white/6 mx-3 mt-2">
                    <motion.div
                        className={cn(
                            "flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors",
                            "hover:bg-white/5"
                        )}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                    >
                        {/* Avatar */}
                        <div className="relative">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-purple-500 flex items-center justify-center text-white text-sm font-medium">
                                A
                            </div>
                            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-[#0B0B0F]" />
                        </div>

                        <AnimatePresence>
                            {isExpanded && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="flex-1 min-w-0"
                                >
                                    <p className="text-sm font-medium text-[#E6E6EB] truncate">Alex Chen</p>
                                    <p className="text-xs text-[#6B7280] truncate">Pro workspace</p>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {isExpanded && (
                            <ChevronRight className="w-4 h-4 text-[#6B7280]" />
                        )}
                    </motion.div>
                </div>

                {/* Upgrade Banner (collapsed = icon, expanded = full) */}
                <AnimatePresence>
                    {isExpanded && (
                        <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="px-3 pt-3"
                        >
                            <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500/10 to-cyan-500/10 border border-purple-500/20">
                                <div className="flex items-center gap-2 mb-2">
                                    <Sparkles className="w-4 h-4 text-purple-400" />
                                    <span className="text-sm font-medium text-[#E6E6EB]">Upgrade to Pro</span>
                                </div>
                                <p className="text-xs text-[#9CA3AF]">Unlock unlimited builds</p>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

        </motion.aside>
    );
}

interface NavItemProps {
    item: {
        id: string;
        label: string;
        icon: React.ComponentType<{ className?: string }>;
        href: string;
    };
    isExpanded: boolean;
    isActive: boolean;
}

function NavItem({ item, isExpanded, isActive }: NavItemProps) {
    const Icon = item.icon;

    return (
        <Link href={item.href} prefetch={false}>
            <motion.div
                className={cn(
                    "relative flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors overflow-hidden",
                    isActive
                        ? "bg-white/8 text-[#E6E6EB]"
                        : "text-[#9CA3AF] hover:text-[#E6E6EB] hover:bg-white/5"
                )}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
            >
                {/* Active indicator */}
                {isActive && (
                    <motion.div
                        layoutId="activeTab"
                        className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 rounded-full bg-gradient-to-b from-[#6366F1] to-[#A855F7]"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    />
                )}

                <Icon className={cn("w-5 h-5 shrink-0", isActive && "text-purple-400")} />

                <AnimatePresence>
                    {isExpanded && (
                        <motion.span
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -10 }}
                            transition={{ duration: 0.15 }}
                            className="text-sm font-medium whitespace-nowrap"
                        >
                            {item.label}
                        </motion.span>
                    )}
                </AnimatePresence>
            </motion.div>
        </Link>
    );
}
