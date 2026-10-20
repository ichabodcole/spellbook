// An image's description beside it in the viewer: its title, its one-line
// description and the start of its body, under an origin mark (an upload mark
// or a globe) whose hover lists where the image came from. The words
// come from the image's sidecar (`fox.png.md`), an ordinary document; "Edit
// description" opens it as one, so it is versioned and compared like any other.
//
// With no sidecar, a quiet "No description yet", and "Ask the agent to
// describe", which posts a chat message as the profile chip's "Ask the agent to
// fix" does: it takes no focus and leaves any selection where it was.
//
// The body is shown as plain text, never as markup: nothing in it is fetched or
// run. The globe opens only an http or https page, in a new tab, with no opener
// and no referrer.

import { CheckIcon, FilePenLineIcon, GlobeIcon, TriangleAlertIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/cn.ts";
import {
  IMAGE_SOURCES,
  type ImageDescription,
  type ImageSource,
  LICENCE_UNKNOWN,
  SOURCE_LABEL,
} from "../lib/sidecar.ts";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../ui/popover.tsx";

const ICON = { user: UploadIcon, web: GlobeIcon } as const;

/** A body's paragraphs: parted by a blank line, each with its line breaks made spaces. */
export function paragraphs(body: string): string[] {
  return body
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Open a source page as the chat opens an outward link: a new tab, no opener, no referrer. */
export function openPage(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * The origin mark: an upload mark for the user's own image, a globe for one
 * from the web. Hovering (or focusing) shows the
 * provenance fields; pressing the globe opens the source page. A web image
 * whose licence is unknown is amber.
 */
export function OriginMark({ description }: { description: ImageDescription }) {
  const [open, setOpen] = useState(false);
  const source: ImageSource | null = description.source;
  const amber = description.licenceUnknown === true;
  const Icon = source ? ICON[source] : TriangleAlertIcon;
  const label = source
    ? `${SOURCE_LABEL[source]}${amber ? ", licence unknown" : ""}`
    : description.sourceWritten
      ? `Origin "${description.sourceWritten}" is not one of ${IMAGE_SOURCES.join(" or ")}`
      : "Origin not recorded";
  const page = source === "web" ? description.page : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        data-slot="origin-mark"
        data-source={source ?? "none"}
        data-licence={amber ? "unknown" : undefined}
        aria-label={page ? `${label}: open the source page` : `${label}: show where it came from`}
        // The globe opens its page; the other marks only show their fields.
        onClick={page ? () => openPage(page) : undefined}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
          amber
            ? "bg-attention/15 text-attention ring-1 ring-attention/30 ring-inset hover:bg-attention/25"
            : source
              ? "text-ink-dim hover:bg-surface-raised hover:text-ink"
              : "text-ink-faint hover:bg-surface-raised",
        )}
      >
        <Icon aria-hidden className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        data-slot="origin-popover"
        className="w-[min(24rem,calc(100vw-1rem))]"
      >
        <PopoverTitle className="text-[13px]">{label}</PopoverTitle>
        {description.provenance.length > 0 ? (
          <dl data-slot="provenance" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {description.provenance.map(({ field, value }) => {
              const unknown = field === "licence" && value.toLowerCase() === LICENCE_UNKNOWN;
              return (
                <div key={field} data-field={field} className="contents">
                  <dt className="font-mono text-[10px] leading-5 text-ink-faint">{field}</dt>
                  <dd
                    className={cn(
                      "min-w-0 text-[12px] leading-5 break-words",
                      unknown ? "font-medium text-attention" : "text-ink",
                    )}
                  >
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : (
          <p className="mt-1 text-[12px] text-ink-dim">
            {source
              ? "No fields recorded yet."
              : "The description does not say where it came from."}
          </p>
        )}
        {amber && (
          <p data-slot="licence-unknown" className="mt-2 text-[12px] text-attention">
            The licence was not found. Check it before anything using this image is published.
          </p>
        )}
        {page && (
          <a
            href={page}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="source-page"
            className="mt-2 inline-flex items-center gap-1 text-[12px] text-brand underline-offset-2 hover:underline"
          >
            <GlobeIcon aria-hidden className="size-3" />
            Open the source page
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The description panel the viewer shows beside the image. `description`
 * absent: "No description yet", with "Ask the agent to describe" when `onAsk`
 * is given.
 */
export function ImageDescriptionPanel({
  name,
  description,
  onEdit,
  onAsk,
}: {
  /** The image's file name: the heading when the description has no title. */
  name: string;
  description?: ImageDescription;
  /** Open the sidecar as a document. */
  onEdit?: (path: string) => void;
  /** Post "please describe this" to the chat. */
  onAsk?: () => void;
}) {
  const [asked, setAsked] = useState(false);
  if (!description)
    return (
      <aside
        data-slot="image-description"
        data-state="none"
        className="flex flex-col gap-1.5 p-3 text-xs text-ink-dim"
      >
        <p data-slot="no-description" className="text-ink-faint">
          No description yet
        </p>
        {onAsk && (
          <button
            type="button"
            data-slot="describe-ask"
            aria-label={
              asked ? `Asked the agent to describe ${name}` : `Ask the agent to describe ${name}`
            }
            // Not `disabled`: a focused button that disables drops focus to the page.
            aria-disabled={asked || undefined}
            // Held back so the press neither takes focus nor collapses a selection.
            onMouseDown={(e) => e.preventDefault()}
            onClick={
              asked
                ? undefined
                : () => {
                    onAsk();
                    setAsked(true);
                  }
            }
            className={cn(
              "inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              asked ? "text-ink-faint" : "-ml-1.5 text-brand hover:bg-brand/10",
            )}
          >
            {asked ? (
              <>
                <CheckIcon aria-hidden className="size-3" />
                Asked in the chat
              </>
            ) : (
              "Ask the agent to describe"
            )}
          </button>
        )}
      </aside>
    );
  return (
    <aside
      data-slot="image-description"
      data-state="described"
      className="flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain p-3 text-xs"
    >
      <div className="flex items-start gap-2">
        <OriginMark description={description} />
        <h2
          data-slot="description-title"
          className="min-w-0 flex-1 pt-0.5 text-sm font-medium leading-5 break-words text-ink"
        >
          {description.title ?? name}
        </h2>
        {onEdit && (
          <button
            type="button"
            data-slot="description-edit"
            onClick={() => onEdit(description.path)}
            aria-label="Edit description"
            title="Edit the description (opens it as a document)"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-faint outline-none hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <FilePenLineIcon aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      {description.summary && (
        <p data-slot="description-summary" className="text-[12px] leading-5 text-ink">
          {description.summary}
        </p>
      )}
      {description.body && (
        // Paragraphs as markdown reads them: a blank line parts two, and a
        // single line break inside one is a space, so the source's wrapping
        // does not show.
        <div data-slot="description-body" className="flex flex-col gap-2">
          {paragraphs(description.body).map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the paragraphs of one text, in order.
            <p key={i} className="text-[12px] leading-5 text-ink-dim">
              {p}
            </p>
          ))}
        </div>
      )}
      {description.more && onEdit && (
        <button
          type="button"
          onClick={() => onEdit(description.path)}
          className="w-fit text-[11px] text-brand outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Read the whole description
        </button>
      )}
      {description.unparsed && (
        <p data-slot="description-unparsed" className="text-[11px] text-attention">
          Its frontmatter {description.unparsed}.
        </p>
      )}
    </aside>
  );
}
