#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
if [[ -z "$archive" || ! -f "$archive" ]]; then
  echo "Usage: RESTORE_TARGET_DATABASE_URL=... RESTORE_TARGET_IS_NEW_DATABASE=YES $0 <backup.dump>" >&2
  exit 1
fi
if [[ "${RESTORE_TARGET_IS_NEW_DATABASE:-}" != "YES" ]]; then
  echo "Restore refused. Set RESTORE_TARGET_IS_NEW_DATABASE=YES only after verifying the target is a new, empty database." >&2
  exit 1
fi
if [[ -z "${RESTORE_TARGET_DATABASE_URL:-}" ]]; then
  echo "RESTORE_TARGET_DATABASE_URL is required; no restore was attempted." >&2
  exit 1
fi
command -v pg_restore >/dev/null || { echo "pg_restore is not installed." >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is not installed." >&2; exit 1; }

archive_dir="$(cd "$(dirname "$archive")" && pwd)"
archive_name="$(basename "$archive")"
checksum_file="$archive_dir/$archive_name.sha256"
if [[ ! -f "$checksum_file" ]]; then
  echo "The SHA-256 sidecar is missing; restore refused." >&2
  exit 1
fi
if ! (cd "$archive_dir" && sha256sum --check "$archive_name.sha256") >/dev/null 2>&1; then
  echo "The backup checksum does not match; restore refused." >&2
  exit 1
fi
if ! pg_restore --list "$archive" >/dev/null 2>&1; then
  echo "The backup archive is invalid; restore refused." >&2
  exit 1
fi

error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT
if ! pg_restore \
  --no-owner \
  --no-acl \
  --exit-on-error \
  --single-transaction \
  --dbname="$RESTORE_TARGET_DATABASE_URL" \
  "$archive" \
  2>"$error_file"; then
  echo "Restore failed. No clean/drop option was used; the transaction was rolled back." >&2
  exit 1
fi

echo "Database restore completed into the confirmed new database."
