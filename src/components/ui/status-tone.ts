export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "running";

export const statusToneClass: Record<StatusTone, string> = {
  neutral:
    "border-[color:var(--border-default)] bg-[color:var(--bg-surface-2)] text-[color:var(--text-secondary)]",
  info:
    "border-[color:color-mix(in srgb, var(--brand) 35%, transparent)] bg-[color:color-mix(in srgb, var(--brand) 12%, transparent)] text-[color:var(--brand-strong)]",
  success:
    "border-[color:color-mix(in srgb, var(--success) 35%, transparent)] bg-[color:color-mix(in srgb, var(--success) 12%, transparent)] text-[color:var(--success)]",
  warning:
    "border-[color:color-mix(in srgb, var(--warning) 38%, transparent)] bg-[color:color-mix(in srgb, var(--warning) 14%, transparent)] text-[color:var(--warning)]",
  danger:
    "border-[color:color-mix(in srgb, var(--error) 36%, transparent)] bg-[color:color-mix(in srgb, var(--error) 14%, transparent)] text-[color:var(--error)]",
  running:
    "border-[color:color-mix(in srgb, var(--brand-accent) 32%, transparent)] bg-[color:color-mix(in srgb, var(--brand-accent) 14%, transparent)] text-[color:var(--brand-accent)]",
};
