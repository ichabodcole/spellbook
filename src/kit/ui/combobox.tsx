import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import * as React from "react";
import { cn } from "../lib/cn";

/**
 * A closed control that opens to a searchable list. The spell passes `items`, a
 * `filter` that decides what a search keeps, and `itemToStringLabel`; the parts
 * below render whatever the spell gives them.
 */
function Combobox<Value, Multiple extends boolean | undefined = false>({
  ...props
}: ComboboxPrimitive.Root.Props<Value, Multiple>) {
  return <ComboboxPrimitive.Root data-slot="combobox" {...props} />;
}

/** The closed control: its children show the chosen value, `placeholder` shows when there is none. */
function ComboboxTrigger({
  className,
  children,
  placeholder,
  ...props
}: ComboboxPrimitive.Trigger.Props & { placeholder?: React.ReactNode }) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md border border-edge bg-bg px-2 py-1 text-left text-xs text-ink outline-none transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 data-popup-open:bg-surface-raised",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">
        {children ?? <span className="text-ink-faint">{placeholder}</span>}
      </span>
      <ChevronsUpDownIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
    </ComboboxPrimitive.Trigger>
  );
}

/** The popup under the trigger, as wide as the trigger; put `ComboboxInput` and `ComboboxList` in it. */
function ComboboxContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  ...props
}: ComboboxPrimitive.Popup.Props &
  Pick<ComboboxPrimitive.Positioner.Props, "side" | "align" | "sideOffset">) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        className="isolate z-50 outline-none"
        side={side}
        align={align}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          className={cn(
            "flex w-(--anchor-width) min-w-48 origin-(--transform-origin) flex-col overflow-hidden rounded-md border border-edge bg-bg text-ink shadow-md outline-none",
            className,
          )}
          {...props}
        />
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        "h-8 w-full min-w-0 shrink-0 border-0 border-b border-edge bg-transparent px-2 text-xs text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
        className,
      )}
      {...props}
    />
  );
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn(
        "max-h-56 min-h-0 overflow-y-auto overscroll-contain p-1 outline-none",
        className,
      )}
      {...props}
    />
  );
}

/** One choice. The chosen item is scrolled into view when the popup opens. */
function ComboboxItem({
  className,
  children,
  ref: forwardedRef,
  ...props
}: ComboboxPrimitive.Item.Props & { ref?: React.Ref<HTMLDivElement> }) {
  const own = React.useRef<HTMLDivElement | null>(null);
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      if (typeof forwardedRef === "function") forwardedRef(el);
      else if (forwardedRef) forwardedRef.current = el;
    },
    [forwardedRef],
  );
  React.useEffect(() => {
    const el = own.current;
    if (el?.hasAttribute("data-selected")) el.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <ComboboxPrimitive.Item
      ref={setRef}
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-start gap-1.5 rounded-sm px-2 py-1.5 text-xs outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-surface-raised",
        className,
      )}
      {...props}
    >
      {children}
    </ComboboxPrimitive.Item>
  );
}

/** The check on the chosen item. Its box is always there, so rows do not shift. */
function ComboboxItemIndicator({ ...props }: ComboboxPrimitive.ItemIndicator.Props) {
  return (
    <span aria-hidden className="mt-0.5 size-3 shrink-0 text-brand">
      <ComboboxPrimitive.ItemIndicator data-slot="combobox-item-indicator" {...props}>
        <CheckIcon aria-hidden className="size-3" />
      </ComboboxPrimitive.ItemIndicator>
    </span>
  );
}

/**
 * A control that rides on an item without choosing it, such as a preview button:
 * its pointer events stop here, so the item never sees them.
 */
function ComboboxItemAction({
  className,
  onClick,
  onPointerDown,
  onPointerUp,
  onMouseDown,
  onMouseUp,
  ...props
}: React.ComponentProps<"button">) {
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <button
      type="button"
      data-slot="combobox-item-action"
      tabIndex={-1}
      className={cn(
        "shrink-0 rounded-sm p-0.5 text-ink-faint outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
        className,
      )}
      onPointerDown={(e) => {
        stop(e);
        onPointerDown?.(e);
      }}
      onPointerUp={(e) => {
        stop(e);
        onPointerUp?.(e);
      }}
      onMouseDown={(e) => {
        stop(e);
        onMouseDown?.(e);
      }}
      onMouseUp={(e) => {
        stop(e);
        onMouseUp?.(e);
      }}
      onClick={(e) => {
        stop(e);
        onClick?.(e);
      }}
      {...props}
    />
  );
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("px-2 py-2 text-xs text-ink-faint empty:hidden", className)}
      {...props}
    />
  );
}

export {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemAction,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
};
