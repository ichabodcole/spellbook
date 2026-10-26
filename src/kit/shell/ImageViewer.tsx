// The centre's image viewer: one image, fitted to the pane, with pan and zoom.
//
// - FITTED when it loads and whenever the pane resizes, never enlarged past its
//   own size (a small image shows at 100%, centred);
// - the wheel zooms about the pointer, and so does a trackpad pinch; a
//   two-finger scroll pans; so does a drag (the same reading of a wheel as the
//   map's, from `lib/viewport.ts`);
// - "+", "−", "0" (fit) and "1" (actual size) from the keyboard or the buttons,
//   and a double click toggles fit and actual size about the pointer;
// - zoomed past 200% the pixels stay sharp, so pixel art reads as pixel art;
// - a footer says its name, its pixel size, its weight on disk, its type and
//   the zoom;
// - beside the image (under it, in a narrow pane), what an app puts in `aside`:
//   the shell puts the image's description there.
//
// It only shows: an image is not edited, versioned or compared here. Its bytes
// come from the daemon's guarded file route (`src`), never read as text.

import { XIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn.ts";
import { imageTypeLabel } from "../lib/docFormat.ts";
import {
  fitView,
  type Size,
  type View,
  wheelView,
  ZOOM_STEP,
  type ZoomLimits,
  zoomAt,
} from "../lib/viewport.ts";
import { usePaneSize } from "./usePaneSize.ts";

/** How far an image zooms: far enough out for a large photograph, in to see its pixels. */
export const IMAGE_ZOOM: ZoomLimits = { min: 0.02, max: 16 };
/** From this zoom up the pixels are drawn square, not smoothed. */
export const PIXELATED_FROM = 2;

/** "2.4 MB", "640 KB", "312 bytes": a file's weight as a person reads it. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} ${n === 1 ? "byte" : "bytes"}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export type ImageViewerProps = {
  /** The file's name, for the footer and the image's alt text. */
  name: string;
  /** Where its bytes are served. A new `src` is a new image (or a changed one). */
  src: string;
  /** Bytes on disk. */
  size: number;
  /** What the bytes are (`image/png`), or null when they are no image the viewer shows. */
  type: string | null;
  /** Put the image away. Absent, there is no Close button. */
  onClose?: () => void;
  /** Drawn in the footer after the type: where the image is used (`ImageLinkedFrom`). */
  footer?: ReactNode;
  /** Drawn beside the image, or under it in a narrow pane: its description (`ImageDescriptionPanel`). */
  aside?: ReactNode;
  className?: string;
};

