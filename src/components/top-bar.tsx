"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface TopBarProps {
    /** Marketing chrome (landing): wordmark + a link into the app. */
    variant?: "marketing" | "app";
    /** app variant only: shown next to the back button. */
    title?: React.ReactNode;
    /** app variant only: rendered after the title (e.g. a status pill). */
    titleAdornment?: React.ReactNode;
    /** app variant only: where the back chevron goes. Defaults to "/". */
    backHref?: string;
    /** Extra actions rendered on the right, before the wordmark link (app) or after it (marketing). */
    actions?: React.ReactNode;
}

export function TopBar({
    variant = "marketing",
    title,
    titleAdornment,
    backHref = "/",
    actions,
}: TopBarProps) {
    return (
        <header className="sticky top-0 z-40 h-14 frosted-bar">
            <div className="mx-auto flex h-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
                {variant === "marketing" ? (
                    <>
                        <Link
                            href="/"
                            className="text-[15px] font-semibold tracking-tight text-[#1d1d1f] rounded-[6px]"
                        >
                            Dexter
                        </Link>
                        <nav className="flex items-center gap-5">
                            {actions}
                            <Link
                                href="/projects"
                                className="text-[13px] font-medium text-[#6e6e73] hover:text-[#1d1d1f] transition-colors rounded-[6px]"
                            >
                                Projects
                            </Link>
                        </nav>
                    </>
                ) : (
                    <>
                        <div className="flex min-w-0 items-center gap-3">
                            <Link
                                href={backHref}
                                aria-label="Back to Dexter home"
                                className={cn(
                                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[#6e6e73]",
                                    "hover:bg-black/[0.04] hover:text-[#1d1d1f] transition-colors"
                                )}
                            >
                                <ArrowLeft className="h-4 w-4" />
                            </Link>
                            <div className="h-4 w-px shrink-0 bg-black/[0.08]" />
                            <span className="shrink-0 text-[15px] font-semibold tracking-tight text-[#1d1d1f]">
                                Dexter
                            </span>
                            {title ? (
                                <>
                                    <span className="shrink-0 text-[#c7c7cc]">/</span>
                                    <span className="min-w-0 truncate text-[13px] font-medium text-[#6e6e73]">
                                        {title}
                                    </span>
                                </>
                            ) : null}
                            {titleAdornment}
                        </div>
                        <div className="flex items-center gap-2">{actions}</div>
                    </>
                )}
            </div>
        </header>
    );
}
