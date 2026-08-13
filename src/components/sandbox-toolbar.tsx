"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
    Share,
    Rocket,
    Pencil
} from "lucide-react";

type SandboxToolbarProps = {
    projectName?: string;
};

export function SandboxToolbar({
    projectName: projectNameProp,
}: SandboxToolbarProps) {
    const [projectName, setProjectName] = React.useState(projectNameProp || "Untitled Sandbox");
    const [isEditing, setIsEditing] = React.useState(false);
    const [isVisible, setIsVisible] = React.useState(true);
    const hideTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
    const toolbarRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (projectNameProp && !isEditing) {
            setProjectName(projectNameProp);
        }
    }, [projectNameProp, isEditing]);

    React.useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            // Show toolbar when mouse is at the very top (within 20px)
            const shouldShow = e.clientY < 20;

            if (shouldShow) {
                setIsVisible(true);
                // Clear any hide timeout
                if (hideTimeoutRef.current) {
                    clearTimeout(hideTimeoutRef.current);
                    hideTimeoutRef.current = null;
                }
            } else if (!isEditing && isVisible) {
                // Start hide countdown when mouse moves away
                if (!hideTimeoutRef.current) {
                    hideTimeoutRef.current = setTimeout(() => {
                        setIsVisible(false);
                        hideTimeoutRef.current = null;
                    }, 1500);
                }
            }
        };

        window.addEventListener('mousemove', handleMouseMove);

        // Initial hide after 3 seconds
        const initialTimeout = setTimeout(() => {
            setIsVisible(false);
        }, 3000);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            clearTimeout(initialTimeout);
            if (hideTimeoutRef.current) {
                clearTimeout(hideTimeoutRef.current);
            }
        };
    }, [isEditing, isVisible]);

    return (
        <>
            <motion.div
                ref={toolbarRef}
                initial={{ y: -20, opacity: 0 }}
                animate={{
                    y: isVisible ? 0 : -80,
                    opacity: isVisible ? 1 : 0
                }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 sm:gap-6 px-4 sm:px-6 py-2.5 rounded-2xl bg-[#0B0B0F]/80 backdrop-blur-2xl border border-white/5 shadow-[0_4px_24px_rgba(0,0,0,0.6)] max-w-[95vw] sm:max-w-none group overflow-hidden"
                onMouseEnter={() => {
                    setIsVisible(true);
                    if (hideTimeoutRef.current) {
                        clearTimeout(hideTimeoutRef.current);
                        hideTimeoutRef.current = null;
                    }
                }}
            >
                {/* Tactical Highlight Glare */}
                <div className="absolute inset-0 bg-gradient-to-b from-white/[0.05] to-transparent pointer-events-none" />

                {/* L-Bracket Corner Accents with Glow */}
                <div className="absolute top-0 left-0 w-2.5 h-2.5 border-t-2 border-l-2 border-cyan-500/40 rounded-tl-xl shadow-[0_0_10px_rgba(34,211,238,0.2)]" />
                <div className="absolute bottom-0 right-0 w-2.5 h-2.5 border-b-2 border-r-2 border-cyan-500/40 rounded-br-xl shadow-[0_0_10px_rgba(34,211,238,0.2)]" />

                {/* Project Info */}
                <div className="relative flex items-center gap-3 sm:gap-4 min-w-0 z-10">
                    <div className="relative flex items-center gap-2.5 min-w-0">
                        <div className="w-2 h-2 rounded-full bg-cyan-500/20 flex items-center justify-center">
                            <div className="w-1 h-1 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
                        </div>
                        {isEditing ? (
                            <input
                                autoFocus
                                value={projectName}
                                onChange={(e) => setProjectName(e.target.value)}
                                onBlur={() => setIsEditing(false)}
                                onKeyDown={(e) => e.key === "Enter" && setIsEditing(false)}
                                className="bg-white/5 border border-white/10 rounded px-2 py-0.5 text-sm font-medium text-[#E6E6EB] outline-none w-32 sm:w-48 focus:border-cyan-500/50 transition-colors font-mono"
                            />
                        ) : (
                            <button
                                onClick={() => setIsEditing(true)}
                                className="text-sm font-semibold text-[#E6E6EB] hover:text-cyan-400 transition-all flex items-center gap-2 min-w-0 group/name"
                            >
                                <span className="truncate max-w-[120px] sm:max-w-[320px] tracking-tight">{projectName}</span>
                                <Pencil className="w-3 h-3 text-white/20 group-hover/name:text-cyan-400 transition-colors flex-shrink-0" />
                            </button>
                        )}
                    </div>

                    <div className="w-px h-5 bg-white/10 flex-shrink-0" />

                    <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-cyan-500/5 border border-cyan-500/20 flex-shrink-0">
                        <div className="flex gap-1">
                            <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse" />
                            <span className="w-1 h-1 rounded-full bg-cyan-400 animate-pulse delay-75" />
                        </div>
                        <span className="text-[10px] font-bold text-cyan-400/90 uppercase tracking-[0.15em] hidden xs:block font-mono">Development</span>
                    </div>
                </div>

                <div className="w-px h-5 bg-white/10 flex-shrink-0 z-10" />

                {/* Actions */}
                <div className="relative flex items-center gap-1 sm:gap-3 flex-shrink-0 z-10">
                    <button className="relative group/btn flex items-center gap-2 px-3 sm:px-4 py-1.5 rounded-xl text-xs font-bold text-white/60 hover:text-white transition-all hover:bg-white/5">
                        <Share className="w-3.5 h-3.5" />
                        <span className="hidden md:inline uppercase tracking-widest font-mono text-[10px]">Sync</span>
                    </button>

                    <button className="relative group/deploy flex items-center gap-2.5 px-4 sm:px-6 py-2 rounded-xl bg-cyan-500 text-[#0B0B0F] text-xs font-bold uppercase tracking-widest font-mono hover:scale-[1.02] active:scale-95 transition-all shadow-[0_4px_12px_rgba(34,211,238,0.4)] hover:shadow-[0_0_24px_rgba(34,211,238,0.5)]">
                        <Rocket className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Initialize</span>

                        {/* Shimmer effect */}
                        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover/deploy:translate-x-full transition-transform duration-1000" />
                    </button>
                </div>
            </motion.div>

            {/* Hover hint indicator when toolbar is hidden (Narrower to prevent edge glow) */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: isVisible ? 0 : 0.6 }}
                transition={{ duration: 0.3 }}
                className="absolute top-0 left-1/2 -translate-x-1/2 w-16 h-[1.5px] bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent rounded-b-full pointer-events-none shadow-[0_1px_6px_rgba(34,211,238,0.3)]"
            />
        </>
    );
}
