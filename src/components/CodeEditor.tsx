import React from "react";
import Editor, { Monaco } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";

interface CodeEditorProps {
    code: string;
    language?: string;
    onChange?: (value: string | undefined) => void;
    readOnly?: boolean;
}

export function CodeEditor({
    code,
    language = "plaintext",
    onChange,
    readOnly = false,
}: CodeEditorProps) {
    const monacoLanguage =
        language === "json" ||
            language === "css" ||
            language === "html" ||
            language === "javascript" ||
            language === "typescript" ||
            language === "plaintext"
            ? language
            : "plaintext";

    const handleEditorWillMount = (monaco: Monaco) => {
        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: false,
        });
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: false,
        });

        const compilerOptions = {
            target: monaco.languages.typescript.ScriptTarget.Latest,
            allowNonTsExtensions: true,
            moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
            module: monaco.languages.typescript.ModuleKind.CommonJS,
            noEmit: true,
            esModuleInterop: true,
            jsx: monaco.languages.typescript.JsxEmit.React,
            reactNamespace: "React",
            allowJs: true,
        };

        monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);
    };

    return (
        <div className="h-full w-full bg-[#1e1e1e]">
            <Editor
                beforeMount={handleEditorWillMount}
                height="100%"
                defaultLanguage={monacoLanguage}
                language={monacoLanguage}
                value={code}
                theme="vs-dark"
                onChange={onChange}
                options={{
                    readOnly,
                    minimap: { enabled: true },
                    scrollBeyondLastLine: false,
                    fontSize: 14,
                    automaticLayout: true,
                    padding: { top: 16, bottom: 16 },
                }}
                loading={
                    <div className="flex items-center justify-center h-full text-zinc-500">
                        <Loader2 className="w-6 h-6 animate-spin mr-2" />
                        Loading Editor...
                    </div>
                }
            />
        </div>
    );
}
