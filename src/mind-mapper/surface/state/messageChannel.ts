// R11 SEAM 3/4 — the message CHANNEL vocabulary, pure half.
//
// The channel rides on the wire's `kind` field (Contract 11 / lead pre-ruling):
// "turn" = typed in the chat composer, "canvas" = the right-click freeform
// ramble, "analyze" = sent from a doc. `kind` is open on the wire, so an
// unknown channel must render honestly rather than crash or vanish — every
// lookup here has a fallback keyed on the raw string.
//
// This module is the ONE place the channel string literals live: if the wire
// ever moves the channel off `kind` onto its own field, App's toDisplayMessage
// changes and these constants stay put.
//
// Tailwind class strings are LITERAL lookup objects (never string-built) — the
// `@source` scan only sees literal text.

import type { Message } from "../types";

// The default channel: a message typed into the composer. The daemon already
// defaults `kind` to this (server.ts POST /send), so it is the wire's word,
// not ours.
export const CHAT_CHANNEL = "turn";

// The canvas ramble (drive-9 F1): the human's INTENT, not a node.
export const CANVAS_CHANNEL = "canvas";

// Z3 carry-over (SEAM 4): a ramble made while a zone board is showing rides
// the zone as a ground ref. Contract 9's ground grammar is a prefixed
// vocabulary the engine stores VERBATIM and unknown prefixes are
// tolerated-and-dropped by consumers — so this needs no engine change and
// degrades to invisible on any consumer that doesn't know it.
export const ZONE_GROUND_PREFIX = "zone:";

// A side channel is anything that did NOT come from the composer — the
// messages that render recognizably different and collapsed.
export function isSideChannel(channel: string): boolean {
  return channel !== CHAT_CHANNEL;
}

const CHANNEL_LABEL: Record<string, string> = {
  canvas: "canvas",
  analyze: "analyze",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

const CHANNEL_TITLE: Record<string, string> = {
  canvas: "sent from the canvas — a freeform ramble, not a node",
  analyze: "sent from a document",
  turn: "typed in the chat",
};

export function channelTitle(channel: string): string {
  return CHANNEL_TITLE[channel] ?? `sent via ${channel}`;
}

// The chip tint reuses the existing categorical vocabulary rather than minting
// a palette (the house reflex): canon for a canvas ramble (it's the human's
// own assertion-in-waiting), story-local for an analyze ask, a neutral plate
// for a channel this build doesn't know.
export const CHANNEL_CHIP: Record<string, string> = {
  canvas: "border-canon/50 text-canon",
  analyze: "border-story-local/50 text-story-local",
  turn: "border-edge text-ink-dim",
};

export const CHANNEL_CHIP_FALLBACK = "border-edge text-ink-dim";

export function channelChipClass(channel: string): string {
  return CHANNEL_CHIP[channel] ?? CHANNEL_CHIP_FALLBACK;
}

// Below this length there is nothing to gain by collapsing — a one-line
// ramble reads the same collapsed or not, and a collapse affordance on it is
// pure noise.
const COLLAPSE_MIN_CHARS = 90;

// Cole's rule (drive-9 F2): "I already know the content of them and I don't
// necessarily need to see that in a chat history." That is true of what the
// HUMAN sent through another channel — and false of everything the AGENT says
// (that's the half of the log the human hasn't read). So: side-channel USER
// messages collapse; agent messages never do. This is the falsification of
// "possibly ALL messages collapsible" — collapsing agent replies would stop
// the log reading as a conversation, the one thing SEAM 3 must not break.
export function collapsesByDefault(message: Message): boolean {
  if (message.who !== "user") return false;
  if (!isSideChannel(message.channel)) return false;
  return message.text.length >= COLLAPSE_MIN_CHARS;
}

// The one-line stand-in shown while collapsed.
export function messageSummary(text: string, max = 72): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  // A single unbroken word has no boundary to cut on — hard-cut rather than
  // return an empty summary.
  const body = space > max / 3 ? cut.slice(0, space) : cut;
  return `${body}…`;
}

// Facet options derive from the log itself, present-only (the FILTER
// convention, R7): no empty bucket, and an option can't vanish as you select
// it. Chat leads; the rest sort, so the strip never reorders as you send.
export function channelFacets(messages: Message[]): string[] {
  const present = new Set(messages.map((m) => m.channel));
  const rest = [...present].filter(isSideChannel).sort();
  return present.has(CHAT_CHANNEL) ? [CHAT_CHANNEL, ...rest] : rest;
}

// OR-within, and an empty selection means "no filter" (the MapFilter rule).
export function filterByChannel(messages: Message[], channels: string[]): Message[] {
  if (channels.length === 0) return messages;
  return messages.filter((m) => channels.includes(m.channel));
}
