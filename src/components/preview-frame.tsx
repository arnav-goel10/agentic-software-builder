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
    ExternalLink,
    Maximize2,
    Minimize2,
    X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useWebContainer } from "@/hooks/use-web-container";
import { GeneratedFile } from "@/lib/webcontainer-utils";
import { createPortal } from "react-dom";
import type { Terminal } from "xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";

type ViewMode = "preview" | "terminal";
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
                        background: "#161618",
                        foreground: "#e5e5e7",
                        cursor: "#e5e5e7",
                        selectionBackground: "#0071e355",
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
        if (viewMode === "terminal" && xtermRef.current && fitAddonRef.current) {
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
                <div className="flex flex-col items-center justify-center h-full text-[#6e6e73] gap-4">
                    <Loader2 className={cn("w-6 h-6 text-[#0071e3]", (status === 'starting' || status === 'booting' || status === 'installing') && "animate-spin")} />
                    <p className="text-[13px] text-[#6e6e73]">
                        {status === 'idle' ? 'Ready to launch project' :
                            status === 'error' ? `Error: ${error}` : 'Waiting for runtime...'}
                    </p>
                    <div className="flex gap-4">
                        <button onClick={handleRun} disabled={status !== 'ready'} className="text-[12px] font-medium text-[#0071e3] hover:text-[#0058b0] transition-colors rounded-[6px]">
                            Boot runtime
                        </button>
                        {(status === 'error' || status === 'installing' || status === 'starting') && (
                            <button onClick={() => window.location.reload()} className="text-[12px] font-medium text-[#d1242f] hover:text-[#a01c25] transition-colors rounded-[6px]">
                                Hard reset
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
                    <div className="absolute inset-0 flex items-center justify-center bg-white/80 backdrop-blur-[1px] text-[#6e6e73] text-[13px]">
                        Loading preview...
                    </div>
                )}
                {iframeEmbedBlocked && (
                    <div className="absolute left-3 right-3 bottom-3 rounded-[10px] border border-[#9a6700]/20 bg-[#9a6700]/10 px-3 py-2 text-[12px] text-[#9a6700]">
                        <div className="font-medium mb-1">Preview blocked</div>
                        <div className="opacity-80">Browser privacy settings may prevent embedding. Check your browser&apos;s security/privacy preferences.</div>
                    </div>
                )}
                {error && (
                    <div className="absolute top-3 left-3 right-3 rounded-[10px] border border-[#d1242f]/25 bg-white px-3 py-2 text-[12px] text-[#d1242f] shadow-md">
                        <div className="font-medium mb-1">Runtime error</div>
                        <div className="opacity-90 line-clamp-3">{error}</div>
                        <div className="flex gap-3 mt-2">
                            <button onClick={() => setViewMode("terminal")} className="text-[#0071e3] font-medium hover:underline rounded-[4px]">View logs</button>
                            <button onClick={() => window.location.reload()} className="text-[#d1242f] font-medium hover:underline rounded-[4px]">Reload</button>
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

    const statusMeta: Record<typeof status, { label: string; className: string }> = {
        idle: { label: "Idle", className: "bg-black/[0.04] border-black/[0.08] text-[#86868b]" },
        booting: { label: "Booting", className: "bg-[#0071e3]/10 border-[#0071e3]/20 text-[#0071e3]" },
        installing: { label: "Installing", className: "bg-[#0071e3]/10 border-[#0071e3]/20 text-[#0071e3]" },
        starting: { label: "Starting", className: "bg-[#0071e3]/10 border-[#0071e3]/20 text-[#0071e3]" },
        running: { label: "Running", className: "bg-[#1a7f37]/10 border-[#1a7f37]/20 text-[#1a7f37]" },
        ready: { label: "Ready", className: "bg-black/[0.04] border-black/[0.08] text-[#86868b]" },
        error: { label: "Error", className: "bg-[#d1242f]/10 border-[#d1242f]/20 text-[#d1242f]" },
    };

    return (
        <div ref={frameRootRef} className="flex flex-col h-full bg-white">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-black/[0.08] gap-4">
                {/* View mode tabs */}
                <div className="flex items-center gap-1 p-1 rounded-[10px] bg-[#f5f5f7]">
                    <TabButton
                        active={viewMode === "preview"}
                        onClick={() => setViewMode("preview")}
                        icon={<Eye className="w-3.5 h-3.5" />}
                        label="Preview"
                    />
                    <TabButton
                        active={viewMode === "terminal"}
                        onClick={() => setViewMode("terminal")}
                        icon={<TerminalIcon className="w-3.5 h-3.5" />}
                        label="Logs"
                    />
                </div>

                {/* Status & Controls */}
                <div className="flex items-center gap-3 ml-auto">
                    <div className={cn("flex items-center gap-2 px-2.5 py-1 rounded-full border text-[11px] font-medium", statusMeta[status].className)}>
                        {(status === 'booting' || status === 'installing' || status === 'starting') && (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        )}
                        {status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-[#1a7f37]" />}
                        {status === 'error' && <span className="w-1.5 h-1.5 rounded-full bg-[#d1242f]" />}
                        {(status === 'ready' || status === 'idle') && <span className="w-1.5 h-1.5 rounded-full bg-black/20" />}
                        {statusMeta[status].label}
                    </div>

                    <button
                        onClick={handleRun}
                        disabled={status !== 'ready' && status !== 'error' && status !== 'running'}
                        className={cn(
                            "flex items-center gap-1.5 px-3.5 py-1.5 rounded-[10px] text-[12.5px] font-medium transition-colors",
                            status !== 'ready' && status !== 'error' && status !== 'running'
                                ? "bg-black/[0.04] text-[#c7c7cc] cursor-not-allowed"
                                : "bg-[#0071e3] text-white hover:bg-[#0077ed] active:bg-[#0068d1]"
                        )}
                    >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        Run
                    </button>
                </div>

                {/* Device toggles */}
                <div className="flex items-center gap-1">
                    <DeviceButton active={deviceMode === "desktop"} onClick={() => setDeviceMode("desktop")} icon={<Monitor className="w-4 h-4" />} title="Desktop" />
                    <DeviceButton active={deviceMode === "tablet"} onClick={() => setDeviceMode("tablet")} icon={<Tablet className="w-4 h-4" />} title="Tablet" />
                    <DeviceButton active={deviceMode === "mobile"} onClick={() => setDeviceMode("mobile")} icon={<Smartphone className="w-4 h-4" />} title="Mobile" />
                    <DeviceButton active={isImmersivePreview} onClick={handlePopout} icon={<Eye className="w-4 h-4" />} title="Immersive preview" disabled={!url} />
                    <DeviceButton active={false} onClick={handleOpenAppUrl} icon={<ExternalLink className="w-4 h-4" />} title="Open in new tab" disabled={!url} />
                    <DeviceButton
                        active={isFullscreen}
                        onClick={() => void handleFullscreenToggle()}
                        icon={isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                    />
                </div>
            </div>

            {/* Content Area */}
            <div className="flex-1 overflow-hidden relative bg-[#f5f5f7]">
                {/* Setup loading overlay */}
                <AnimatePresence>
                    {(viewMode === "preview" && status !== "running" && status !== "idle" && !url) && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-white"
                        >
                            <Loader2 className="w-7 h-7 text-[#0071e3] animate-spin mb-4" />
                            <p className="text-[14px] font-medium text-[#1d1d1f] mb-1">
                                {status === 'booting' ? 'Booting runtime' :
                                    status === 'installing' ? 'Installing dependencies' :
                                        status === 'starting' ? 'Starting dev server' :
                                            status === 'error' ? 'Runtime error' :
                                                'Syncing files'}
                            </p>
                            <p className="text-[12.5px] text-[#86868b]">This usually takes a few seconds.</p>

                            {status === "error" && (
                                <div className="mt-5 w-full max-w-[520px] px-4">
                                    <div className="rounded-[10px] border border-[#d1242f]/20 bg-[#d1242f]/5 px-3 py-2.5">
                                        <p className="text-[11px] font-medium uppercase tracking-wide text-[#d1242f]">
                                            Runtime error
                                        </p>
                                        <p className="mt-1 text-[12.5px] text-[#7a1c22] break-words">
                                            {error ?? "Unknown runtime error"}
                                        </p>
                                        <button
                                            onClick={() => setViewMode("terminal")}
                                            className="mt-2 text-[11.5px] font-medium text-[#0071e3] hover:underline"
                                        >
                                            View logs
                                        </button>
                                    </div>
                                </div>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Terminal Layer */}
                <div
                    className={cn(
                        "absolute inset-0 bg-[#161618] p-3 transition-opacity duration-200",
                        viewMode === "terminal" ? "opacity-100 z-10" : "opacity-0 -z-10"
                    )}
                >
                    <div ref={terminalRef} className="h-full w-full rounded-[10px] overflow-hidden border border-white/10" />
                </div>

                {/* Preview Layer */}
                <div
                    className={cn(
                        "absolute inset-0 transition-opacity duration-200 flex flex-col items-center justify-center p-4 sm:p-8 overflow-hidden",
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
                                    initial={{ opacity: 0, scale: 0.96 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.96 }}
                                    transition={{ duration: 0.2 }}
                                    className="relative w-[320px] aspect-[9/19.5] sm:w-[360px] max-h-full"
                                >
                                    <div className="absolute inset-x-[-12px] inset-y-[-12px] rounded-[48px] border-[3px] border-[#1d1d1f] bg-[#1d1d1f] shadow-xl pointer-events-none" />
                                    <div className="absolute top-6 left-1/2 -translate-x-1/2 w-20 h-6 bg-black rounded-full z-30" />
                                    <div className="relative h-full w-full rounded-[36px] overflow-hidden border border-black/40 bg-white">
                                        {renderPreviewContent()}
                                    </div>
                                    <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-24 h-1 bg-black/20 rounded-full z-20" />
                                </motion.div>
                            )}

                            {deviceMode === "tablet" && (
                                <motion.div
                                    key="ipad"
                                    initial={{ opacity: 0, scale: 0.97 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.97 }}
                                    transition={{ duration: 0.2 }}
                                    className="relative w-full max-w-[800px] aspect-[4/3] max-h-full"
                                >
                                    <div className="absolute inset-x-[-10px] inset-y-[-10px] rounded-[32px] border-[2px] border-[#1d1d1f] bg-[#1d1d1f] shadow-xl pointer-events-none" />
                                    <div className="relative h-full w-full rounded-[24px] overflow-hidden border border-black/40 bg-white">
                                        {renderPreviewContent()}
                                    </div>
                                    <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-32 h-1 bg-black/10 rounded-full z-20" />
                                </motion.div>
                            )}

                            {deviceMode === "desktop" && (
                                <motion.div
                                    key="desktop"
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="w-full h-full rounded-[12px] overflow-hidden shadow-lg border border-black/[0.08] bg-white"
                                >
                                    {renderPreviewContent()}
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                </div>

                {isImmersivePreview && url && portalRoot
                    ? createPortal(
                        <div ref={immersiveRootRef} className="fixed inset-0 z-[9999] bg-black">
                            <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-[10px] border border-white/15 bg-black/70 px-2 py-1 backdrop-blur-sm">
                                <a
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-[8px] p-2 text-white/80 hover:bg-white/10 hover:text-white"
                                    title="Open app URL in new tab"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                </a>
                                <button
                                    onClick={() => void handleFullscreenToggle()}
                                    className="rounded-[8px] p-2 text-white/80 hover:bg-white/10 hover:text-white"
                                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                                >
                                    {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                                </button>
                                <button
                                    onClick={closeImmersivePreview}
                                    className="rounded-[8px] p-2 text-white/80 hover:bg-white/10 hover:text-white"
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
                "relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-[8px] text-[12px] font-medium transition-colors",
                active ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#86868b] hover:text-[#1d1d1f]"
            )}
        >
            {icon}
            <span>{label}</span>
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
            aria-label={title}
            disabled={disabled}
            className={cn(
                "p-1.5 rounded-[8px] transition-colors",
                disabled && "opacity-30 cursor-not-allowed",
                active ? "bg-black/[0.06] text-[#1d1d1f]" : "text-[#86868b] hover:text-[#1d1d1f] hover:bg-black/[0.04]"
            )}
        >
            {icon}
        </button>
    );
}
