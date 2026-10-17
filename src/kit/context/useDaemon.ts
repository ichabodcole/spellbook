import { useEffect, useState, useSyncExternalStore } from "react";
import { createDaemonClient, type Daemon, type DaemonOptions } from "./daemonClient.ts";

/**
 * The surface's connection to its daemon, for the component that mounts the
 * workspace shell: it connects on mount, reconnects on its own, and closes on
 * unmount. The object it returns changes whenever the state, the connection or
 * anything else the surface reads changes, and its functions stay the same.
 *
 * `options` is read once, on the first render.
 */
export function useDaemon(options?: DaemonOptions): Daemon {
  const [client] = useState(() => createDaemonClient(options));
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}
