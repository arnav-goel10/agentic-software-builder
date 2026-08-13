"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Monitor,
    Tablet,
    Smartphone,
    Terminal as TerminalIcon,
    Eye,
    Play,
    Loader2,
    Bot,
    ExternalLink,
    Maximize2,
    Minimize2,
    X,
    FileCode,
    Save,
    RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWebContainer } from "@/hooks/use-web-container";
import { GeneratedFile } from "@/lib/webcontainer-utils";
import { createPortal } from "react-dom";
import type { Terminal } from "xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";
import { FileExplorer } from "@/components/FileExplorer";
import { CodeEditor } from "@/components/CodeEditor";

type ViewMode = "preview" | "terminal" | "split" | "files";
type DeviceMode = "desktop" | "tablet" | "mobile";

interface PreviewFrameProps {
    files?: GeneratedFile[];
    projectId?: string | null;
    autoMountEnabled?: boolean;
    autoRunEnabled?: boolean;
}

const DEPENDENCY_MANIFEST_FILES = new Set([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
]);

function hashStringFnv1a(input: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function createFilesSignature(files: GeneratedFile[]): string {
    const sorted = [...files].sort((left, right) => left.name.localeCompare(right.name));
    let hash = 0x811c9dc5;

    for (const file of sorted) {
        hash = hashStringFnv1a(`${hash}:${file.name}\n${file.language ?? ""}\n${file.code}`);
    }

    return hash.toString(16);
}

function createDependencySignature(files: GeneratedFile[]): string {
    const dependencyFiles = files.filter((file) => DEPENDENCY_MANIFEST_FILES.has(file.name));
    if (dependencyFiles.length === 0) {
        return "none";
    }
    return createFilesSignature(dependencyFiles);
}

function resolveEditorLanguage(pathName: string): string {
    const lower = pathName.toLowerCase();
    if (lower.endsWith(".json")) return "json";
    if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".sass")) return "css";
    if (lower.endsWith(".html")) return "html";
    if (
        lower.endsWith(".js") ||
        lower.endsWith(".jsx") ||
        lower.endsWith(".mjs") ||
        lower.endsWith(".cjs")
    ) {
        return "javascript";
    }
    if (
        lower.endsWith(".ts") ||
        lower.endsWith(".tsx") ||
        lower.endsWith(".mts") ||
        lower.endsWith(".cts")
    ) {
        return "typescript";
    }
    return "plaintext";
}

