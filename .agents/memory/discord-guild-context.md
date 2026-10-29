---
name: Discord guild interaction context
description: Resolve guild command context even when discord.js has not cached the guild
---

For guild slash interactions, `guildId` identifies the server even when `interaction.guild` is `null`; `interaction.guild` is cache-backed, so a missing guild object does not imply a DM. Use `guildId` to fetch the guild, and fetch the bot's guild member when a command relies on `guild.members.me`. Only a missing `guildId` is a genuine DM context.

Fetching a guild does not populate the interaction's `guild` property. Pass the resolved `Guild` and original `guildId` through downstream command helpers instead of rereading `interaction.guild`.

**Why:** God's Bot's Anti-Nuke handler rejected valid commands in guilds absent from the local cache by treating a null `interaction.guild` as a DM.

**How to apply:** Shared guild-only command paths should resolve the cached guild first, fall back to `client.guilds.fetch(guildId)`, and keep DM denial based on `guildId`.
