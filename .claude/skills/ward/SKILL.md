---
name: ward
description: >
  Consistency checklist for the Spellbook — the wards that catch drift and
  missed updates when the book changes. Use when adding a spell, revising a
  spell, changing a house-style convention, reserving or renaming a spell, or
  bumping the spellbook plugin version. Triggers when a user says "add a spell",
  "new spell", "revise a spell", "bump the spellbook version", "change a
  convention", "rename a spell", "reserve a name", "run the wards", "check
  consistency", or when editing marketplace.json, plugin.json, the grimoire, or
  any of the spell listings. Run it before merging a spellbook change.
---

# Ward

## Purpose

Set the wards before you merge. Several files in the Spellbook list or describe
the same things — the spells, the conventions, the version — and they drift
apart the moment one is changed without the others. This skill is the protective
boundary: the checklists that catch a missed update before it ships.

It pairs with `inscribe`: `inscribe` builds a spell; `ward` protects the book's
integrity afterward.

## The synced listings (the things that drift)

The set of spells is written down in several places. Change the roster — add,
rename, or remove a spell — and **all of these must agree**:

- `.claude-plugin/marketplace.json` → the `tags` array
- `plugins/spellbook/skills/README.md` → the spell table
- `README.md` (repo root) → the spell table
- `grimoire/trigger-registry.md` → the reserved-spells table

Not a sync target for a routine roster change:

- `docs/PROJECT_MANIFESTO.md` — mirrored from Operator (canonical there). Only
  re-sync it when the _manifesto itself_ changes, not when the roster does.

**Quick drift check** — the spell folders are the source of truth:

```bash
ls plugins/spellbook/skills/ | grep -v README   # the real roster
```

Then confirm that exact set appears in each listing above.

## Checklists by change type

### Inscribing a new spell

(Run `inscribe` for the authoring ritual itself; these are the wards around it.)

- [ ] Name reserved in `grimoire/trigger-registry.md` at coalescence (the
      naming/solidification step — not before prototyping; check collisions +
      reserved namespaces)
- [ ] Spell folder under `plugins/spellbook/skills/<name>/` is self-contained
      (`SKILL.md` + `scripts/` + `assets/`; conjurations ship a daemon, cantrips
      don't)
- [ ] Feedback touchpoint present in the spell's `SKILL.md` (agent friction +
      human-surface feedback), routed to GitHub issues against this repo
- [ ] Added to the spell table in `plugins/spellbook/skills/README.md`
- [ ] Added to the spell table in root `README.md`
- [ ] Added to `tags` in `.claude-plugin/marketplace.json`
- [ ] `bun test` present and passing for the spell
- [ ] Fresh-agent test run + findings logged (`grimoire/fresh-agent/`)
- [ ] Plugin version bumped (see Bumping the version)
- [ ] Smoke test passed (see Smoke test)

### Revising an existing spell

- [ ] Change made in `plugins/spellbook/skills/<name>/`
- [ ] `bun test` still green; new behavior has a test
- [ ] Fresh-agent test re-run if ergonomics/SKILL.md changed; findings logged
- [ ] Any judgment the mage supplied captured in `grimoire/scenarios/`
- [ ] Checked `grimoire/decay-ledger.md` for rules this revision re-walked (bump
      their date) **or** rules now gone stale (flag for removal)
- [ ] Spell's internal narrative version updated if it carries one (e.g.
      grapevine "V1.x" banner) — separate from plugin semver
- [ ] Plugin version bumped
- [ ] Smoke test passed

### Changing a house-style convention

A convention never changes alone — the change _is_ a captured judgment.

- [ ] Edit the rule in `grimoire/house-style.md` (keep the shape: imperative +
      boundary check + repeal criterion)
- [ ] Capture the scenario in `grimoire/scenarios/` — it's the rule's repeal
      criterion (Chesterton's fence with the builder's note)
- [ ] Add or update the rule's row in `grimoire/decay-ledger.md` (status +
      last-reinforced date + what reinforced it)
- [ ] If the rule changes how spells are authored, check whether `inscribe` or
      `scaffold/README.md` reference it (they point at house-style; confirm the
      pointer still resolves — do NOT inline the rule into them)

### Reserving or renaming a spell name

- [ ] Update `grimoire/trigger-registry.md`
- [ ] Propagate the new name through **all** synced listings (see above)
- [ ] Grep for the old name to catch stray references:
      `grep -rn "<old-name>" --include='*.md' --include='*.json' --include='*.ts' .`
      (quote the globs — unquoted `*.md` errors under zsh)
- [ ] Rename the skill folder + any hardcoded path in the spell's `SKILL.md`

### Bumping the spellbook plugin version

The spells are versioned together as one plugin, and **release-please owns the
bump** — you don't hand-edit the version. Your job is the right conventional
commit; semver follows from it:

- **Patch (x.x.N)** — `fix(...)`: non-behavioral fixes (typos, formatting,
  broken links).
- **Minor (x.N.0)** — `feat(...)`: any behavioral change (new/revised spell, new
  verb or flag, changed guidance, new convention). **Default for spell
  content.**
- **Major (N.0.0)** — `feat!:` / `BREAKING CHANGE:`: renamed/removed spell,
  restructured layout.

- [ ] **Don't hand-edit `version` anywhere.** release-please reads the
      conventional commits on `main`, bumps the root `package.json`, and syncs
      that into `plugins/spellbook/.claude-plugin/plugin.json` via the
      `extra-files` JSON updater. Land the right commit type; that's it.
- [ ] Leave `.claude-plugin/marketplace.json` alone: its `metadata.version` is
      the _catalog's_ own version (separate from the plugin, not touched by
      release-please), and the per-plugin entries are discovery-only (name,
      source, category, tags) — never put the plugin's version there.

## Smoke test (runnable spells)

`bun test` runs against an isolated tmpdir HOME and won't catch real-path or
live-state issues. Any spell that ships runnable code — every conjuration (it
has a daemon/server), and any cantrip whose surface runs a local server — should
be smoke-tested from the dev tree before merging.

1. Run a read-only verb from the dev-tree path first:
   ```bash
   bun plugins/spellbook/skills/<spell>/scripts/cli.ts <readonly-verb>   # info|list|doctor
   ```
2. Exercise the new behavior with a non-destructive verb.
3. **Check for live users before anything disruptive.** A conjuration's daemon
   may have connected agents or open sessions — use the spell's own
   health/status verb to check before any restart, and prefer verbs that reuse a
   running daemon over ones that replace it. (E.g. grapevine's `doctor` reports
   `active_subscribers`; a restart forces clients to auto-reconnect — works, but
   coordinate first.)
4. Confirm no zombie processes left behind (`ps` / `lsof -p <pid>`).

> ⚠ During the extraction, dev-tree paths still resolve into `project-docs` for
> the not-yet-migrated copies. Once a spell lives in Spellbook, smoke-test it
> from the **Spellbook** dev tree, and confirm its `SKILL.md` points at the
> `spellbook-marketplace` cache path, not the old toolbox path.

## Final checks

- [ ] `npx prettier --write` on changed `.md` / `.json` / `.ts` (pre-commit hook
      will block otherwise)
- [ ] The drift check passes: the spell-folder roster matches every synced
      listing
- [ ] Grepped for any old state you changed (name, version string, path)
- [ ] **Meta — does this skill need updating?** If you added a new synced
      listing, a new grimoire file, a new change-type, or moved paths (e.g. the
      extraction finishing), update this skill at
      `.claude/skills/ward/SKILL.md`.
