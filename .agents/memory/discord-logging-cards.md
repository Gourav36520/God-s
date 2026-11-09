---
name: Discord logging card rendering
description: Constraints and rendering tradeoffs for matching supplied Discord logging-card references.
---

Use paired native embeds with inline fields for summary and detail content. Discord's native embed layout cannot reproduce custom diagonal backgrounds, rounded card borders, or precise large side-by-side avatar placement.

**Why:** The reference-card adjustment used the existing Discord.js embed path and avoided adding an image-rendering dependency or service.

**How to apply:** When comparing logging embeds with supplied screenshots, distinguish achievable field/avatar alignment from custom artwork; a closer pixel-level match requires a separately scoped image renderer.
