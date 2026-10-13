// shadcn-convention cn helper, dependency-free by design: the adoption card
// caps root additions at base-ui + lucide, so no clsx/tailwind-merge (vine
// msg 29). If a vendored component ever needs twMerge's conflict resolution,
// revisit with a fresh dep flag rather than quietly growing this.
//
// Base UI lets a `className` be a function of the component's state, so the
// joiner accepts one: when any input is a function the result is a function that
// resolves every input against the state, and otherwise it is a plain string.

export type ClassValue = string | number | null | undefined | false;

export type StateClass<S> = ClassValue | ((state: S) => string | undefined);

export function cn(...inputs: ClassValue[]): string;
export function cn<S>(...inputs: StateClass<S>[]): string | ((state: S) => string);
export function cn<S>(...inputs: StateClass<S>[]): string | ((state: S) => string) {
  const join = (state?: S) =>
    inputs
      .map((i) => (typeof i === "function" ? i(state as S) : i))
      .filter(Boolean)
      .join(" ");
  return inputs.some((i) => typeof i === "function") ? (state: S) => join(state) : join();
}
