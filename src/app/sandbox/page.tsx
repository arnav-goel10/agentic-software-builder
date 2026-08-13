"use client";

import dynamic from "next/dynamic";

const SandboxContent = dynamic(() => import("@/components/sandbox-content"), {
    ssr: false,
    loading: () => (
        <div className="h-screen bg-[#0B0B0F] overflow-hidden flex">
            <div className="flex-1 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
            </div>
        </div>
    ),
});

export default function SandboxPage() {
    return <SandboxContent />;
}
