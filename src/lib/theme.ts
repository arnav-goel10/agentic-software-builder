export type ThemeMode = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "dexter-theme-mode";

export const THEME_MODES: ThemeMode[] = ["light", "system", "dark"];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}
