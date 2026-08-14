import React, { useMemo, useState } from "react";
import {
    ChevronRight,
    ChevronDown,
    Folder,
    FolderOpen,
    FileCode,
    FileJson,
    FileType,
    FileText,
    FileImage,
    File as FileIcon
} from "lucide-react";
import { cn } from "@/lib/utils";

type GeneratedFile = {
    name: string;
    code: string;
    language?: string;
};

type FileNode = {
    name: string;
    path: string;
    type: "file" | "directory";
    children?: FileNode[];
};

interface FileExplorerProps {
    files: GeneratedFile[];
    onSelect: (path: string) => void;
    selectedPath?: string;
    className?: string;
}

function getFileIcon(name: string) {
    if (name.endsWith(".tsx")) return <FileCode className="w-4 h-4 text-[#0071e3]" />;
    if (name.endsWith(".ts")) return <FileCode className="w-4 h-4 text-[#0071e3]" />;
    if (name.endsWith(".jsx")) return <FileCode className="w-4 h-4 text-[#9a6700]" />;
    if (name.endsWith(".js")) return <FileCode className="w-4 h-4 text-[#9a6700]" />;
    if (name.endsWith(".css")) return <FileType className="w-4 h-4 text-[#0071e3]/70" />;
    if (name.endsWith(".html")) return <FileCode className="w-4 h-4 text-[#c2410c]" />;
    if (name.endsWith(".json")) return <FileJson className="w-4 h-4 text-[#9a6700]/80" />;
    if (name.endsWith(".md")) return <FileText className="w-4 h-4 text-[#86868b]" />;
    if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".svg")) return <FileImage className="w-4 h-4 text-[#8250df]" />;
    return <FileIcon className="w-4 h-4 text-[#86868b]" />;
}

export function FileExplorer({
    files,
    onSelect,
    selectedPath,
    className,
}: FileExplorerProps) {
    const tree = useMemo(() => {
        const root: FileNode[] = [];
        const map = new Map<string, FileNode>();

        // Sort files by path depth and name
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));

        for (const file of sorted) {
            const parts = file.name.split("/");
            let currentPath = "";
            let currentLevel = root;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isFile = i === parts.length - 1;
                currentPath = currentPath ? `${currentPath}/${part}` : part;

                let node = map.get(currentPath);
                if (!node) {
                    node = {
                        name: part,
                        path: currentPath,
                        type: isFile ? "file" : "directory",
                        children: isFile ? undefined : [],
                    };
                    map.set(currentPath, node);
                    currentLevel.push(node);
                }

                if (!isFile) {
                    currentLevel = node.children!;
                }
            }
        }

        // Sort directories first
        const sortNodes = (nodes: FileNode[]) => {
            nodes.sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === "directory" ? -1 : 1;
            });
            nodes.forEach((node) => {
                if (node.children) sortNodes(node.children);
            });
        };
        sortNodes(root);
        return root;
    }, [files]);

    return (
        <div className={cn("overflow-auto h-full text-xs font-medium", className)}>
            <div className="pl-1 pt-1 pb-4">
                {tree.map((node) => (
                    <FileTreeNode
                        key={node.path}
                        node={node}
                        onSelect={onSelect}
                        selectedPath={selectedPath}
                        depth={0}
                    />
                ))}
            </div>
        </div>
    );
}

function FileTreeNode({
    node,
    onSelect,
    selectedPath,
    depth,
}: {
    node: FileNode;
    onSelect: (path: string) => void;
    selectedPath?: string;
    depth: number;
}) {
    const [expanded, setExpanded] = useState(true);
    const isSelected = selectedPath === node.path;

    if (node.type === "directory") {
        return (
            <div>
                <button
                    type="button"
                    className={cn(
                        "flex w-full items-center py-1 px-1 cursor-pointer hover:bg-black/[0.04] rounded-[6px] select-none transition-colors duration-100 text-left",
                        "text-[#6e6e73] hover:text-[#1d1d1f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] focus-visible:ring-offset-1"
                    )}
                    style={{ paddingLeft: `${depth * 10 + 4}px` }}
                    onClick={() => setExpanded(!expanded)}
                    aria-expanded={expanded}
                >
                    {expanded ? (
                        <ChevronDown className="w-3 h-3 mr-1 shrink-0 opacity-70" />
                    ) : (
                        <ChevronRight className="w-3 h-3 mr-1 shrink-0 opacity-70" />
                    )}
                    {expanded ? (
                        <FolderOpen className="w-3.5 h-3.5 mr-1.5 text-[#0071e3]/70" />
                    ) : (
                        <Folder className="w-3.5 h-3.5 mr-1.5 text-[#0071e3]/70" />
                    )}
                    <span className="truncate">{node.name}</span>
                </button>
                {expanded && (
                    <div className="relative">
                        {node.children?.map((child) => (
                            <FileTreeNode
                                key={child.path}
                                node={child}
                                onSelect={onSelect}
                                selectedPath={selectedPath}
                                depth={depth + 1}
                            />
                        ))}
                    </div>
                )}
            </div>
        );
    }

    return (
        <button
            type="button"
            className={cn(
                "flex w-full items-center py-1 px-1 cursor-pointer rounded-[6px] transition-colors duration-100 text-left",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0071e3] focus-visible:ring-offset-1",
                isSelected
                    ? "bg-[#0071e3]/10 text-[#0071e3]"
                    : "text-[#6e6e73] hover:bg-black/[0.04] hover:text-[#1d1d1f]"
            )}
            style={{ paddingLeft: `${depth * 10 + 20}px` }}
            onClick={() => onSelect(node.path)}
            aria-current={isSelected ? "true" : undefined}
        >
            <div className="mr-1.5 shrink-0">
                {getFileIcon(node.name)}
            </div>
            <span className={cn("truncate", isSelected && "font-semibold")}>
                {node.name}
            </span>
        </button>
    );
}
