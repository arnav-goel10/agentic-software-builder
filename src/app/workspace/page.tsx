"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { AgentConsole } from "@/components/agent-console";
import { PreviewFrame } from "@/components/preview-frame";
import { PropertiesPanel } from "@/components/properties-panel";
import { WorkspaceToolbar } from "@/components/top-nav";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function WorkspacePage() {
    return (
        <div className="h-screen bg-[#0B0B0F] overflow-hidden flex flex-col">
            {/* Floating Toolbar */}
            <WorkspaceToolbar projectName="Fintech Dashboard" />

            {/* Back button */}
            <Link href="/">
                <motion.button
                    className="fixed top-5 left-5 z-50 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#111218]/80 backdrop-blur-sm border border-white/10 text-sm text-[#9CA3AF] hover:text-[#E6E6EB] transition-colors"
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                >
                    <ArrowLeft className="w-4 h-4" />
                    Back
                </motion.button>
            </Link>

            {/* Main workspace area */}
            <div className="flex-1 flex pt-16 overflow-hidden">
                {/* Left: Agent Console */}
                <motion.div
                    initial={{ x: -20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ duration: 0.4, delay: 0.1 }}
                    className="w-[320px] flex-shrink-0"
                >
                    <AgentConsole />
                </motion.div>

                {/* Center: Preview Frame */}
                <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.4, delay: 0.2 }}
                    className="flex-1 border-l border-white/6"
                >
                    <PreviewFrame />
                </motion.div>

                {/* Right: Properties Panel */}
                <motion.div
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    transition={{ duration: 0.4, delay: 0.3 }}
                >
                    <PropertiesPanel />
                </motion.div>
            </div>
        </div>
    );
}
