import type { ButtonHTMLAttributes } from "react";

// The filled/ghost CTAs. On the old CDN surface these were @apply component
// classes that silently no-op'd — here they're real inline @theme utilities, so
// the buttons actually render (the inert-@apply bug fix).
const VARIANTS = {
  primary:
    "bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50",
  ghost: "px-2.5 py-1.5 text-sm font-medium text-ink-2 hover:bg-surface-3",
} as const;

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS };

export function Button({ variant = "primary", className = "", ...props }: Props) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-control transition-colors ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  );
}