export function ImageViewer({
  name,
  src,
  size,
  type,
  onClose,
  footer,
  aside,
  className,
}: ImageViewerProps) {
  const pane = useRef<HTMLDivElement>(null);
  const paneSize = usePaneSize(pane);
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  // A new image (or the same name, changed) starts unknown again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `src` is the trigger.
  useEffect(() => {
    setNatural(null);
    setFailed(false);
  }, [src]);

  const fit = (): View =>
    natural
      ? fitView(paneSize, natural, { ceil: 1, floor: IMAGE_ZOOM.min, limits: IMAGE_ZOOM })
      : { k: 1, x: 0, y: 0 };
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  // Fitted when it loads, and again whenever the pane changes size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sizes are the trigger.
  useLayoutEffect(() => {
    setView(fit());
  }, [paneSize.w, paneSize.h, natural?.w, natural?.h]);

  // The wheel, listened to directly and not passively, so the page never
  // scrolls or zooms under the image.
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      const cx = (Number.isFinite(e.clientX) ? e.clientX : 0) - box.left;
      const cy = (Number.isFinite(e.clientY) ? e.clientY : 0) - box.top;
      setView((v) => wheelView(v, e, cx, cy, IMAGE_ZOOM));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const zoomBy = (factor: number) =>
    setView((v) => zoomAt(v, factor, paneSize.w / 2, paneSize.h / 2, IMAGE_ZOOM));
  /** Actual size, keeping the pane point (`cx`, `cy`) where it is. */
  const actualAt = (cx: number, cy: number) =>
    setView((v) => zoomAt(v, 1 / v.k, cx, cy, IMAGE_ZOOM));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / ZOOM_STEP);
    else if (e.key === "0") setView(fit());
    else if (e.key === "1") actualAt(paneSize.w / 2, paneSize.h / 2);
    else return;
    e.preventDefault();
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const v = viewRef.current;
    pan.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y };
    setPanning(true);
  };
  const endPan = () => {
    pan.current = null;
    setPanning(false);
  };

  const fitted = natural ? fit() : null;
  const isFit =
    fitted !== null &&
    Math.abs(fitted.k - view.k) < 1e-6 &&
    Math.abs(fitted.x - view.x) < 0.5 &&
    Math.abs(fitted.y - view.y) < 0.5;
  // A zoom button: square for − and +, as wide as its word for fit and 1:1.
  // Each names its own size, since the kit's cn only joins classes.
  const control =
    "flex items-center justify-center rounded-sm text-xs text-ink-dim outline-none hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60";
  const button = cn(control, "size-6");
  const wordButton = cn(control, "h-6 px-1.5");
  const kind = type ? imageTypeLabel(type) : "not an image";

  return (
    <div data-slot="image-viewer" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {/* The image and what is said about it: side by side in a wide pane,
          stacked in a narrow one. */}
      <div className="@container flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
          {/* A widget that takes its own keys (pan and zoom), so it takes focus. */}
          <div
            ref={pane}
            role="application"
            aria-roledescription="image viewer"
            aria-label={`${name}: drag or scroll to pan, pinch or press + and − to zoom, 0 to fit`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: it takes its own keys, so it must take focus.
            tabIndex={0}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={(e) => {
              const p = pan.current;
              if (p)
                setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
            }}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onDoubleClick={(e) => {
              if (!isFit) return setView(fit());
              const box = e.currentTarget.getBoundingClientRect();
              actualAt(e.clientX - box.left, e.clientY - box.top);
            }}
            data-zoom={view.k.toFixed(3)}
            className={cn(
              "relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden outline-none select-none",
              "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
              panning ? "cursor-grabbing" : "cursor-grab",
            )}
            // A checkerboard in the theme's own surfaces, so a transparent image
            // shows its edges in light and dark alike.
            style={{
              backgroundColor: "var(--color-bg)",
              backgroundImage:
                "conic-gradient(var(--color-surface-raised) 25%, transparent 0 50%, var(--color-surface-raised) 0 75%, transparent 0)",
              backgroundSize: "16px 16px",
            }}
          >
            {failed || type === null ? (
              <p
                data-slot="image-failed"
                className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-ink-dim"
              >
                {type === null
                  ? `${name} is not a PNG, JPEG, WebP, GIF or AVIF image inside, so it is not shown.`
                  : `${name} could not be shown: this browser cannot read it, or the file is damaged.`}
              </p>
            ) : (
              <img
                src={src}
                alt={name}
                draggable={false}
                data-slot="image"
                onLoad={(e) => {
                  const img = e.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0)
                    setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                }}
                onError={() => setFailed(true)}
                className={cn("absolute top-0 left-0 max-w-none", !natural && "invisible")}
                style={{
                  transformOrigin: "0 0",
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
                  imageRendering: view.k >= PIXELATED_FROM ? "pixelated" : "auto",
                  ...(natural ? { width: natural.w, height: natural.h } : {}),
                }}
              />
            )}
            <div
              role="toolbar"
              aria-label="Zoom"
              className="absolute right-2 bottom-2 flex items-center gap-0.5 rounded-md border border-edge bg-surface p-0.5 shadow-sm"
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className={button}
                aria-label="Zoom out (−)"
                title="Zoom out (−)"
                onClick={() => zoomBy(1 / ZOOM_STEP)}
              >
                −
              </button>
              <button
                type="button"
                className={button}
                aria-label="Zoom in (+)"
                title="Zoom in (+)"
                onClick={() => zoomBy(ZOOM_STEP)}
              >
                +
              </button>
              <button
                type="button"
                className={wordButton}
                aria-label="Fit the image to the pane (0)"
                title="Fit the image to the pane (0)"
                onClick={() => setView(fit())}
              >
                fit
              </button>
              <button
                type="button"
                className={wordButton}
                aria-label="Actual size (1)"
                title="Actual size (1)"
                onClick={() => actualAt(paneSize.w / 2, paneSize.h / 2)}
              >
                1:1
              </button>
            </div>
          </div>
          {aside && (
            <div
              data-slot="image-aside"
              className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-edge bg-surface @2xl:max-h-none @2xl:w-72 @2xl:border-t-0 @2xl:border-l"
            >
              {aside}
            </div>
          )}
        </div>
      </div>
      <footer
        data-slot="image-footer"
        className="flex h-7 shrink-0 items-center gap-3 border-t border-edge bg-surface px-3 text-xs text-ink-dim"
      >
        <span className="min-w-0 truncate font-medium text-ink">{name}</span>
        <span data-slot="image-dimensions" className="shrink-0 tabular-nums">
          {natural ? `${natural.w} × ${natural.h} px` : "…"}
        </span>
        <span data-slot="image-size" className="shrink-0 tabular-nums">
          {formatBytes(size)}
        </span>
        <span data-slot="image-type" className="shrink-0">
          {kind}
        </span>
        {footer}
        <span data-slot="image-zoom" className="ml-auto shrink-0 tabular-nums">
          {Math.round(view.k * 100)}%
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${name}`}
            title="Close the image"
            className="-mr-1.5 flex size-6 items-center justify-center rounded-sm text-ink-faint outline-none hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </footer>
    </div>
  );
}
