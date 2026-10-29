---
name: Post-merge database setup
description: Keep workspace installs and the bot's development schema migration working together
---

The post-merge setup must complete both the full frozen workspace install and the development database schema push. A dependency blocked during the install prevents the schema push from running, and the bot then cannot initialize Anti-Nuke guild configuration. Resolve firewall failures by updating the affected direct dependency and lockfile to a compatible current release; do not bypass the firewall or skip the schema step.

**Why:** A blocked tarball stopped post-merge setup before the schema push, and the bot failed during Anti-Nuke initialization until the migration completed.

**How to apply:** After dependency changes, rerun the configured post-merge setup and confirm both install and schema push succeed before considering workflow recovery complete.
