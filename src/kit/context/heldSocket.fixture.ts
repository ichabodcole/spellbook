// A real WebSocket whose incoming frames a test can hold back, for tests that
// must decide what the client has seen when it sends: a frame the daemon has
// already sent waits here until `release`, in order. Outgoing frames are never
// held. Give its `WebSocket` to `createDaemonClient` or `useDaemon`.

type Handler = ((ev: MessageEvent) => void) | null;

export function heldSocket(base: typeof WebSocket = globalThis.WebSocket) {
  let holding = false;
  const queue: { socket: HeldSocket; ev: MessageEvent }[] = [];

  class HeldSocket extends base {
    #handler: Handler = null;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (ev: MessageEvent) => {
        if (holding) queue.push({ socket: this, ev });
        else this.#handler?.(ev);
      });
    }
    override get onmessage(): Handler {
      return this.#handler;
    }
    override set onmessage(fn: Handler) {
      this.#handler = fn;
    }
    deliver(ev: MessageEvent) {
      this.#handler?.(ev);
    }
  }

  return {
    WebSocket: HeldSocket as unknown as typeof WebSocket,
    /** Hold every frame that arrives from now on. */
    hold() {
      holding = true;
    },
    /** Hand on what was held, in order, and stop holding. */
    release() {
      holding = false;
      for (const { socket, ev } of queue.splice(0)) socket.deliver(ev);
    },
  };
}
