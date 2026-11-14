---
name: Member-card image storage
description: Storage and delivery boundary for generated member cards in the Discord bot.
---

Generate card PNGs and persist them in PostgreSQL, keyed by guild, member, and card type. Batch generation, join handling, and member-data events must only render and persist cards; only `/card user` and its button interactions may attach stored images in Discord.

**Why:** The user requires cards to remain internal during generation and automatic updates, so routine bot activity does not post card content into server channels.

**How to apply:** Keep channel sends out of all card generation and refresh paths. Retain legacy channel-reference tables as-is for additive migration safety, but never use them as active card storage.
