"use client";

import * as React from "react";
import { FileCode, Loader2, RotateCcw, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileExplorer } from "@/components/FileExplorer";
import { CodeEditor } from "@/components/CodeEditor";
import type { GeneratedFile } from "@/lib/webcontainer-utils";

interface FilesPanelProps {
    files: GeneratedFile[];
    projectId?: string | null;
}

function resolveEditorLanguage(pathName: string): string {
    const lower = pathName.toLowerCase();
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass")) return "css";
    if (lower.endsWith(".html")) return "html";
    if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
        return "javascript";
    }
    if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".mts") || lower.endsWith(".cts")) {
        return "typescript";
    }
    return "plaintext";
}

export function FilesPanel({ files, projectId = null }: FilesPanelProps) {
    const [localFiles, setLocalFiles] = React.useState<GeneratedFile[]>(files);
    const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);
    const [isResetting, setIsResetting] = React.useState(false);

    React.useEffect(() => {
        setLocalFiles(files);
    }, [files]);

    const activeFileContent = React.useMemo(() => {
        if (!selectedFile) return "";
        return localFiles.find((file) => file.name === selectedFile)?.code ?? "";
    }, [localFiles, selectedFile]);

    const handleFileChange = React.useCallback(
        (value: string | undefined) => {
            if (!selectedFile || value === undefined) return;
            setLocalFiles((prev) => prev.map((file) => (file.name === selectedFile ? { ...file, code: value } : file)));
        },
        [selectedFile]
    );

    const handleSaveFile = React.useCallback(async () => {
        if (!selectedFile || !projectId) return;
        const file = localFiles.find((f) => f.name === selectedFile);
        if (!file) return;

        setIsSaving(true);
        try {
            await fetch(`/api/projects/${projectId}/files/save`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: file.name, content: file.code }),
            });
        } catch (err) {
            console.error("Failed to save file", err);
        } finally {
            setIsSaving(false);
        }
    }, [localFiles, projectId, selectedFile]);

    const handleResetFiles = React.useCallback(async () => {
        if (!projectId) return;
        if (!confirm("Revert all changes to the last checkpoint? This cannot be undone.")) return;

        setIsResetting(true);
        try {
            const res = await fetch(`/api/projects/${projectId}/files/reset`, { method: "POST" });
            if (res.ok) {
                window.location.reload();
            }
        } catch (err) {
            console.error("Failed to reset files", err);
            setIsResetting(false);
        }
    }, [projectId]);

    return (
        <div className="flex h-full">
            <div className="flex w-56 shrink-0 flex-col border-r border-black/[0.08] bg-[#fafafa]">
                <div className="border-b border-black/[0.06] px-3 py-2.5">
                    <p className="text-label">Explorer</p>
                </div>
                <FileExplorer
                    files={localFiles}
                    onSelect={setSelectedFile}
                    selectedPath={selectedFile ?? undefined}
                    className="flex-1 text-[#3a3a3c]"
                />
            </div>

            <div className="flex flex-1 flex-col bg-[#1e1e1e]">
                <div className="flex items-center gap-2 border-b border-white/10 bg-[#181818] px-3 py-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-white/60">
                        {selectedFile ?? "No file selected"}
                    </span>
                    <button
                        type="button"
                        onClick={() => void handleSaveFile()}
                        disabled={!selectedFile || !projectId || isSaving}
                        className={cn(
                            "flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                            "bg-[#0071e3]/15 text-[#4da3ff] hover:bg-[#0071e3]/25 disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                    >
                        {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Save
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleResetFiles()}
                        disabled={!projectId || isResetting}
                        className={cn(
                            "flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[11.5px] font-medium transition-colors",
                            "bg-white/[0.06] text-white/60 hover:bg-white/[0.1] hover:text-white/80 disabled:opacity-40 disabled:cursor-not-allowed"
                        )}
                    >
                        {isResetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        Reset
                    </button>
                </div>

                {selectedFile ? (
                    <CodeEditor code={activeFileContent} language={resolveEditorLanguage(selectedFile)} onChange={handleFileChange} />
                ) : (
                    <div className="flex flex-1 flex-col items-center justify-center text-white/30">
                        <FileCode className="mb-3 h-10 w-10" />
                        <p className="text-[13px]">Select a file to view or edit</p>
                    </div>
                )}
            </div>
        </div>
    );
}
