// Which keyboard the human has, for shortcut hints and for the shortcuts
// themselves. In `lib` so the search box, the selection menu and the link
// picker all name a shortcut the same way.

/** Whether this is a Mac, where `Mod` is Cmd and Ctrl belongs to the editor. */
export function onMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform ?? "");
}

/** The link shortcut (`Mod-Shift-K`) as this platform writes it. */
export function linkShortcutLabel(mac: boolean = onMac()): string {
  return mac ? "⌘⇧K" : "Ctrl Shift K";
}
