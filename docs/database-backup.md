# God's Bot database backup and recovery

God's Bot uses PostgreSQL through Drizzle. The schema source is
`lib/db/src/schema/`; this repository does not currently contain a separate
migrations directory. `DATABASE_URL` must be configured as a Replit secret or
managed database value. Never paste it into chat, commit it, or print it.

## Export and verify

Run from the project root:

```sh
bash scripts/database-backup.sh
```

The script creates a PostgreSQL custom-format archive under
`generated-artifacts/database/`, verifies that `pg_restore` can read it, and
writes a SHA-256 sidecar. These local exports are excluded from Git and deploy
images. Keep an additional copy in protected storage for disaster recovery.

The archive contains the database schema and persistent records, including
guild backup settings, server backups, binary attachments, message archives,
kick-recovery records, and observed member-removal evidence when those tables
contain data.

God's Bot limits stored attachments to 8 MiB per file, 64 MiB per server
snapshot, and 512 MiB total per guild across snapshot and message-archive files.
An attachment over a limit remains listed as unavailable metadata rather than
being silently presented as recoverable.

## Restore into a new database

1. Provision a new, empty PostgreSQL database.
2. Set `RESTORE_TARGET_DATABASE_URL` through the secure environment/secrets
   settings; do not place the URL in shell history or chat.
3. Confirm that the target is new and empty, then run:

```sh
RESTORE_TARGET_IS_NEW_DATABASE=YES \
  bash scripts/database-restore.sh generated-artifacts/database/<backup>.dump
```

The sidecar checksum and archive format are verified before restore. The
restore uses one transaction, stops on errors, and never uses `--clean`,
`--if-exists`, `DROP`, or `TRUNCATE`. Existing objects cause an error instead of
being deleted. Do not point it at production or another database with records.

For a new database with no records to recover, use the schema source instead:

```sh
pnpm --filter @workspace/db run push
```

That command is for an intentionally empty development database. Do not use
`push-force` for recovery. Replit-managed production schema changes must follow
the Publish flow; do not run these scripts against production.

## Recovery limits

The Git repository and `git bundle` preserve source/history, not live records.
The PostgreSQL archive is separate. Discord will assign new IDs and timestamps
when messages are reposted, and data not present in a database or backup cannot
be recovered.
