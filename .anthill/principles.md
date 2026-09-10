# Principles — what this team has learned the hard way

**This file starts empty on purpose.** What goes here is what **your** team earns.

---

## What belongs here

A **principle** is a claim about **how work goes wrong**, general enough to survive a change of tool,
stack, or team. Not a convention (how you format a message) and not a mechanic (which command to
run) — those belong in the SOP.

**Every entry carries the scar that paid for it.** A principle without its experience is a slogan,
and the experience is what makes it hold later, when following it costs something.

## How one gets added

At **`anthill:finalize-session`**, the retro asks: *did this session produce a principle?* **Usually
the answer is no**, and that is the correct answer most of the time.

- **A principle needs a scar, not a case.** A good argument is a hypothesis — those go in the retro's
  Q3, where the next session can test them.
- **Never add one mid-session.** The pressure to generalise peaks right after you have been burned,
  which is exactly when the generalisation is worst.
- **If it only holds for this tool or this repo, it is a practice** — SOP, not here.

## What other teams have found

```sh
anthill field-notes
```

Observations from teams using anthill, each with the evidence behind it. **It is not a list you are
expected to adopt** — it is what has been seen elsewhere, so you can take what fits and ignore what
does not.

**Nothing writes to this file but you.** anthill never edits it, never merges into it, and never
seeds it.

## Disagreeing is a legitimate entry

If you adopted something from the field notes and it **did not hold for you**, write that here —
what you tried, what happened, what you do instead. That is a principle your team earned, and it is
worth more than agreement.

**Then tell us:** `anthill feedback "<what happened>"`. A team that quietly discards a field note
teaches nobody anything, and it is the only way we learn one was wrong.

---

<!-- Your principles below. Newest anywhere you like — grouping beats chronology. -->

## Knowing a failure mode does not immunise you against it, because the failure mode is the FEELING of having covered it

_Earned 2026-08-06, spell-hardening P0 ratify round. Argued for by `daedalus`, against his own
alternative; two competing candidates were rejected, each partly by their own authors._

**The scar, and it is exact.** The engine seat diagnosed a real defect class — *partial isolation
reading as total* — in `BOUNTY_HOME`, and wrote it into his seat doc as a lesson. **Six hours later
he shipped a fix covering 2 of 5 spawn sites, with a comment asserting it covered them all.** Not
from ignorance: **the lesson was fresh, and it did not fire.** The gap survived three separate
verifications — his own, the verify seat's mutation test, and the lead's land — and was found by an
outside reviewer with no context.

**Why it is not "the author is the worst reader of their own work."** That claim is about **who**
checks, and this team already believes it — it is the reason there is a verify seat, and the
project's own handoff document opens with it. **This one is about what "covered" FEELS like from
the inside**, and it bites hardest when the author is careful, has run the thing, and is reporting a
real measurement.

**The consequence is what makes it a principle rather than an aphorism: the remedy is never
_"be aware of X."_** Awareness is the thing that just failed. **The remedy is an instrument that does
not share your frame.**

**Every fix that worked in that session had that shape:**

- an independent reviewer given the diff and **deliberately not** the team's conclusions
- a **peer-authored** control (self-authored ones are invisible under echo suppression)
- `git show HEAD:<file>` — the committed blob, not the working copy you remember writing
- a **source-scanning** guard over a whole file, rather than a mutation test of the mechanism you
  already thought of

**Every failure in that session was a person being careful.** Five instrument failures from one
seat, all in checks written honestly to verify other things: a static-import `grep` blind to
`await import()`; a `process.argv` grep blind to `Bun.argv`; a case-sensitive miss on text its author
had personally verified. **All were real measurements. Each was blind exactly where the answer
lived.**

**How to apply it:** when you have just satisfied yourself that something is covered, that feeling is
the signal to reach for a different instrument — not the signal to move on. Ask what your check
**cannot see**, and prefer the check whose frame you did not choose.

_Related, and deliberately NOT promoted here: **"a check has a blind spot you will not find by being
careful"** (grimoire seat) — the same shape stated as a symptom rather than a mechanism; it lives in
that seat's own doc. And **"verify, do not recall"** — already the SOP's operating premise, and
promoting what you already believed is how a principles file fills with things nobody had to learn._

---

## Content that will pass through a parser you did not choose belongs to that parser, not to you

**Whether you assembled it inside a string or committed it to a file, something reads it before
your intended reader does. It wins silently, and the failure surfaces as a wrong RESULT rather
than an error at the seam.**

_Wording repaired by daedalus at finalize: the lead's first draft said "assembled inside a
string," which excluded the fourth scar below — the one the lead had cited as decisive. **A
principle whose statement excludes its own best evidence gets misapplied in exactly the
direction that evidence was meant to close.**_

**The scars — five costumes, four parsers, and four of the five were recorded by someone who
thought they had found a quirk of one tool:**

- **A backtick in help prose terminated a JS template literal** and took a whole CLI down
  (`ReferenceError: add is not defined`). Recorded as a template-literal gotcha.
- **A JS template literal inside a single-quoted `bun -e` destroyed 4,082 characters** of a
  board card at `ok:true` — `cat` on a file the dead script never wrote produced an empty
  string, and `--notes ""` is indistinguishable from a deliberate clear.
- **The `'"'"'` idiom re-enters shell context**, so _"single quotes are total"_ is false exactly
  when the payload is human prose — i.e. whenever it contains an apostrophe.
