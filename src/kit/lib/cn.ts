// shadcn-convention cn helper, dependency-free by design: the adoption card
// caps root additions at base-ui + lucide, so no clsx/tailwind-merge (vine
// msg 29). If a vendored component ever needs twMerge's conflict resolution,
// revisit with a fresh dep flag rather than quietly growing this.

export type ClassValue = string | number | null | undefined | false;

export function cn(...inputs: ClassValue[]): string {
  return inputs.filter(Boolean).join(" ");
}
