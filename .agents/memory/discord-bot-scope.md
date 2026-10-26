---
name: Discord bot scope
description: Product identity and constraints for this repository
---

This repository is God's Bot, a Discord bot. Do not treat it as a mobile app or create a website, frontend, React Native app, Expo app, or mobile UI. Preserve the existing repository structure, commands, events, persistence, configuration, package files, TypeScript setup, and bot entry point. Do not upgrade dependencies or push/commit unless explicitly requested.

**Why:** The user explicitly clarified the product and scope when correcting an artifact selection that suggested a mobile app.

**How to apply:** Before adding features or changing project structure, confirm the work is for the Discord bot and does not replace or refactor existing bot behavior.

For verification, use Discord interactions only: the panel button, private challenge image, and answer modal. Do not require a verification website, browser redirect, OAuth login, or Turnstile.

**Why:** the user explicitly chose a Discord-native verification flow and rejected external website verification.

**How to apply:** Send CAPTCHA images in an ephemeral Discord response before opening a modal; do not try to render images inside Discord modals.
