# God's Bot

God's Bot is a multi-guild Discord bot with moderation, server utilities, and verified PostgreSQL-backed server backups and recovery.

## Run & Operate

- `pnpm --filter @workspace/discord-bot run start` — run the Discord bot
- `pnpm --filter @workspace/discord-bot run deploy-commands` — register slash commands
- `pnpm --filter @workspace/discord-bot run typecheck` — typecheck the bot package
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `bash scripts/database-backup.sh` — export and verify a PostgreSQL backup
- `bash scripts/source-backup.sh` — archive current files and Git refs without secrets or build output
- Required env: `DATABASE_URL`, `DISCORD_BOT_TOKEN`
- Command registration also requires `DISCORD_CLIENT_ID` or `CLIENT_ID`
- Message-content archiving requires `INTENT_MESSAGE_CONTENT=true` and the Discord privileged intent enabled

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- DB: PostgreSQL + Drizzle ORM
- Discord: discord.js 14
- Runtime: TypeScript via `tsx`

## Where things live

- `artifacts/discord-bot/src/commands/` — slash commands and command handlers
- `artifacts/discord-bot/src/backups/` — snapshot, message archive, restore, scheduler, and interaction flows
- `artifacts/discord-bot/src/events/` — Discord event handlers
- `lib/db/src/schema/` — Drizzle schema source of truth
- `lib/db/src/backup-store.ts` — guild-scoped PostgreSQL backup and archive operations
- `docs/database-backup.md` — database export and non-destructive restore procedure
- `scripts/database-backup.sh` and `scripts/database-restore.sh` — checked database backup tooling

## Architecture decisions

- Backups are stored in PostgreSQL, including binary attachments; Discord message IDs/timestamps are preserved as metadata only.
- Continuous message archiving is per-guild and retains the latest 100 observed messages per supported text channel.
- Member removals are recorded as kick, ban, leave, or unknown from audit-log evidence; only confirmed kicks are eligible for invite recovery.
- Every restore requires a fresh administrator confirmation; restore operations do not delete server channels or roles.
- Database archives are separate from Git and are written to ignored `generated-artifacts/`.

## Product

- `/backup create`, `/backup list`, and `/backup load` create, list, preview, and restore server backups.
- `/autobackup settings`, `/autobackup configure`, `/autobackup run`, and `/autobackup status` manage persistent schedule, archive, and kick-tracking controls.
- `/recover` guides administrators through backup, archived-message, and kicked-member recovery.
- Existing Anti-Nuke and moderation code is outside the backup feature scope and must not be changed as part of backup work.

## User preferences

- Never modify Anti-Nuke or existing moderation functionality as part of backup changes.
- Do not force-push or overwrite GitHub branches.
- Never expose secrets or print database connection strings.

## Gotchas

- Enable Discord Server Members intent for member removal/rejoin tracking and View Audit Log for kick correlation.
- Enable Message Content intent for message content archival; unavailable intents can leave archived message content empty.
- Discord role hierarchy, channel permissions, emoji limits, and rate limits may cause individual restore items to be skipped or fail; review the final report.
- Kick recovery never unbans users. If a member remains banned, an administrator must handle that separately.
- This repository has no separate Drizzle migrations directory; schema changes are represented in `lib/db/src/schema/`.

## Pointers

- See `docs/database-backup.md` for database export and restoration instructions.
