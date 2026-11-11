---
name: GOD'S NEXUS safety boundary
description: Durable scope and safety requirements for the Anti-Nuke intelligence layer.
---

GOD'S NEXUS is an intelligence layer only for Anti-Nuke, not a general chatbot. Keep RADAR detection and verification, NEXUS advisory analysis, GOD'S JUDGMENT enforcement, and COMMAND CENTRE owner-facing reports/configuration logically separate.

NEXUS may return risk assessments, explanations, false-positive indicators, and recommendations to observe or request owner review. It must never perform Discord actions, authorize punishment, override blacklist/whitelist or server-owner protections, or alter Heat Engine calculations. Existing verified deterministic rules remain the only enforcement authority. Provider failures must leave Anti-Nuke behavior unchanged.

**Why:** The user explicitly requires deterministic Anti-Nuke and the existing God's Judgment system to remain authoritative while any AI analysis stays advisory.

**How to apply:** Keep provider inputs minimal and free of Discord IDs or message content; bound timeouts and outputs; obtain approval for a provider and explain its cost and fallback before integrating it. Do not persist AI data or connect it to punishment without an explicit, separately scoped change.
