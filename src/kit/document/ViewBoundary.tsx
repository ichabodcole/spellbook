// A fence around a document view. A view that throws while it draws (or in a
// layout effect) would otherwise unmount the whole React tree and leave the page
// blank, taking the chat, the context and Save with it. Here it costs only that
// view, which says what went wrong and offers to draw again.

import { TriangleAlertIcon } from "lucide-react";
import { Component, type ReactNode } from "react";

export class ViewBoundary extends Component<
  {
    children: ReactNode;
    /** A new key is a new view: the failure is forgotten. */
    resetKey?: string;
  },
  { error: Error | null; key?: string }
> {
  override state: { error: Error | null; key?: string } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error: Error | null; key?: string },
  ) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        data-slot="view-failed"
        className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-ink-dim"
      >
        <TriangleAlertIcon aria-hidden className="size-4 text-attention" />
        <p>This view could not be drawn: {error.message}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded-md border border-edge px-2 py-1 text-xs text-ink hover:bg-surface-raised"
        >
          Try again
        </button>
      </div>
    );
  }
}
