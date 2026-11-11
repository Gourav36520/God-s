---
name: Anti-Nuke authorization and lockdown
description: User-approved boundaries for security configuration and incident responses.
---

Only the server owner may use sensitive Anti-Nuke configuration, whitelist, blacklist, and unapproved-bot policy commands. Administrator permissions and roles do not grant a bypass.

Anti-Nuke incidents must never invoke automatic lockdown. Preserve existing lockdown configuration, restoration, and any explicit manual service path, but do not route incident responses into lockdown.

**Why:** The user explicitly requires strict owner-only security controls and prohibits incident-triggered automatic lockdown.

**How to apply:** Check actor ID equality with the resolved guild owner before any sensitive operation. Keep owner protections, whitelist/blacklist precedence, God's Judgment, and existing incident records unchanged.