export function PreviewFrame({
    files = [],
    projectId = null,
    autoMountEnabled = true,
    autoRunEnabled = true,
}: PreviewFrameProps) {
    const frameRootRef = React.useRef<HTMLDivElement>(null);
    const immersiveRootRef = React.useRef<HTMLDivElement>(null);
    const [viewMode, setViewMode] = React.useState<ViewMode>("preview");
    const [deviceMode, setDeviceMode] = React.useState<DeviceMode>("desktop");
    const [isFullscreen, setIsFullscreen] = React.useState(false);
    const [isImmersivePreview, setIsImmersivePreview] = React.useState(false);
    const [portalRoot, setPortalRoot] = React.useState<HTMLElement | null>(null);
    const terminalRef = React.useRef<HTMLDivElement>(null);
    const xtermRef = React.useRef<Terminal | null>(null);
    const fitAddonRef = React.useRef<FitAddon | null>(null);
    const mountedFilesSignatureRef = React.useRef<string>("");
    const installedDependencySignatureRef = React.useRef<string>("");
    const autoRunStartedRef = React.useRef(false);
    const runInFlightRef = React.useRef(false);
    const activeProjectIdRef = React.useRef<string | null>(null);

    // File Editor State
    const [localFiles, setLocalFiles] = React.useState<GeneratedFile[]>(files);
    const [selectedFile, setSelectedFile] = React.useState<string | null>(null);
    const [isSaving, setIsSaving] = React.useState(false);
    const [isResetting, setIsResetting] = React.useState(false);

    React.useEffect(() => {
        setLocalFiles(files);
    }, [files]);

    const activeFileContent = React.useMemo(() => {
        if (!selectedFile) return "";
        const file = localFiles.find((f) => f.name === selectedFile);
        return file?.code ?? "";
    }, [localFiles, selectedFile]);

    const handleFileChange = React.useCallback((value: string | undefined) => {
        if (!selectedFile || value === undefined) return;
        setLocalFiles((prev) =>
            prev.map((f) => (f.name === selectedFile ? { ...f, code: value } : f))
        );
    }, [selectedFile]);

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
            // Ideally assume success for now, optimistic update already happened in localFiles
        } catch (err) {
            console.error("Failed to save file", err);
            // Revert? For now just log
        } finally {
            setIsSaving(false);
        }
    }, [localFiles, projectId, selectedFile]);

    const handleResetFiles = React.useCallback(async () => {
        if (!projectId) return;
        if (!confirm("Revert all changes to the last Agent checkpoint? This cannot be undone.")) return;

        setIsResetting(true);
        try {
            const res = await fetch(`/api/projects/${projectId}/files/reset`, {
                method: "POST",
            });
            if (res.ok) {
                window.location.reload(); // Hard reload to fetch fresh state
            }
        } catch (err) {
            console.error("Failed to reset files", err);
            setIsResetting(false);
        }
    }, [projectId]);

    const { container, status, url, error, boot, mount, install, startDev, stopDev } = useWebContainer();

    React.useEffect(() => {
        const normalizedProjectId = projectId ?? null;
        if (activeProjectIdRef.current === normalizedProjectId) {
            return;
        }

        activeProjectIdRef.current = normalizedProjectId;
        autoRunStartedRef.current = false;
        mountedFilesSignatureRef.current = "";
        // Keep dependency install signature across project switches so we can skip reinstall
        // when lockfile/package manifests are effectively unchanged.
        setIframeLoaded(false);
        setIframeEmbedBlocked(false);
        void stopDev();
    }, [projectId, stopDev]);

    // Auto boot only when auto-run is allowed (manual Run still boots on demand).
    React.useEffect(() => {
        if (!autoRunEnabled || !autoMountEnabled) {
            return;
        }
        if (files.length > 0 && status === "idle") {
            void boot();
        }
    }, [autoMountEnabled, autoRunEnabled, files.length, status, boot]);

    // Initialize Terminal
    // Initialize Terminal eagerly (regardless of viewMode) so auto-run output is captured
    const terminalInitializedRef = React.useRef(false);
    React.useEffect(() => {
        if (terminalInitializedRef.current || xtermRef.current) return;
        if (!terminalRef.current) return;
        terminalInitializedRef.current = true;

        const initTerminal = async () => {
            try {
                const { Terminal } = await import("xterm");
                const { FitAddon } = await import("@xterm/addon-fit");

                const term = new Terminal({
                    theme: {
                        background: '#0B0B0F',
                        foreground: '#E6E6EB',
                        cursor: '#E6E6EB',
                        selectionBackground: '#5B4E7A',
                    },
                    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
                    fontSize: 12,
                    rows: 24,
                });

                const fitAddon = new FitAddon();
                term.loadAddon(fitAddon);

                if (terminalRef.current) {
                    term.open(terminalRef.current);
                    // Only fit if visible, otherwise defer
                    if (terminalRef.current.offsetHeight > 0) {
                        fitAddon.fit();
                    }
                }

                xtermRef.current = term;
                fitAddonRef.current = fitAddon;

                const handleResize = () => fitAddon.fit();
                window.addEventListener('resize', handleResize);
            } catch (err) {
                console.error("Failed to load xterm", err);
            }
        };

        void initTerminal();
    }, []);

    // Handle resize when switching back to terminal view
    React.useEffect(() => {
        if ((viewMode === "terminal" || viewMode === "split") && xtermRef.current && fitAddonRef.current) {
            // Slight delay to allow layout to settle
            setTimeout(() => {
                fitAddonRef.current?.fit();
            }, 100);
        }
    }, [viewMode, deviceMode]);

    const [iframeLoaded, setIframeLoaded] = React.useState(false);
    const [iframeEmbedBlocked, setIframeEmbedBlocked] = React.useState(false);
    const filesSignature = React.useMemo(() => createFilesSignature(files), [files]);
    const dependencySignature = React.useMemo(() => createDependencySignature(files), [files]);

    React.useEffect(() => {
        const onFullscreenChange = () => {
            setIsFullscreen(Boolean(document.fullscreenElement));
        };
        document.addEventListener("fullscreenchange", onFullscreenChange);
        return () => {
            document.removeEventListener("fullscreenchange", onFullscreenChange);
        };
    }, []);

    React.useEffect(() => {
        setPortalRoot(document.body);
    }, []);

    const handlePopout = React.useCallback(() => {
        if (!url) {
            return;
        }
        setViewMode("preview");
        setDeviceMode("desktop");
        setIsImmersivePreview(true);
    }, [url]);

    const handleOpenAppUrl = React.useCallback(() => {
        if (!url) {
            return;
        }
        window.open(url, "_blank", "noopener,noreferrer");
    }, [url]);

    const closeImmersivePreview = React.useCallback(() => {
        setIsImmersivePreview(false);
    }, []);

    React.useEffect(() => {
        if (!isImmersivePreview) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setIsImmersivePreview(false);
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [isImmersivePreview]);

    React.useEffect(() => {
        if (!url) {
            setIsImmersivePreview(false);
        }
    }, [url]);

    const handleFullscreenToggle = React.useCallback(async () => {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                return;
            }
            const target = isImmersivePreview ? immersiveRootRef.current : frameRootRef.current;
            if (target) {
                await target.requestFullscreen();
            }
        } catch {
            // Ignore unsupported/fullscreen errors.
        }
    }, [isImmersivePreview]);

    const renderPreviewContent = () => {
        if (!url) {
            return (
                <div className="flex flex-col items-center justify-center h-full text-zinc-500 gap-4">
                    <div className="p-4 rounded-full bg-zinc-100">
                        <Loader2 className={cn("w-8 h-8", (status === 'starting' || status === 'booting' || status === 'installing') && "animate-spin")} />
                    </div>
                    <p className="font-mono text-xs uppercase tracking-widest text-[#6B7280]">
                        {status === 'idle' ? 'Ready to launch project' :
                            status === 'error' ? `Error: ${error}` : 'Waiting for runtime...'}
                    </p>
                    <div className="flex gap-4">
                        <button onClick={handleRun} disabled={status !== 'ready'} className="text-[10px] font-bold uppercase tracking-widest text-cyan-500 hover:text-cyan-400 transition-colors">
                            [ BOOT_SEQUENCE ]
                        </button>
                        {(status === 'error' || status === 'installing' || status === 'starting') && (
                            <button onClick={() => window.location.reload()} className="text-[10px] font-bold uppercase tracking-widest text-red-500 hover:text-red-400 transition-colors">
                                [ HARD_RESET ]
                            </button>
                        )}
                    </div>
                </div>
            );
        }

        return (
            <div className="relative w-full h-full">
                <iframe
                    key={url}
                    src={url}
                    className="w-full h-full border-none"
                    title="Preview"
                    onLoad={() => {
                        setIframeLoaded(true);
                        setIframeEmbedBlocked(false);
                    }}
                />
                {!iframeLoaded && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-[1px] text-zinc-700 text-sm font-mono uppercase tracking-widest">
                        Synthesizing...
                    </div>
                )}
                {iframeEmbedBlocked && (
                    <div className="absolute left-3 right-3 bottom-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-200 backdrop-blur-md">
                        <div className="font-bold mb-1 uppercase tracking-tighter">Iframe Blocked</div>
                        <div className="opacity-70">Browser privacy settings may prevent embedding. Please check your browser security/privacy preferences.</div>
                    </div>
                )}
                {error && (
                    <div className="absolute top-3 left-3 right-3 rounded-md border border-red-500/40 bg-black/80 px-3 py-2 text-[10px] text-red-200 backdrop-blur-sm font-mono">
                        <div className="font-bold mb-1 uppercase tracking-tighter">Kernel Panic</div>
                        <div className="opacity-70 line-clamp-3">{error}</div>
                        <div className="flex gap-3 mt-2">
                            <button onClick={() => setViewMode("terminal")} className="text-cyan-400 font-bold hover:underline">VIEW_LOGS</button>
                            <button onClick={() => window.location.reload()} className="text-red-400 font-bold hover:underline">SYSTEM_RELOAD</button>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const runProject = React.useCallback(async (showTerminal: boolean) => {
        if (runInFlightRef.current) {
            return;
        }
        runInFlightRef.current = true;

        if (showTerminal) {
            setViewMode("terminal");
        }

        const term = xtermRef.current ?? undefined;

        try {
            const filesChanged = mountedFilesSignatureRef.current !== filesSignature;
            const shouldInstall = installedDependencySignatureRef.current !== dependencySignature;
            if (showTerminal) {
                term?.clear();
                term?.writeln('\x1b[34mMounting files...\x1b[0m');
            }

            const canReuseRunning =
                status === "running" &&
                !shouldInstall &&
                !filesChanged;

            // Prevent Vite HMR graph corruption on large/synthetic file swaps.
            if (status === "running" && !canReuseRunning) {
                await stopDev();
            }

            if (files.length > 0) {
                if (filesChanged) {
                    await mount(files);
                    mountedFilesSignatureRef.current = filesSignature;
                } else if (showTerminal) {
                    term?.writeln('\x1b[34mSkipping mount (snapshot unchanged)...\x1b[0m');
                }
            }

            if (canReuseRunning) {
                if (showTerminal) {
                    term?.writeln('\x1b[32mDev server already running; no reinstall/restart needed.\x1b[0m');
                }
                setViewMode("preview");
                return;
            }

            if (shouldInstall) {
                if (showTerminal) {
                    term?.writeln('\x1b[34mRunning npm install...\x1b[0m');
                }
                await install(term);
                installedDependencySignatureRef.current = dependencySignature;
            } else if (showTerminal) {
                term?.writeln('\x1b[34mSkipping npm install (dependencies unchanged)...\x1b[0m');
            }

            if (showTerminal) {
                term?.writeln('\x1b[34mStarting dev server...\x1b[0m');
            }
            await startDev(term);
            setViewMode("preview");
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            term?.writeln(`\x1b[31mError: ${message}\x1b[0m`);
        } finally {
            runInFlightRef.current = false;
        }
    }, [dependencySignature, files, filesSignature, install, mount, startDev, status, stopDev]);

    const handleRun = React.useCallback(() => {
        if (status === "idle") {
            void boot().then(() => void runProject(true));
        } else {
            void runProject(true);
        }
    }, [boot, runProject, status]);

    // Always mount changed files, even when the container is already running.
    React.useEffect(() => {
        if (!container || files.length === 0 || !autoMountEnabled) return;
        if (status === "idle" || status === "booting" || status === "installing" || status === "starting") {
            return;
        }
        if (mountedFilesSignatureRef.current === filesSignature) {
            return;
        }

        void mount(files)
            .then(() => {
                mountedFilesSignatureRef.current = filesSignature;
                xtermRef.current?.writeln('\x1b[32mFiles mounted/updated.\x1b[0m');
                if (installedDependencySignatureRef.current !== dependencySignature) {
                    xtermRef.current?.writeln(
                        '\x1b[33mDependency files changed. Click Run to reinstall before relying on new imports.\x1b[0m'
                    );
                }

                // Auto-prewarm preview on snapshot updates after initial run startup.
                // This avoids manual Run clicks for each completed agent run.
                if (autoRunEnabled && autoRunStartedRef.current) {
                    xtermRef.current?.writeln(
                        '\x1b[34mAuto-prewarming preview for updated snapshot...\x1b[0m'
                    );
                    void runProject(false);
                }
            })
            .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                xtermRef.current?.writeln(`\x1b[31mMount failed: ${message}\x1b[0m`);
            });
    }, [
        autoMountEnabled,
        autoRunEnabled,
        container,
        dependencySignature,
        files,
        filesSignature,
        mount,
        runProject,
        status,
    ]);

    // Auto-run once when files are available and a stable checkpoint exists.
    React.useEffect(() => {
        if (!autoRunEnabled || !autoMountEnabled) return;
        if (autoRunStartedRef.current) return;
        if (files.length === 0) return;
        if (status !== "ready") return;

        autoRunStartedRef.current = true;
        void runProject(false);
    }, [autoMountEnabled, autoRunEnabled, files.length, runProject, status]);

    // Track iframeLoaded in a ref so the timeout check doesn't cause a dep cycle
    const iframeLoadedRef = React.useRef(false);
    React.useEffect(() => {
        iframeLoadedRef.current = iframeLoaded;
    }, [iframeLoaded]);

    React.useEffect(() => {
        if (!url) {
            setIframeLoaded(false);
            setIframeEmbedBlocked(false);
            return;
        }

        setIframeLoaded(false);
        iframeLoadedRef.current = false;
        setIframeEmbedBlocked(false);

        const timer = window.setTimeout(() => {
            if (!iframeLoadedRef.current) {
                setIframeEmbedBlocked(true);
            }
        }, 7000);

        return () => {
            window.clearTimeout(timer);
        };
    }, [url]);

    return (
        <div ref={frameRootRef} className="flex flex-col h-full bg-[#0B0B0F]">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/6 gap-4">
                {/* View mode tabs */}
                <div className="flex items-center gap-1 p-1 rounded-lg bg-[#111218]">
                    <TabButton
                        active={viewMode === "preview"}
                        onClick={() => setViewMode("preview")}
                        icon={<Eye className="w-4 h-4" />}
                        label="Preview"
                    />
                    <TabButton
                        active={viewMode === "terminal"}
                        onClick={() => setViewMode("terminal")}
                        icon={<TerminalIcon className="w-4 h-4" />}
                        label="Terminal"
                    />
                    <TabButton
                        active={viewMode === "files"}
                        onClick={() => setViewMode("files")}
                        icon={<FileCode className="w-4 h-4" />}
                        label="Files"
                    />
                </div>

                {/* File Editor Controls */}
                {viewMode === "files" && (
                    <div className="flex items-center gap-2 mr-auto ml-4">
                        <button
                            onClick={handleSaveFile}
                            disabled={!selectedFile || isSaving}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 text-xs font-mono uppercase tracking-wider disabled:opacity-50 transition-colors border border-purple-500/20"
                        >
                            {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                            Save
                        </button>
                        <button
                            onClick={handleResetFiles}
                            disabled={isResetting}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-mono uppercase tracking-wider disabled:opacity-50 transition-colors border border-red-500/20"
                        >
                            {isResetting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                            Reset
                        </button>
                        {selectedFile && <span className="text-xs text-zinc-500 font-mono ml-2">{selectedFile}</span>}
                    </div>
                )}

                {/* Status & Controls */}
                <div className="flex items-center gap-3">
                    <div className={cn(
                        "flex items-center gap-2.5 px-3 py-1.5 rounded-full border backdrop-blur-md transition-all duration-500",
                        status === 'running' ? "bg-emerald-500/10 border-emerald-500/30 shadow-[0_0_15px_rgba(16,185,129,0.1)]" :
                            status === 'error' ? "bg-red-500/10 border-red-500/30 shadow-[0_0_15px_rgba(239,68,68,0.1)]" :
                                (status === 'booting' || status === 'installing' || status === 'starting') ? "bg-cyan-500/10 border-cyan-500/30 shadow-[0_0_15px_rgba(34,211,238,0.1)]" :
                                    "bg-white/5 border-white/10"
                    )}>
                        {(status === 'booting' || status === 'installing' || status === 'starting') && (
                            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                        )}
                        {status === 'running' && (
                            <div className="relative">
                                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                                <div className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-40" />
                            </div>
                        )}
                        {status === 'error' && <div className="w-2 h-2 rounded-full bg-red-500" />}
                        {status === 'ready' && <div className="w-2 h-2 rounded-full bg-white/20" />}

                        <span className={cn(
                            "text-[10px] font-mono font-bold uppercase tracking-widest",
                            status === 'running' ? "text-emerald-400" :
                                status === 'error' ? "text-red-400" :
                                    (status === 'booting' || status === 'installing' || status === 'starting') ? "text-cyan-400" :
                                        "text-white/40"
                        )}>
                            {status}
                        </span>
                    </div>

                    <button
                        onClick={handleRun}
                        disabled={status !== 'ready' && status !== 'error' && status !== 'running'}
                        className={cn(
                            "relative group/run flex items-center gap-2.5 px-4 py-1.5 rounded-lg text-[11px] font-mono font-bold uppercase tracking-widest transition-all overflow-hidden border",
                            status !== 'ready' && status !== 'error' && status !== 'running'
                                ? "bg-white/5 border-white/5 text-white/20 cursor-not-allowed"
                                : "bg-emerald-600 border-emerald-400/50 text-white shadow-[0_0_20px_rgba(16,185,129,0.3)] hover:shadow-[0_0_30px_rgba(16,185,129,0.5)] active:scale-95"
                        )}
                    >
                        <Play className={cn("w-3.5 h-3.5 fill-current transition-transform duration-300 group-hover/run:scale-110", status === 'running' && "animate-pulse")} />
                        <span>Run</span>

                        {/* Shimmer Effect */}
                        {status === 'ready' || status === 'error' || status === 'running' ? (
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover/run:translate-x-full transition-transform duration-1000" />
                        ) : null}
                    </button>
                </div>

                {/* Device toggles */}
                <div className="flex items-center gap-2">
                    <DeviceButton
                        active={deviceMode === "desktop"}
                        onClick={() => setDeviceMode("desktop")}
                        icon={<Monitor className="w-4 h-4" />}
                    />
                    <DeviceButton
                        active={deviceMode === "tablet"}
                        onClick={() => setDeviceMode("tablet")}
                        icon={<Tablet className="w-4 h-4" />}
                    />
                    <DeviceButton
                        active={deviceMode === "mobile"}
                        onClick={() => setDeviceMode("mobile")}
                        icon={<Smartphone className="w-4 h-4" />}
                    />
                    <DeviceButton
                        active={isImmersivePreview}
                        onClick={handlePopout}
                        icon={<Eye className="w-4 h-4" />}
                        title="Immersive Preview"
                        disabled={!url}
                    />
                    <DeviceButton
                        active={false}
                        onClick={handleOpenAppUrl}
                        icon={<ExternalLink className="w-4 h-4" />}
                        title="Open App URL in New Tab"
                        disabled={!url}
                    />
                    <DeviceButton
                        active={isFullscreen}
                        onClick={() => void handleFullscreenToggle()}
                        icon={
                            isFullscreen ? (
                                <Minimize2 className="w-4 h-4" />
                            ) : (
                                <Maximize2 className="w-4 h-4" />
                            )
                        }
                        title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                    />

                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {/* Setup Animation Overlay */}
                <AnimatePresence>
                    {(viewMode === "preview" && status !== "running" && status !== "idle" && !url) && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-[#0B0B0F]"
                        >
                            {/* 3D Quantum Core Container */}
                            <div className="relative w-72 h-72 flex items-center justify-center" style={{ perspective: "1000px" }}>
                                {/* Depth Glow Background */}
                                <div className="absolute inset-8 rounded-full bg-purple-600/10 blur-[60px] animate-pulse" />

                                {/* Orbital Ring - Outer (X-Axis) */}
                                <motion.div
                                    animate={{ rotateX: 360, rotateZ: 360 }}
                                    transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
                                    className="absolute inset-0 rounded-full border border-purple-500/30"
                                    style={{ transformStyle: "preserve-3d" }}
                                />

                                {/* Orbital Ring - Middle (Y-Axis) */}
                                <motion.div
                                    animate={{ rotateY: 360, rotateZ: -360 }}
                                    transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                                    className="absolute inset-4 rounded-full border border-cyan-500/20"
                                    style={{ transformStyle: "preserve-3d" }}
                                />

                                {/* Orbital Ring - Inner (Tilted) */}
                                <motion.div
                                    animate={{ rotateX: -360, rotateY: 360 }}
                                    transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
                                    className="absolute inset-8 rounded-full border border-white/10"
                                    style={{ transformStyle: "preserve-3d" }}
                                />

                                {/* Glowing Core Node */}
                                <motion.div
                                    animate={{
                                        scale: [1, 1.05, 1],
                                        boxShadow: [
                                            "0 0 30px rgba(168, 85, 247, 0.2)",
                                            "0 0 60px rgba(34, 211, 238, 0.4)",
                                            "0 0 30px rgba(168, 85, 247, 0.2)"
                                        ]
                                    }}
                                    transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                                    className={cn(
                                        "w-20 h-20 rounded-full flex items-center justify-center relative z-10",
                                        "bg-gradient-to-br from-purple-600/30 to-cyan-600/30 border border-white/20 backdrop-blur-sm"
                                    )}
                                >
                                    <Bot className="w-8 h-8 text-white/90" />

                                    {/* Core Energy Pulse */}
                                    <motion.div
                                        animate={{ scale: [1, 1.5, 1], opacity: [0.5, 0, 0.5] }}
                                        transition={{ duration: 2, repeat: Infinity }}
                                        className="absolute inset-0 rounded-full border border-cyan-400/40"
                                    />
                                </motion.div>

                                {/* Kinetic Particle Accents (locked to exact orbit paths) */}
                                <motion.div
                                    animate={{ rotateX: 360, rotateZ: 360 }}
                                    transition={{ duration: 12, repeat: Infinity, ease: "linear" }}
                                    className="absolute inset-0"
                                    style={{ transformStyle: "preserve-3d" }}
                                >
                                    <div className="absolute -top-[3px] left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-purple-500 shadow-[0_0_14px_rgba(168,85,247,0.95)]" />
                                </motion.div>
                                <motion.div
                                    animate={{ rotateY: 360, rotateZ: -360 }}
                                    transition={{ duration: 10, repeat: Infinity, ease: "linear" }}
                                    className="absolute inset-4"
                                    style={{ transformStyle: "preserve-3d" }}
                                >
                                    <div className="absolute -top-[3px] left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.95)]" />
                                </motion.div>
                            </div>

                            {/* Tactical Status Block */}
                            <motion.div
                                initial={{ y: 20, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                className="mt-8 text-center"
                            >
                                <div className="flex flex-col items-center gap-4">
                                    <div className="space-y-1">
                                        <h3 className="text-sm font-bold text-white tracking-[0.3em] uppercase font-mono bg-gradient-to-r from-purple-400 via-white to-cyan-400 bg-clip-text text-transparent">
                                            Environment Setup Active
                                        </h3>
                                        <div className="h-[1px] w-full bg-gradient-to-r from-transparent via-white/20 to-transparent" />
                                    </div>

                                    <p className="text-[11px] font-mono text-[#9CA3AF] uppercase tracking-widest px-4 h-4">
                                        {status === 'booting' ? '> ALLOCATING_KERNEL_RESOURCES' :
                                            status === 'installing' ? '> EXTRACTING_DEPENDENCY_GRAPH' :
                                                status === 'starting' ? '> SPAWNING_DEVELOPMENT_RUNTIME' :
                                                    status === 'error' ? '> RUNTIME_EXCEPTION_DETECTED' :
                                                        '> SYNCING_VIRTUAL_FILESYSTEM'}
                                    </p>
                                </div>

                                {/* Animated Data Packets */}
                                <div className="flex justify-center gap-2 mt-6">
                                    {[0, 1, 2, 3, 4].map((i) => (
                                        <motion.div
                                            key={i}
                                            animate={{
                                                height: [4, 12, 4],
                                                opacity: [0.3, 1, 0.3],
                                                backgroundColor: i % 2 === 0 ? "#A855F7" : "#22D3EE"
                                            }}
                                            transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.1 }}
                                            className="w-[2px] rounded-full"
                                        />
                                    ))}
                                </div>

                                {status === "error" && (
                                    <div className="mt-5 w-full max-w-[620px] px-4">
                                        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
                                            <p className="text-[10px] font-mono uppercase tracking-wider text-red-300/90">
                                                Runtime error
                                            </p>
                                            <p className="mt-1 text-[11px] text-red-100/85 break-words">
                                                {error ?? "Unknown runtime error"}
                                            </p>
                                            <button
                                                onClick={() => setViewMode("terminal")}
                                                className="mt-2 text-[10px] font-mono uppercase tracking-wider text-cyan-300 hover:text-cyan-200"
                                            >
                                                [ VIEW TERMINAL LOGS ]
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Terminal Layer */}
                <div
                    className={cn(
                        "absolute inset-0 bg-[#0B0B0F] p-4 transition-opacity duration-300",
                        viewMode === "terminal" ? "opacity-100 z-10" : "opacity-0 -z-10"
                    )}
                >
                    <div ref={terminalRef} className="h-full w-full rounded-lg overflow-hidden border border-white/10 bg-black/50" />
                </div>

                {/* Preview Layer */}
                <div
                    className={cn(
                        "absolute inset-0 transition-opacity duration-300 flex flex-col items-center justify-center p-4 sm:p-8 overflow-hidden bg-[#0F1117]/30",
                        viewMode === "preview" ? "opacity-100 z-10" : "opacity-0 -z-10"
                    )}
                >
                    <motion.div
                        className="relative flex items-center justify-center w-full h-full"
                        transition={{ type: "spring", stiffness: 300, damping: 30 }}
                    >
                        <AnimatePresence mode="wait">
                            {deviceMode === "mobile" && (
                                <motion.div
                                    key="iphone"
                                    initial={{ opacity: 0, scale: 0.9, y: 20 }}
                                    animate={{ opacity: 1, scale: 1, y: 0 }}
                                    exit={{ opacity: 0, scale: 0.9, y: 20 }}
                                    className="relative w-[320px] aspect-[9/19.5] sm:w-[360px] max-h-full"
                                >
                                    {/* iPhone 15 Pro Chassis */}
                                    <div className="absolute inset-x-[-12px] inset-y-[-12px] rounded-[48px] border-[3px] border-zinc-800 bg-zinc-900 shadow-[0_30px_60px_-15px_rgba(0,0,0,0.7)] pointer-events-none" />
                                    <div className="absolute inset-x-[-10px] inset-y-[-10px] rounded-[46px] border border-white/5 pointer-events-none" />

                                    {/* Dynamic Island */}
                                    <div className="absolute top-6 left-1/2 -translate-x-1/2 w-20 h-6 bg-black rounded-full z-30 flex items-center justify-between px-2.5 overflow-hidden">
                                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500/40 blur-[1px]" />
                                        <div className="w-1.5 h-1.5 rounded-full bg-zinc-800" />
                                    </div>

                                    {/* Side Buttons */}
                                    <div className="absolute left-[-14px] top-24 w-[3px] h-8 bg-zinc-700 rounded-r-sm" />
                                    <div className="absolute left-[-14px] top-36 w-[3px] h-12 bg-zinc-700 rounded-r-sm" />
                                    <div className="absolute right-[-14px] top-40 w-[3px] h-20 bg-zinc-700 rounded-l-sm" />

                                    <div className="relative h-full w-full rounded-[36px] overflow-hidden border border-black/40 bg-white">
                                        {renderPreviewContent()}
                                    </div>

                                    {/* Home Bar */}
                                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-24 h-1 bg-black/20 rounded-full z-20" />
                                </motion.div>
                            )}

                            {deviceMode === "tablet" && (
                                <motion.div
                                    key="ipad"
                                    initial={{ opacity: 0, scale: 0.95 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.95 }}
                                    className="relative w-full max-w-[800px] aspect-[4/3] max-h-full"
                                >
                                    {/* iPad Pro Chassis */}
                                    <div className="absolute inset-x-[-10px] inset-y-[-10px] rounded-[32px] border-[2px] border-zinc-800 bg-zinc-900 shadow-[20px_40px_80px_-20px_rgba(0,0,0,0.8)] pointer-events-none" />

                                    {/* Camera Hole */}
                                    <div className="absolute top-1/2 -right-4 -translate-y-1/2 w-1.5 h-8 bg-black rounded-l-md" />

                                    <div className="relative h-full w-full rounded-[24px] overflow-hidden border border-black/40 bg-white">
                                        {renderPreviewContent()}
                                    </div>

                                    {/* Home Bar */}
                                    <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-32 h-1 bg-black/10 rounded-full z-20" />
                                </motion.div>
                            )}

                            {deviceMode === "desktop" && (
                                <motion.div
                                    key="desktop"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="w-full h-full rounded-xl overflow-hidden shadow-2xl border border-white/10 bg-white"
                                >
                                    {renderPreviewContent()}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>

                {/* File Editor Layer */}
                <div
                    className={cn(
                        "absolute inset-0 bg-[#0B0B0F] transition-opacity duration-300 flex",
                        viewMode === "files" ? "opacity-100 z-10" : "opacity-0 -z-10"
                    )}
                >
                    {/* File Tree */}
                    <div className="w-64 border-r border-white/10 bg-[#0F1117] flex flex-col">
                        <div className="p-3 border-b border-white/5 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                            Explorer
                        </div>
                        <FileExplorer
                            files={localFiles}
                            onSelect={setSelectedFile}
                            selectedPath={selectedFile ?? undefined}
                            className="flex-1"
                        />
                    </div>
                    {/* Editor */}
                    <div className="flex-1 bg-[#1e1e1e] flex flex-col">
                        {selectedFile ? (
                            <CodeEditor
                                code={activeFileContent}
                                language={resolveEditorLanguage(selectedFile)}
                                onChange={handleFileChange}
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-zinc-600">
                                <FileCode className="w-12 h-12 mb-4 opacity-20" />
                                <p className="text-sm font-mono uppercase tracking-widest">Select a file to edit</p>
                            </div>
                        )}
                    </div>
                </div>

                {isImmersivePreview && url && portalRoot
                    ? createPortal(
                        <div ref={immersiveRootRef} className="fixed inset-0 z-[9999] bg-black">
                            <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg border border-white/15 bg-black/70 px-2 py-1 backdrop-blur-sm">
                                <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white"
                                    title="Open app URL in new tab"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                </a>
                                <button
                                    onClick={() => void handleFullscreenToggle()}
                                    className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white"
                                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                                >
                                    {isFullscreen ? (
                                        <Minimize2 className="h-4 w-4" />
                                    ) : (
                                        <Maximize2 className="h-4 w-4" />
                                    )}
                                </button>
                                <button
                                    onClick={closeImmersivePreview}
                                    className="rounded-md p-2 text-white/80 hover:bg-white/10 hover:text-white"
                                    title="Close immersive preview"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            <iframe
                                key={`immersive-${url}`}
                                src={url}
                                title="Immersive Preview"
                                className="h-full w-full border-none bg-white"
                            />
                        </div>,
                        portalRoot
                    )
                    : null}
            </div>
        </div>
    );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "relative flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold uppercase tracking-widest transition-all",
                active
                    ? "bg-white/10 text-white shadow-[0_0_15px_rgba(255,255,255,0.05)] border border-white/10"
                    : "text-[#6B7280] hover:text-[#9CA3AF] hover:bg-white/5 border border-transparent"
            )}
        >
            {icon}
            <span className="hidden sm:inline">{label}</span>
            {active && (
                <motion.div
                    layoutId="tab-underline"
                    className="absolute -bottom-1 left-2 right-2 h-[1px] bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.6)]"
                />
            )}
        </button>
    );
}

function DeviceButton({
    active,
    onClick,
    icon,
    title,
    disabled,
}: {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    title?: string;
    disabled?: boolean;
}) {
    return (
        <button
            onClick={onClick}
            title={title}
            disabled={disabled}
            className={cn(
                "p-2 rounded-lg transition-all border",
                disabled && "opacity-40 cursor-not-allowed",
                active
                    ? "bg-white/10 text-white border-white/10 shadow-[0_0_10px_rgba(255,255,255,0.05)]"
                    : "text-[#6B7280] hover:text-[#9CA3AF] hover:bg-white/5 border-transparent"
            )}
        >
            {icon}
        </button>
    );
}