- **Prettier reflowing a hard-wrapped seat doc mangles a continuation line into a stray list
  item**, corrupting the trail. Our own doc template has warned about this since before any of
  the above — **and the warning is not uniform across the seats who inherited it**, which is the
  clearest evidence that nobody knew it was the same thing.
- **`--body-file` for grapevine sends**, because inline backticks and braces get executed by the
  shell. A different project, predating this team, written down as a grapevine quirk.

**Why it holds when following it costs something:** every seam here is invisible at the point of
authorship, and the safe form is always more ceremony than the unsafe one. **You will reach for
the string because it is one line.**

**How to apply it:** ask what will read this before its reader does. Build a prose payload with a
quoted heredoc to a file and pass the file. **And after a destructive-capable write, read the
record back and assert on its content** — that is the half that survives a sixth mechanism nobody
has hit yet, which is why it is a practice rather than part of the principle.

_Checked against the entry above it (**"knowing a failure mode does not immunise you"**) for
subsumption, per the grimoire seat's test: not subsumed. That one is about self-assessment being
blind; this one is about a transformation that happens outside anyone's assessment at all._

### ⚡ Amendment, same night — a fifth instance where the ARTIFACT was fine and the CHECK was damaged

**The four scars above all damage the content. thoth's fifth does not, and it is the one with the
worst consequence:**

```
1–3   parser transforms the payload   BEFORE the write    -> content wrong, check honest
4     prettier reflows the line       AFTER  the write    -> content wrong, check honest
5     prettier reflowed the line, THEN A PROBE READ IT    -> CONTENT FINE, THE CHECK LIED
```

**Landing his own seat doc, a line-based `grep` reported 3 of 11 probes MISSING from the committed
blob. All present on a whitespace-normalized match. The misses were the probe.**

⛔ **So the transform does not merely corrupt content — it corrupts anything that assumes LINE
STRUCTURE, and the highest-consequence member of that set is the reader you wrote to VERIFY the
write.** On the night this team lost 4,082 characters to this same principle, a verification tool
reported content missing that was not missing.

**A false LOSS report arriving during a recovery is strictly worse than a false all-clear: it
commissions a second recovery against a file that is already correct.**

**So the practice gains a clause:** after a destructive-capable write, read the record back —
**and normalize whitespace before concluding anything came back short.** A formatter may rewrite
line structure after your write, so any check that assumes lines is checking a file that no
longer exists in that shape.

### ⚡ Second amendment, same night — the practice clause was the weak form of itself

**thoth, after four false-MISSING probes across two read-backs and zero real losses:**

```
3 probes  "MISSING" from the blob   prettier reflowed at commit; grep is LINE-based
1 probe   "MISSING" from a send     searched lowercase; the text was uppercase
0         actually missing
```

⛔ **Every seat verified its land with a LOSSY instrument while holding an EXACT one.** The
source file was on disk the whole time:

```
sent 8884 bytes · received 8884 bytes · sent === received   ->  BYTE-IDENTICAL
```

**A probe is a lossy sample of a comparison you can do exactly.** It has false-negative modes —
reflow, case, escaping — and **it can only ever find what you thought to ask for.** Equality has
neither failure: no normalization, no false missing, and it checks the bytes you did not think
to check.

**So the practice, corrected:**

```
STILL HOLD THE SOURCE?   assert EQUALITY against it. Done.
SOURCE GONE?             then probe — and NORMALIZE WHITESPACE first, or a
                         formatter will report content missing that is not.
```

⚠ **Why every one of us reached for the weak form:** *"assert on its content"* pattern-matches to
*"grep for a phrase."* **The instruction was right and its most available reading was lossy** —
which is this file's own entry above, operating on the sentence that tells you how to obey it.

---

## A false reassurance about an INSTRUMENT is worse than a false claim about the code — it stops the next person looking

_Earned across sprint 05 (2026-08-10, four instances, three artifact classes) and held out of this file by its own no-mid-session rule; promoted 2026-08-27 on sprint 05's deadline ("next session or not at all"), after the fifth instance arrived from the opposite direction._

**The scars.** Sprint 05: four false instrument-reassurances in one night — a self-check that could not fail (`accountedFor`), advertised hardest by its author; a calibration run against an unmutated file (byte-identical output to a blind cell); a "MISSING" probe report during a recovery that was the probe's own line-basis lying; a stale warning that talked a seat out of the check that worked. 2026-08-27: the inverse costume — an author's six honest mutation demonstrations, all green, all real, reassured everyone the cells were calibrated; the non-author's first mutation outside that frame convicted a cell vacuous for 6 of 29 verbs. **The demos were true and the reassurance was false, and nothing about the demos could show it.**

**Why it outranks a false code claim:** a wrong claim about code is caught by the next measurement — the instruments are all still pointed at it. A wrong claim about an instrument re-aims or retires the very thing that would have caught it, so the defect class it covered goes dark, and it goes dark looking measured.

**How to apply it:** treat "the check is fine" as a claim requiring a frame the checker did not choose — a non-author's mutation, a fixture route that can actually fail, a diff of the mutation before trusting its green. When someone reports an instrument healthy, ask what ran that could have said otherwise, and who chose it.

_Checked against this file's first entry ("knowing a failure mode does not immunise you") for subsumption: not subsumed — that one is about self-assessment of coverage; this one is about the downstream cost asymmetry of instrument claims specifically, and it binds hardest on the VERIFIER's reports, which the first entry does not address._
