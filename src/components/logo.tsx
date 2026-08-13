"use client";

import * as React from "react";
import { motion } from "framer-motion";

export function Logo({ size = "default" }: { size?: "small" | "default" | "large" }) {
    const sizes = {
        small: { wrapper: "w-7 h-7", inner: "w-3.5 h-3.5" },
        default: { wrapper: "w-9 h-9", inner: "w-4 h-4" },
        large: { wrapper: "w-12 h-12", inner: "w-5 h-5" },
    };

    return (
        <div className="flex items-center gap-3">
            <motion.div
                className={`relative ${sizes[size].wrapper} rounded-xl bg-gradient-to-br from-[#6366F1] via-[#8B5CF6] to-[#A855F7] p-[1px] shadow-lg shadow-purple-500/20`}
                whileHover={{ scale: 1.05 }}
                transition={{ type: "spring", stiffness: 400, damping: 17 }}
            >
                <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-[#6366F1] via-[#8B5CF6] to-[#A855F7] opacity-60 blur-lg" />
                <div className="relative h-full w-full rounded-xl bg-[#0B0B0F] flex items-center justify-center">
                    {/* Animated inner glyph */}
                    <motion.div
                        className={`${sizes[size].inner} relative`}
                        animate={{
                            rotate: [0, 180, 360],
                        }}
                        transition={{
                            duration: 20,
                            repeat: Infinity,
                            ease: "linear",
                        }}
                    >
                        {/* Hexagon shape */}
                        <svg viewBox="0 0 24 24" fill="none" className="w-full h-full">
                            <motion.path
                                d="M12 2L21.5 7.5V16.5L12 22L2.5 16.5V7.5L12 2Z"
                                stroke="url(#gradient)"
                                strokeWidth="1.5"
                                fill="none"
                                initial={{ pathLength: 0 }}
                                animate={{ pathLength: 1 }}
                                transition={{ duration: 2, repeat: Infinity, repeatType: "reverse" }}
                            />
                            <defs>
                                <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" stopColor="#6366F1" />
                                    <stop offset="50%" stopColor="#8B5CF6" />
                                    <stop offset="100%" stopColor="#A855F7" />
                                </linearGradient>
                            </defs>
                        </svg>
                    </motion.div>

                    {/* Center dot pulse */}
                    <motion.div
                        className="absolute w-1.5 h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-purple-400"
                        animate={{
                            scale: [1, 1.2, 1],
                            opacity: [0.8, 1, 0.8],
                        }}
                        transition={{
                            duration: 2,
                            repeat: Infinity,
                            ease: "easeInOut",
                        }}
                    />
                </div>
            </motion.div>

            <span className="text-lg font-semibold tracking-tight text-[#E6E6EB]">
                Dexter
            </span>
        </div>
    );
}

// Compact version for sidebar
export function LogoMark() {
    return (
        <motion.div
            className="relative w-9 h-9 rounded-xl bg-gradient-to-br from-[#6366F1] via-[#8B5CF6] to-[#A855F7] p-[1px] shadow-lg shadow-purple-500/20"
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400, damping: 17 }}
        >
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-[#6366F1] via-[#8B5CF6] to-[#A855F7] opacity-40 blur-md" />
            <div className="relative h-full w-full rounded-xl bg-[#0B0B0F] flex items-center justify-center">
                <motion.div
                    animate={{
                        rotate: [0, 360],
                    }}
                    transition={{
                        duration: 20,
                        repeat: Infinity,
                        ease: "linear",
                    }}
                >
                    <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4">
                        <path
                            d="M12 2L21.5 7.5V16.5L12 22L2.5 16.5V7.5L12 2Z"
                            stroke="url(#gradient-mark)"
                            strokeWidth="1.5"
                            fill="none"
                        />
                        <defs>
                            <linearGradient id="gradient-mark" x1="0%" y1="0%" x2="100%" y2="100%">
                                <stop offset="0%" stopColor="#6366F1" />
                                <stop offset="50%" stopColor="#8B5CF6" />
                                <stop offset="100%" stopColor="#A855F7" />
                            </linearGradient>
                        </defs>
                    </svg>
                </motion.div>
                <motion.div
                    className="absolute w-1.5 h-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-purple-400"
                    animate={{
                        scale: [1, 1.3, 1],
                        opacity: [0.7, 1, 0.7],
                    }}
                    transition={{
                        duration: 2,
                        repeat: Infinity,
                        ease: "easeInOut",
                    }}
                />
            </div>
        </motion.div>
    );
}
