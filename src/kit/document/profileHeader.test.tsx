// The frontmatter header with a document's profile, in a DOM: the kind chip shows
// the profile's label and names its files on hover, the warnings collapse into
// one amber chip whose popover lists each one with the file whose rule it is,
// "Ask the agent to fix" hands over the message and moves nothing, a broken
// kind gets a quiet chip with why, and no profile leaves the header exactly as
// it was.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { DocumentProfile } from "../workspace/protocol";
import { FrontmatterHeader } from "./FrontmatterHeader.tsx";
import { readFrontmatter } from "./frontmatter.ts";
import { askBrokenText, askFixText, profileFor, warningCountLabel } from "./profileHeader.ts";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const TEXT = [
  "---",
  "type: location",
  "title: The Glade",
  "status: final",
  "tags: [forest]",
  "region: centre",
  "---",
  "",
  "# The Glade",
  "",
].join("\n");

const fm = (text = TEXT) => {
  const f = readFrontmatter(text);
  if (!f) throw new Error("no block");
  return f;
};

const MATCHED: DocumentProfile = {
  doc: "the-glade",
  path: "/w/locations/the-glade.md",
  shown: "locations/the-glade.md",
  type: "location",
  kind: "location",
  match: "matched",
  label: "Location",
  canon: true,
  source: "/w/_meta/profiles/location.json",
  sourceShown: "_meta/profiles/location.json",
  refs: ["_meta/profiles/_bible-doc.json"],
  warnings: [
    {
      field: "description",
      rule: "required",
      message: "description is missing; the Location profile requires it",
      file: "/w/_meta/profiles/_bible-doc.json",
      fileShown: "_meta/profiles/_bible-doc.json",
      fix: "add `description` to the frontmatter (One sentence.)",
    },
    {
      field: "status",
      rule: "enum",
      message: 'status is "final", which is not one of draft, stable, deprecated',
      file: "/w/_meta/profiles/_bible-doc.json",
      fileShown: "_meta/profiles/_bible-doc.json",
      fix: "set `status` to one of draft, stable, deprecated",
    },
  ],
};

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const chipLabels = (root: Element) =>
  [...root.querySelectorAll("[data-chip], [data-slot=profile-chip]")].map((c) => c.textContent);

