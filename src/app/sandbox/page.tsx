"use client";

import dynamic from "next/dynamic";

const SandboxContent = dynamic(() => import("@/components/sandbox-content"), {
    ssr: false,
    loading: () => (
        <div className="h-screen bg-[#fafafa] overflow-hidden flex">
            <div className="flex-1 flex items-center justify-center">
                <div className="w-5 h-5 border-2 border-[#0071e3] border-t-transparent rounded-full animate-spin" />
            </div>
        </div>
    ),
});

export default function SandboxPage() {
    return <SandboxContent />;
}
