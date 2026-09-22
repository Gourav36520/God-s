---
name: Discord command structure
description: Constraint for the bot's slash-command builders
---

Discord rejects an application command payload that mixes top-level subcommands with top-level subcommand groups. When a root command needs groups such as `antispam` or `antilink`, keep every child under a subcommand group.

**Why:** A mixed builder can serialize locally but fail during Discord registration, leaving newly added groups absent from the client.

**How to apply:** Before registering a changed slash command, inspect its serialized `toJSON()` options and ensure the root contains only subcommand groups or only subcommands.