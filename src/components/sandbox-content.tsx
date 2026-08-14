"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { TopBar } from "@/components/top-bar";
import { PhaseTimeline } from "@/components/phase-timeline";
import { ActivityPanel } from "@/components/activity-panel";
import { FilesPanel } from "@/components/files-panel";
import { RunDetailsPanel } from "@/components/run-details-panel";
import { PreviewFrame } from "@/components/preview-frame";
import { useProjectAgent } from "@/lib/use-project-agent";

const RUN_ACTIVE_STATUSES = new Set(["queued", "planning", "executing", "validating", "repairing"]);

export default function SandboxContent() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId");
  const router = useRouter();

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
    artifacts,
    hasProject,
  } = useProjectAgent({ initialProjectId: projectId });

  const [activeTab, setActiveTab] = React.useState<"activity" | "files" | "preview">("activity");
  const [detailsCollapsed, setDetailsCollapsed] = React.useState(false);

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

  const runStatusPill = currentRun ? (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        currentRun.status === "completed"
          ? "border-[#1a7f37]/20 bg-[#1a7f37]/10 text-[#1a7f37]"
          : currentRun.status === "failed" || currentRun.status === "cancelled"
            ? "border-[#d1242f]/20 bg-[#d1242f]/10 text-[#d1242f]"
            : RUN_ACTIVE_STATUSES.has(currentRun.status)
              ? "border-[#0071e3]/20 bg-[#0071e3]/10 text-[#0071e3]"
              : "border-black/[0.08] bg-black/[0.03] text-[#6e6e73]"
      )}
    >
      {currentRun.status}
    </span>
  ) : null;

  return (
    <div className="flex h-screen flex-col bg-[#fafafa]">
      <TopBar
        variant="app"
        title={activeProject?.name ?? "New build"}
        titleAdornment={runStatusPill}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: phase timeline */}
        <aside className="hidden w-[220px] shrink-0 border-r border-black/[0.08] bg-white md:block">
          <PhaseTimeline steps={steps} currentRun={currentRun} isRunning={isRunning} />
        </aside>

        {/* Center: tabbed Activity / Files / Preview */}
        <Tabs.Root
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as typeof activeTab)}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <div className="flex items-center border-b border-black/[0.08] bg-white px-4">
            <Tabs.List className="flex items-center gap-1 py-2" aria-label="Workspace views">
              {(["activity", "files", "preview"] as const).map((tab) => (
                <Tabs.Trigger
                  key={tab}
                  value={tab}
                  className={cn(
                    "rounded-[8px] px-3 py-1.5 text-[13px] font-medium capitalize transition-colors",
                    "text-[#86868b] hover:text-[#1d1d1f] data-[state=active]:bg-[#f5f5f7] data-[state=active]:text-[#1d1d1f]"
                  )}
                >
                  {tab}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>

          {/*
            forceMount + data-state visibility (rather than Radix's default
            unmount-on-inactive) keeps Files edits and the Preview tab's
            WebContainer/dev-server session alive when switching tabs.
          */}
          <Tabs.Content
            value="activity"
            forceMount
            className="min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden data-[state=active]:flex"
          >
            <ActivityPanel
              messages={messages}
              currentRun={currentRun}
              runHistory={runHistory}
              steps={steps}
              snapshots={snapshots}
              isRunning={isRunning}
              error={error}
              hasProject={hasProject}
              onSendMessage={handleSendMessage}
              onRestoreSnapshot={restoreSnapshot}
            />
          </Tabs.Content>

          <Tabs.Content
            value="files"
            forceMount
            className="min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden data-[state=active]:flex"
          >
            <FilesPanel files={currentFiles} projectId={activeProject?.id ?? projectId} />
          </Tabs.Content>

          <Tabs.Content
            value="preview"
            forceMount
            className="min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden data-[state=active]:flex"
          >
            <PreviewFrame
              files={currentFiles}
              projectId={activeProject?.id ?? projectId}
              autoMountEnabled={!isRunning}
              autoRunEnabled={snapshots.length > 0}
            />
          </Tabs.Content>
        </Tabs.Root>

        {/* Right: collapsible run details */}
        <RunDetailsPanel
          currentRun={currentRun}
          steps={steps}
          artifacts={artifacts}
          messages={messages}
          collapsed={detailsCollapsed}
          onToggleCollapsed={() => setDetailsCollapsed((prev) => !prev)}
        />
      </div>
    </div>
  );
}
