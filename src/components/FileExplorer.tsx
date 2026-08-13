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
    if (name.endsWith(".tsx")) return <FileCode className="w-4 h-4 text-blue-400" />;
    if (name.endsWith(".ts")) return <FileCode className="w-4 h-4 text-blue-400" />;
    if (name.endsWith(".jsx")) return <FileCode className="w-4 h-4 text-yellow-400" />;
    if (name.endsWith(".js")) return <FileCode className="w-4 h-4 text-yellow-400" />;
    if (name.endsWith(".css")) return <FileType className="w-4 h-4 text-blue-300" />;
    if (name.endsWith(".html")) return <FileCode className="w-4 h-4 text-orange-400" />;
    if (name.endsWith(".json")) return <FileJson className="w-4 h-4 text-yellow-300" />;
    if (name.endsWith(".md")) return <FileText className="w-4 h-4 text-gray-400" />;
    if (name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".svg")) return <FileImage className="w-4 h-4 text-purple-400" />;
    return <FileIcon className="w-4 h-4 text-zinc-500" />;
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
                <div
                    className={cn(
                        "flex items-center py-0.5 px-1 cursor-pointer hover:bg-zinc-800/50 rounded-sm select-none transition-colors duration-100",
                        "text-zinc-400 hover:text-zinc-100"
                    )}
                    style={{ paddingLeft: `${depth * 10 + 4}px` }}
                    onClick={() => setExpanded(!expanded)}
                >
                    {expanded ? (
                        <ChevronDown className="w-3 h-3 mr-1 shrink-0 opacity-70" />
                    ) : (
                        <ChevronRight className="w-3 h-3 mr-1 shrink-0 opacity-70" />
                    )}
                    {expanded ? (
                        <FolderOpen className="w-3.5 h-3.5 mr-1.5 text-blue-400 fill-blue-400/10" />
                    ) : (
                        <Folder className="w-3.5 h-3.5 mr-1.5 text-blue-400 fill-blue-400/10" />
                    )}
                    <span className="truncate">{node.name}</span>
                </div>
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
        <div
            className={cn(
                "flex items-center py-0.5 px-1 cursor-pointer hover:bg-zinc-800/50 rounded-sm transition-colors duration-100",
                isSelected ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"
            )}
            style={{ paddingLeft: `${depth * 10 + 20}px` }}
            onClick={() => onSelect(node.path)}
        >
            <div className="mr-1.5 shrink-0">
                {getFileIcon(node.name)}
            </div>
            <span className={cn("truncate", isSelected && "font-semibold")}>
                {node.name}
            </span>
        </div>
    );
}
