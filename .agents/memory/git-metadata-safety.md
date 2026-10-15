---
name: Git metadata safety gate
description: Replit's confirmation guard for Git remote and branch mutations
---

Replit may reject Git commands that modify `.git` configuration or refs unless the mutating invocation is prefixed with `DANGEROUSLY_ALLOW_GIT=1`. This is a workspace safety guard, not a Git transport error.

**Why:** Importing the requested upstream repository was blocked by this guard until the explicitly authorized mutation was retried with the prefix; the starter branch was retained rather than resetting history.

**How to apply:** Before a user-authorized remote or branch change, verify the working tree and current refs. Use the prefix only for the specific approved mutations; never use it to justify unrequested history changes.
