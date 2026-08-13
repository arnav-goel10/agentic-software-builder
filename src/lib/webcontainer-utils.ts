import type { FileSystemTree } from "@webcontainer/api";

export interface GeneratedFile {
    name: string; // path
    code: string; // content
    language?: string;
}

type MutableTreeNode = {
    file?: { contents: string };
    directory?: Record<string, MutableTreeNode>;
};

export function convertToWebContainerTree(files: GeneratedFile[]): FileSystemTree {
    const root: Record<string, MutableTreeNode> = {};

    for (const file of files) {
        const parts = file.name.split("/").filter(Boolean);
        let current: Record<string, MutableTreeNode> = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isFile = i === parts.length - 1;

            if (isFile) {
                current[part] = {
                    file: {
                        contents: file.code
                    }
                };
            } else {
                if (!current[part]) {
                    current[part] = {
                        directory: {}
                    };
                }
                const nextDirectory = current[part].directory ?? {};
                current[part].directory = nextDirectory;
                current = nextDirectory;
            }
        }
    }
    return root as FileSystemTree;
}
