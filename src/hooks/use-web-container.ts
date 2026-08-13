"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { WebContainer, WebContainerProcess } from "@webcontainer/api";
import { getWebContainer } from "@/lib/webcontainer";
import { convertToWebContainerTree, GeneratedFile } from "@/lib/webcontainer-utils";
import type { Terminal } from "xterm";

const TERMINAL_ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const BROWSER_SOURCE_FILE_PATTERN = /^(src\/.+|lib\/.+|utils\/.+|config\/.+|services\/.+|hooks\/.+|App\.(jsx|tsx|js|ts)|main\.(jsx|tsx|js|ts)|index\.(jsx|tsx|js|ts))$/;
const INSTALL_TIMEOUT_MS = 120_000;

function fingerprintFile(content: string): string {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
        hash ^= content.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${content.length}:${hash >>> 0}`;
}

function enhanceFilesForWebContainer(files: GeneratedFile[]): GeneratedFile[] {
    return files.map((file) => {
        if (file.name === 'vite.config.js' || file.name === 'vite.config.ts') {
            let code = file.code;
            // First, make sure we have a server block
            if (!/server:\s*\{/.test(code) && /defineConfig\(\{/.test(code)) {
                code = code.replace(/defineConfig\(\{/, "defineConfig({\n  server: { host: '0.0.0.0', allowedHosts: true },");
            } else if (/server:\s*\{/.test(code)) {
                // If we have a server block, ensure host is 0.0.0.0
                if (!/host:/.test(code)) {
                    code = code.replace(/server:\s*\{/, "server: {\n    host: '0.0.0.0',");
                } else if (/host:\s*(true|['"]localhost['"])/.test(code)) {
                    code = code.replace(/host:\s*(true|['"]localhost['"])/g, "host: '0.0.0.0'");
                }
                // Ensure allowedHosts is true
                if (!/allowedHosts:/.test(code)) {
                    code = code.replace(/server:\s*\{/, "server: {\n    allowedHosts: true,");
                }
            }
            if (code !== file.code) {
                return { ...file, code };
            }
            return file;
        }

        // 2. Generic Env Var Rewrite — process.env.NEXT_PUBLIC_* → import.meta.env.VITE_*
        if (!BROWSER_SOURCE_FILE_PATTERN.test(file.name)) {
            return file;
        }
        const envPattern = /process\.env\.NEXT_PUBLIC_([A-Z0-9_]+)/g;
        const updatedCode = file.code.replace(envPattern, 'import.meta.env.VITE_$1');
        if (updatedCode === file.code) {
            return file;
        }
        return { ...file, code: updatedCode };
    });
}

export function useWebContainer() {
    const [container, setContainer] = useState<WebContainer | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [status, setStatus] = useState<"idle" | "booting" | "ready" | "installing" | "starting" | "running" | "error">("idle");
    const [error, setError] = useState<string | null>(null);
    const devProcessRef = useRef<WebContainerProcess | null>(null);
    const hasSuccessfulInstallRef = useRef(false);
    const hasLockfileRef = useRef(false);
    const mountedFileIndexRef = useRef<Map<string, string>>(new Map());

    const extractRuntimeError = useCallback((chunk: string): string | null => {
        const plain = chunk.replace(TERMINAL_ANSI_PATTERN, "");
        const lines = plain
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        for (let index = lines.length - 1; index >= 0; index -= 1) {
            const line = lines[index];
            if (!line) continue;
            if (/internal server error/i.test(line)) return line;
            if (/failed to resolve import/i.test(line)) return line;
            if (/could not resolve/i.test(line)) return line;
            if (/syntaxerror/i.test(line)) return line;
            if (/npm err!/i.test(line)) return line;
            if (/\[plugin:vite/i.test(line)) return line;
        }

        return null;
    }, []);

    const extractRuntimeErrorFromBuffer = useCallback((buffer: string): string | null => {
        const plain = buffer.replace(TERMINAL_ANSI_PATTERN, "");
        const patterns: RegExp[] = [
            /Internal server error:\s*([^\n]+)/i,
            /Failed to resolve import\s*([^\n]+)/i,
            /Could not resolve\s*([^\n]+)/i,
            /SyntaxError:\s*([^\n]+)/i,
            /\[plugin:vite[^\]]*\]\s*([^\n]+)/i,
            /Error:\s*([^\n]+)/i,
            /npm ERR! code EJSONPARSE/i,
            /npm ERR!.*JSON.parse/i
        ];

        for (const pattern of patterns) {
            const match = plain.match(pattern);
            if (match) {
                const message = match[0]?.trim() || match[1]?.trim();
                if (message) {
                    return message;
                }
            }
        }

        return null;
    }, []);

    const boot = useCallback(async () => {
        if (container || status !== "idle") {
            return;
        }

        try {
            setStatus("booting");
            const instance = await getWebContainer();
            setContainer(instance);
            setStatus("ready");

            instance.on("server-ready", (port, url) => {
                console.log("Server ready:", url);
                setUrl(url);
                setStatus("running");
            });

        } catch (err: unknown) {
            console.error("Failed to boot WebContainer:", err);
            const message = err instanceof Error ? err.message : "Failed to boot WebContainer";
            setError(message);
            setStatus("error");
        }
    }, [container, status]);

    const mount = useCallback(async (files: GeneratedFile[]) => {
        if (!container) return;
        hasLockfileRef.current = files.some(
            (file) => file.name === "package-lock.json" || file.name === "npm-shrinkwrap.json"
        );

        const viteCompatibleFiles = enhanceFilesForWebContainer(files);
        const nextIndex = new Map<string, string>();
        for (const file of viteCompatibleFiles) {
            nextIndex.set(file.name, fingerprintFile(file.code));
        }

        const previousIndex = mountedFileIndexRef.current;
        const hasPrevious = previousIndex.size > 0;
        if (!hasPrevious) {
            const tree = convertToWebContainerTree(viteCompatibleFiles);
            await container.mount(tree);
            mountedFileIndexRef.current = nextIndex;
            return;
        }

        const changedFiles = viteCompatibleFiles.filter((file) => {
            const previousFingerprint = previousIndex.get(file.name);
            return previousFingerprint !== nextIndex.get(file.name);
        });
        const deletedFiles = Array.from(previousIndex.keys()).filter((path) => !nextIndex.has(path));

        if (changedFiles.length === 0 && deletedFiles.length === 0) {
            return;
        }

        const totalChanges = changedFiles.length + deletedFiles.length;
        const shouldFullMount =
            totalChanges > Math.max(20, Math.floor(viteCompatibleFiles.length * 0.6));

        if (shouldFullMount) {
            const tree = convertToWebContainerTree(viteCompatibleFiles);
            await container.mount(tree);
            mountedFileIndexRef.current = nextIndex;
            return;
        }

        for (const filePath of deletedFiles) {
            try {
                await container.fs.rm(filePath);
            } catch {
                // no-op
            }
        }

        for (const file of changedFiles) {
            const segments = file.name.split("/").slice(0, -1);
            let cumulative = "";
            for (const segment of segments) {
                cumulative = cumulative ? `${cumulative}/${segment}` : segment;
                try {
                    await container.fs.mkdir(cumulative);
                } catch {
                    // directory may already exist
                }
            }
            await container.fs.writeFile(file.name, file.code);
        }

        mountedFileIndexRef.current = nextIndex;
    }, [container]);

    const stopDev = useCallback(async () => {
        if (!devProcessRef.current) {
            return;
        }

        try {
            devProcessRef.current.kill();
        } catch {
            // No-op.
        } finally {
            devProcessRef.current = null;
            setUrl(null);
        }
    }, []);

    const install = useCallback(async (terminal?: Terminal) => {
        if (!container) return;
        setStatus("installing");
        setError(null);

        const baseArgs = ["--prefer-offline", "--no-audit", "--no-fund"];
        const attempts: Array<{ cmd: "ci" | "install"; label: string }> = hasSuccessfulInstallRef.current
            ? [{ cmd: "install", label: "incremental" }]
            : hasLockfileRef.current
                ? [
                    { cmd: "ci", label: "deterministic" },
                    { cmd: "install", label: "incremental fallback" },
                ]
                : [{ cmd: "install", label: "incremental (no lockfile)" }];

        let lastError: unknown = null;

        for (let index = 0; index < attempts.length; index += 1) {
            const { cmd, label } = attempts[index];
            const installProcess = await container.spawn("npm", [cmd, ...baseArgs]);
            let installFailureLine: string | null = null;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;

            terminal?.writeln(`\x1b[34mRunning npm ${cmd} (${label})...\x1b[0m`);

            try {
                installProcess.output.pipeTo(new WritableStream({
                    write(data) {
                        terminal?.write(data);
                        const detected = extractRuntimeError(data);
                        if (detected) {
                            installFailureLine = detected;
                        }
                    }
                })).catch(() => {
                    // Stream teardown can race with kill() on timeout; ignore.
                });

                const exitCodePromise = installProcess.exit;
                const timeoutPromise = new Promise<number>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(
                            new Error(
                                `npm ${cmd} timed out after ${Math.round(INSTALL_TIMEOUT_MS / 1000)}s`
                            )
                        );
                    }, INSTALL_TIMEOUT_MS);
                });

                const exitCode = await Promise.race([exitCodePromise, timeoutPromise]);
                if (exitCode !== 0) {
                    const detail = installFailureLine ?? `npm ${cmd} failed with exit code ${exitCode}`;
                    throw new Error(detail);
                }

                hasSuccessfulInstallRef.current = true;
                setStatus("ready");
                return;
            } catch (err: unknown) {
                lastError = err;
                try {
                    installProcess.kill();
                } catch {
                    // no-op
                }

                const message = err instanceof Error ? err.message : `npm ${cmd} failed`;
                terminal?.writeln(`\x1b[33m${message}\x1b[0m`);

                const hasAnotherAttempt = index < attempts.length - 1;
                if (hasAnotherAttempt) {
                    terminal?.writeln("\x1b[33mFalling back to npm install...\x1b[0m");
                }
            } finally {
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            }
        }

        const finalMessage =
            lastError instanceof Error ? lastError.message : "Installation failed";
        setError(finalMessage);
        setStatus("error");
        throw new Error(finalMessage);
    }, [container, extractRuntimeError]);

    const startDev = useCallback(async (terminal?: Terminal) => {
        if (!container) return;
        if (devProcessRef.current) {
            try {
                devProcessRef.current.kill();
            } catch {
                // No-op.
            } finally {
                devProcessRef.current = null;
            }
        }

        setStatus("starting");
        setError(null);
        let outputBuffer = "";

        const devProcess = await container.spawn("npm", ["run", "dev"]);
        devProcessRef.current = devProcess;

        devProcess.output.pipeTo(new WritableStream({
            write(data) {
                terminal?.write(data);
                const detected = extractRuntimeError(data);
                if (detected) {
                    setError(detected);
                    setStatus("error");
                }
                outputBuffer = `${outputBuffer}${data}`.slice(-8192);
                const buffered = extractRuntimeErrorFromBuffer(outputBuffer);
                if (buffered) {
                    setError(buffered);
                    setStatus("error");
                }
            }
        }));

        void devProcess.exit.then((exitCode) => {
            if (devProcessRef.current === devProcess) {
                devProcessRef.current = null;
            }
            if (exitCode !== 0) {
                setStatus("error");
                setError((prev) => prev ?? `Dev server exited with code ${exitCode}`);
            }
        });
    }, [container, extractRuntimeError, extractRuntimeErrorFromBuffer]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (devProcessRef.current) {
                try {
                    devProcessRef.current.kill();
                } catch {
                    // No-op.
                } finally {
                    devProcessRef.current = null;
                }
            }
        };
    }, []);

    return {
        container,
        url,
        status,
        error,
        boot,
        mount,
        install,
        startDev,
        stopDev
    };
}
