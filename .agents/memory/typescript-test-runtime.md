---
name: TypeScript test execution
description: Running self-contained TypeScript tests when the package test runner is unavailable
---

Node 24's `--experimental-strip-types` removes TypeScript syntax but does not remap `.js` import specifiers to `.ts` files or resolve extensionless TypeScript imports.

**Why:** A blocked dependency install left the project's TypeScript test runner unavailable, while the source tests depended only on built-in Node modules.

**How to apply:** For self-contained tests, use the already installed TypeScript compiler API to transpile the selected files into `/tmp`, then run the emitted JavaScript with `node --test`. Do not alter source imports or install packages just to run these tests.