describe("the kind chip", () => {
  test("shows the profile's label where the raw type was, and names its files on hover", async () => {
    const m = await mount(<FrontmatterHeader frontmatter={fm()} profile={MATCHED} />);
    const type = m.container.querySelector("[data-chip=type]");
    expect(type?.textContent).toBe("Location");
    expect(type?.getAttribute("title")).toBe(
      "Location profile, from _meta/profiles/location.json\nShared fields from _meta/profiles/_bible-doc.json",
    );
    // `type` is still claimed: it is not listed again below.
    expect([...m.container.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["region"]);
  });

  test("a kind that is not canon gets a quiet chip just after its label", async () => {
    const m = await mount(
      <FrontmatterHeader frontmatter={fm()} profile={{ ...MATCHED, canon: false }} />,
    );
    const next = m.container.querySelector("[data-chip=type]")?.nextElementSibling;
    expect(next?.textContent).toBe("not canon");
    expect(next?.className).toContain("text-ink-faint");
    expect(next?.getAttribute("title")).toContain('"canon": false');
    const canon = await mount(<FrontmatterHeader frontmatter={fm()} profile={MATCHED} />);
    expect(canon.container.textContent).not.toContain("not canon");
  });

  test("an app's chip slot sees the label, so a restyle keeps it", async () => {
    let seen: unknown;
    await mount(
      <FrontmatterHeader
        frontmatter={fm()}
        profile={MATCHED}
        chips={(_f, chips) => {
          seen = chips.find((c) => c.key === "type")?.label;
          return chips;
        }}
      />,
    );
    expect(seen).toBe("Location");
  });

  test("an answer for another type (the human just changed it) is not applied", async () => {
    const m = await mount(
      <FrontmatterHeader frontmatter={fm(TEXT.replace("location", "ritual"))} profile={MATCHED} />,
    );
    expect(m.container.querySelector("[data-chip=type]")?.textContent).toBe("ritual");
    expect(m.container.querySelector("[data-slot=profile-chip]")).toBeNull();
  });
});

describe("the warning chip", () => {
  test("collapses the warnings into one amber chip, with the count in words", async () => {
    const m = await mount(<FrontmatterHeader frontmatter={fm()} profile={MATCHED} />);
    const chip = m.container.querySelector("[data-slot=profile-chip]");
    expect(chip?.textContent).toBe("2 profile warnings");
    expect(chip?.className).toContain("text-attention");
    expect(chip?.className).not.toContain("danger");
    expect(chipLabels(m.container)).toEqual(["Location", "final", "2 profile warnings"]);
    expect(warningCountLabel(1)).toBe("1 profile warning");
  });

  test("no warnings, no chip", async () => {
    const m = await mount(
      <FrontmatterHeader frontmatter={fm()} profile={{ ...MATCHED, warnings: [] }} />,
    );
    expect(m.container.querySelector("[data-slot=profile-chip]")).toBeNull();
    expect(m.container.querySelector("[data-chip=type]")?.textContent).toBe("Location");
  });

  test("opening it lists each warning with the file whose rule it is", async () => {
    const m = await mount(<FrontmatterHeader frontmatter={fm()} profile={MATCHED} />);
    await click(m.container.querySelector("[data-slot=profile-chip]"));
    await waitFor(() => q("[data-slot=profile-popover]") !== null, "the popover");
    const items = [...document.querySelectorAll("[data-slot=profile-warning]")];
    expect(items.map((i) => [i.getAttribute("data-field"), i.getAttribute("data-rule")])).toEqual([
      ["description", "required"],
      ["status", "enum"],
    ]);
    expect(items[0]?.textContent).toContain(
      "Description is missing; the Location profile requires it.",
    );
    expect(
      items.map((i) => i.querySelector("[data-slot=profile-warning-file]")?.textContent),
    ).toEqual(["_meta/profiles/_bible-doc.json", "_meta/profiles/_bible-doc.json"]);
    expect(q("[data-slot=profile-popover]")?.textContent).toContain("saving is never blocked");
  });

  test("Ask the agent to fix hands over the message, says it was asked, and moves nothing", async () => {
    const asked: string[] = [];
    const m = await mount(
      <FrontmatterHeader
        frontmatter={fm()}
        profile={MATCHED}
        onAskProfileFix={(text) => asked.push(text)}
      />,
    );
    await click(m.container.querySelector("[data-slot=profile-chip]"));
    await waitFor(() => q("[data-slot=profile-popover]") !== null, "the popover");
    const focusBefore = document.activeElement;
    const button = document.querySelectorAll("[data-slot=profile-ask]")[1] as HTMLElement;
    // The press is held back, so it takes no focus and collapses no selection.
    const down = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    button.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await click(button);
    expect(asked).toEqual([askFixText(MATCHED, MATCHED.warnings[1] as never)]);
    expect(asked[0]).toBe(
      'Please fix this profile warning in locations/the-glade.md: Status is "final", which is not one of draft, stable, deprecated. The rule is in _meta/profiles/_bible-doc.json. Suggested fix: Set `status` to one of draft, stable, deprecated.',
    );
    expect(document.activeElement).toBe(focusBefore);
    expect(button.textContent).toBe("Asked in the chat");
    // Asked once: a second press posts nothing more.
    await click(button);
    expect(asked).toHaveLength(1);
  });
});

describe("a broken kind", () => {
  const BROKEN: DocumentProfile = {
    ...MATCHED,
    match: "broken",
    label: undefined,
    refs: undefined,
    warnings: [],
    reason: "it is not JSON: Unexpected token at line 3",
  };

  test("keeps the raw type and shows a quiet chip, with the reason and the file in its popover", async () => {
    const asked: string[] = [];
    const m = await mount(
      <FrontmatterHeader
        frontmatter={fm()}
        profile={BROKEN}
        onAskProfileFix={(text) => asked.push(text)}
      />,
    );
    expect(m.container.querySelector("[data-chip=type]")?.textContent).toBe("location");
    const chip = m.container.querySelector("[data-slot=profile-chip]");
    expect(chip?.textContent).toBe("profile broken");
    expect(chip?.className).not.toContain("attention");
    await click(chip);
    await waitFor(() => q("[data-slot=profile-popover]") !== null, "the popover");
    expect(q("[data-slot=profile-reason]")?.textContent).toBe(
      "It is not JSON: Unexpected token at line 3.",
    );
    expect(q("[data-slot=profile-popover]")?.textContent).toContain("_meta/profiles/location.json");
    await click(q("[data-slot=profile-ask]"));
    expect(asked).toEqual([askBrokenText(BROKEN)]);
  });

  test("broken only through a shared file, it names the shared file as the one to fix", async () => {
    const through: DocumentProfile = {
      ...BROKEN,
      reason: "refers to _bible-doc.json, which has an error: does not parse as JSON",
      through: "/w/_meta/profiles/_bible-doc.json",
      throughShown: "_meta/profiles/_bible-doc.json",
    };
    const asked: string[] = [];
    const m = await mount(
      <FrontmatterHeader
        frontmatter={fm()}
        profile={through}
        onAskProfileFix={(text) => asked.push(text)}
      />,
    );
    await click(m.container.querySelector("[data-slot=profile-chip]"));
    await waitFor(() => q("[data-slot=profile-popover]") !== null, "the popover");
    expect(q("[data-slot=profile-broken-file]")?.textContent).toBe(
      "_meta/profiles/_bible-doc.json",
    );
    await click(q("[data-slot=profile-ask]"));
    expect(asked).toEqual([
      "The profile for locations/the-glade.md is broken, so it is not checked: _meta/profiles/_bible-doc.json cannot be used (refers to _bible-doc.json, which has an error: does not parse as JSON). _meta/profiles/location.json refers to it, so the fix goes in the shared file. Please fix _meta/profiles/_bible-doc.json.",
    ]);
  });
});

describe("many warnings", () => {
  test("the popover is capped to the room there is, and its list scrolls under a fixed title", async () => {
    const many: DocumentProfile = {
      ...MATCHED,
      warnings: Array.from({ length: 25 }, (_, i) => ({
        field: `field_${i}`,
        rule: "required" as const,
        message: `field_${i} is missing; the Location profile requires it`,
        fileShown: "_meta/profiles/location.json",
      })),
    };
    const m = await mount(<FrontmatterHeader frontmatter={fm()} profile={many} />);
    expect(m.container.querySelector("[data-slot=profile-chip]")?.textContent).toBe(
      "25 profile warnings",
    );
    await click(m.container.querySelector("[data-slot=profile-chip]"));
    await waitFor(() => q("[data-slot=profile-popover]") !== null, "the popover");
    const pop = q("[data-slot=profile-popover]");
    // No layout here to measure, so the rule is read: capped by the positioner's
    // available height, a column whose list is the part that scrolls.
    expect(pop?.className).toContain("max-h-[min(var(--available-height,32rem),32rem)]");
    expect(pop?.className).toContain("flex-col");
    const list = q("[data-slot=profile-warnings]");
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("min-h-0");
    expect(list?.querySelectorAll("[data-slot=profile-warning]")).toHaveLength(25);
    // The title is outside the scrolling list, so it stays in view.
    expect(list?.contains(q("[data-slot=popover-title]"))).toBe(false);
    expect(pop?.contains(q("[data-slot=popover-title]"))).toBe(true);
  });
});

describe("a stale answer", () => {
  test("is shown only for the document and the version it was read from", () => {
    const doc = { slug: "the-glade", active: 2 };
    expect(profileFor({ ...MATCHED, version: 2 }, doc)).not.toBeNull();
    // Another version made active: the old version's answer is not shown.
    expect(profileFor({ ...MATCHED, version: 1 }, doc)).toBeNull();
    expect(profileFor({ ...MATCHED, version: 2 }, { ...doc, slug: "the-cave" })).toBeNull();
    // A document the session does not hold carries no version.
    expect(profileFor(MATCHED, doc)).not.toBeNull();
    expect(profileFor(null, doc)).toBeNull();
  });
});

describe("no profile", () => {
  test("a document with none renders exactly as without the prop", async () => {
    const none: DocumentProfile = {
      ...MATCHED,
      match: "none",
      label: undefined,
      warnings: [],
      reason: "no _meta/profiles/location.json",
    };
    const plain = await mount(<FrontmatterHeader frontmatter={fm()} />);
    const html = plain.container.innerHTML;
    await plain.unmount();
    for (const profile of [null, none]) {
      const m = await mount(
        <FrontmatterHeader frontmatter={fm()} profile={profile} onAskProfileFix={() => {}} />,
      );
      expect(m.container.innerHTML).toBe(html);
      await m.unmount();
    }
  });
});
