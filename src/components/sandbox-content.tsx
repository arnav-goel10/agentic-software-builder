"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { SandboxAgentPanel } from "@/components/sandbox-agent-panel";
import { SandboxToolbar } from "@/components/sandbox-toolbar";
import { useProjectAgent } from "@/lib/use-project-agent";
import { PreviewFrame } from "@/components/preview-frame";

export default function SandboxContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");

  const {
    activeProject,
    currentFiles,
    error,
    isRunning,
    messages,
    currentRun,
    runHistory,
    createProjectFromPrompt,
    restoreSnapshot,
    sendMessage,
    snapshots,
    steps,
  } = useProjectAgent({ initialProjectId: projectId });

  const router = useRouter();

  const handleSendMessage = React.useCallback(
    async (content: string) => {
      if (activeProject) {
        await sendMessage(content);
        return;
      }

      const created = await createProjectFromPrompt(content);
      router.push(`/sandbox?projectId=${created.projectId}`);
    },
    [activeProject, createProjectFromPrompt, router, sendMessage]
  );

  return (
    <div className="h-screen bg-[#0B0B0F] overflow-hidden flex relative font-sans text-zinc-200">
      {/* Global Futuristic Background Decor */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {/* Radial Grid Pattern */}
        <div className="absolute inset-0 opacity-[0.03]"
          style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '48px 48px' }} />

        {/* Subtle Glows */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-500/5 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-cyan-500/5 blur-[120px] rounded-full" />
      </div>

      <Sidebar activeItem="sandbox" />

      <main className="flex-1 flex flex-col pl-[72px] relative z-10">
        <SandboxToolbar
          projectName={activeProject?.name ?? "Untitled Sandbox"}
        />

        <div className="flex-1 flex overflow-hidden">
          <motion.div
            initial={{ x: -20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
            className="z-10"
          >
            <SandboxAgentPanel
              projectName={activeProject?.name ?? "Select a project"}
              messages={messages}
              currentRun={currentRun}
              runHistory={runHistory}
              steps={steps}
              snapshots={snapshots}
              isRunning={isRunning}
              error={error}
              onSendMessage={handleSendMessage}
              onRestoreSnapshot={restoreSnapshot}
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
            className="flex-1 relative z-0"
          >
            <div className="h-full relative z-0 border-l border-white/10 glass-panel">
              <PreviewFrame
                files={currentFiles}
                projectId={activeProject?.id ?? projectId}
                autoMountEnabled={!isRunning}
                autoRunEnabled={snapshots.length > 0}
              />
            </div>
          </motion.div>
        </div>
      </main>
    </div>
  );
}
