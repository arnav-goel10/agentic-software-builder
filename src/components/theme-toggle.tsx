"use client";

import * as React from "react";
import { Laptop, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isThemeMode,
  THEME_MODES,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "@/lib/theme";

function readThemeFromDom(): ThemeMode {
  if (typeof document === "undefined") {
    return "system";
  }
  const value = document.documentElement.getAttribute("data-theme");
  return isThemeMode(value) ? value : "system";
}

function applyTheme(theme: ThemeMode): void {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.setAttribute("data-theme", theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore localStorage errors in private/restricted contexts.
  }
}

const OPTIONS: Array<{ mode: ThemeMode; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "system", label: "System", icon: Laptop },
  { mode: "dark", label: "Dark", icon: Moon },
];

export function ThemeToggle({ className, compact = false }: { className?: string; compact?: boolean }) {
  const [theme, setTheme] = React.useState<ThemeMode>("system");

  React.useEffect(() => {
    setTheme(readThemeFromDom());
  }, []);

  const setMode = React.useCallback((mode: ThemeMode) => {
    applyTheme(mode);
    setTheme(mode);
  }, []);

  if (compact) {
    const nextMode = THEME_MODES[(THEME_MODES.indexOf(theme) + 1) % THEME_MODES.length] ?? "system";
    const ActiveIcon = OPTIONS.find((option) => option.mode === theme)?.icon ?? Laptop;

    return (
      <button
        type="button"
        onClick={() => setMode(nextMode)}
        aria-label={`Switch theme mode to ${nextMode}`}
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-secondary)] transition-colors hover:bg-[color:var(--bg-surface-2)] hover:text-[color:var(--text-primary)]",
          className
        )}
      >
        <ActiveIcon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Theme mode"
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-1",
        className
      )}
    >
      {OPTIONS.map(({ mode, label, icon: Icon }) => {
        const active = mode === theme;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            onClick={() => setMode(mode)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all",
              active
                ? "bg-[color:var(--bg-surface-3)] text-[color:var(--text-primary)]"
                : "text-[color:var(--text-secondary)] hover:bg-[color:var(--bg-surface-2)] hover:text-[color:var(--text-primary)]"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
