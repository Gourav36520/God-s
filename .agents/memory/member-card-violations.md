---
name: Member-card violation counts
description: Safe counting sources for the Discord bot's member-role card.
---

Member-card violation totals must not use raw heat points or the general HeatStore event count. That event count can include manual heat adjustments. Count only explicit HeatEngine violation records and recorded punitive moderation cases; do not infer a violation count from older mixed heat records.

**Why:** A total derived from heat points would misstate violations, and the older aggregate does not distinguish automatic violations from manual adjustments.

**How to apply:** Keep heat scoring and violation records separate when changing card totals. Show `Unavailable` if the confirmed sources cannot be read, and `None recorded` only when they return zero.
