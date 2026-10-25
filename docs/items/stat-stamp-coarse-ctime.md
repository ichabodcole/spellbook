---
type: item
title: A same-size edit inside one clock tick is missed on a coarse-ctime kernel
description:
  The kit's stat-stamp caches (relations, profiles, the session's readers) trust
  ino, size, mtime and ctime; on a Linux kernel before 6.13, or any filesystem
  with coarse timestamps, an edit in the same tick as the last read keeps all
  four and is not read.
status: draft
lifecycle: triage
id: 01a17217-8f1e-742b-a1fe-7cc57e118ff3
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-25 }
tags: [kit, testing]
from: 01a17017-0595-77fb-8306-cf552a20d9f6
---

# A same-size edit inside one clock tick is missed on a coarse-ctime kernel

Found 2026-10-25 while reproducing [ci-red-on-linux](./ci-red-on-linux.md) in a
Linux container (Docker Desktop, kernel 6.12.67-linuxkit, overlayfs). The kit
caches a parsed file under a stamp of `ino:size:mtimeMs:ctimeMs`
(`src/kit/workspace/relations.ts`, `profiles.ts`, and two readers in
`session.ts`). The ctime is there so an edit that keeps the size and puts the
mtime back is still read. That holds only while the kernel's ctime is finer than
the gap between two writes. On that kernel it moves in 1 ms steps (five appends
in a row stamped `.682619`, `.684619`, `.684619`, `.684619`, `.685619`), so an
edit in the same millisecond as the last read keeps the whole stamp.

Two cells failed there in every full run (six runs), and two more of the same
kind in some runs:

- `RelationsReader > ⛔ an edit that keeps the size and puts the mtime back is still read`
  (`relations.test.ts`), every run
- `ProfileReader > ⛔ an edit that keeps the size and puts the mtime back is still read`,
  every run
- `what the source editor's verifier found, on the kit's link check > ⛔ an edit that keeps the size and puts the mtime back is still seen`
  (`links.check.session.test.ts`), one run of mine
- `what the source editor's verifier found, on the kit's link check > ⛔ the headings cache sees an edit that keeps the size and puts the mtime back`
  (same file), in the no-stake verifier's container run

CI is not affected, for two reasons:

- **The runner's kernel is 6.17.** GitHub's ubuntu-24.04 runner for those runs
  (image `20261012.334`, read from the run log's "Runner Image" group) lists
  `Kernel Version: 6.17.0-1022-azure` in its readme:
  `gh api 'repos/actions/runner-images/contents/images/ubuntu/Ubuntu2404-Readme.md?ref=ubuntu24/20261012.334' --jq .content | base64 -d | grep Kernel`.
- **Linux 6.13 gave ext4 fine-grained ctime.** Multigrain timestamps (a
  fine-grained ctime once a file's attributes are read) were merged for 6.13,
  with ext4, xfs, btrfs and tmpfs converted: Christian Brauner's pull request
  [`vfs-6.13.mgtime`](https://lkml.rescloud.iu.edu/2411.1/09679.html) lists
  "ext4: switch to multigrain timestamps". See also
  [Phoronix on the 6.13 merge](https://phoronix.com/news/Linux-6.13-Multigrain-Timestamp).
  A first attempt in 6.6 was reverted.

Every one of these cells passed in both red CI runs. A Mac (APFS, nanosecond
times) is not affected either. A user of the kit on a Linux kernel before 6.13
would be: the case is any same-size edit (not only one that puts the mtime
back), since mtime is just as coarse.

The usual remedy is git's "racily clean" rule: do not trust a stamp whose ctime
is as new as the read itself; read the file again next time.

## Definition of done

- [ ] The decision recorded: accept it (and say where), or fix the stamp caches
- [ ] If fixed: the cells above pass in the Linux container recipe
      (`ci-red-on-linux`'s Done and verified) on kernel 6.12

## Related Documents

- [CI is red on develop: happy-dom component tests fail on Linux](./ci-red-on-linux.md)
