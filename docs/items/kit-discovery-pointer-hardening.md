---
type: item
title: Harden the kit's session-pointer API before a spell adopts it
description:
  The ported discovery pointer API trusts a dead-pid latest pointer, treats pid
  0 or -1 as alive, does not match a file name to its session_id, and writes a
  predictable temp name in a shared tmpdir on Linux.
status: draft
lifecycle: triage
id: 01a138c6-ae85-761c-a3f1-6a7bd4aa7385
kind: chore
generated: { by: claude-opus-5-5, at: 2026-10-13 }
tags: [kit, wire]
parent: feature/workspace-kit
from: features/workspace-kit/sessions/2026-10-13-kit-foundation.md
---

# Harden the kit's session-pointer API before a spell adopts it

The kit-foundation cycle ported Story Studio's session-pointer API into
`src/kit/wire/discovery.ts`. No spell uses it yet. The finalize review
(2026-10-13) reproduced four weaknesses:

- `readPointer` trusts `<spell>.latest.json` even when its pid is dead. Only the
  fallback scan checks liveness.
- `isPointer` accepts `pid <= 0`, and `process.kill(0 or -1, 0)` reads as alive,
  so such a pointer wins the fallback.
- The fallback doesn't check that a file's name matches its `session_id`.
- On Linux, where `tmpdir()` is a shared `/tmp`, other users can plant pointers.
  The temp name `${target}.${pid}.tmp` is predictable, so a symlink can be
  planted ahead of the write.

## Definition of done

- [ ] A dead-pid `latest`, a pid of 0 or below, and a name/`session_id` mismatch
      are each skipped, with a test
- [ ] Pointers live in a per-user directory, or the temp file is opened
      exclusively, so another user can't plant or redirect one

## Related Documents

- [Kit foundation — 2026-10-13](../features/workspace-kit/sessions/2026-10-13-kit-foundation.md)
