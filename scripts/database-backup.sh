#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required; no database was exported." >&2
  exit 1
fi
command -v pg_dump >/dev/null || { echo "pg_dump is not installed." >&2; exit 1; }
command -v pg_restore >/dev/null || { echo "pg_restore is not installed." >&2; exit 1; }

output_dir="${1:-generated-artifacts/database}"
mkdir -p "$output_dir"
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$output_dir/gods-postgres-$stamp.dump"
error_file="$(mktemp)"
trap 'rm -f "$error_file"' EXIT

if ! pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --dbname="$DATABASE_URL" \
  --file="$archive" \
  2>"$error_file"; then
  rm -f "$archive"
  echo "PostgreSQL export failed. Database connection details were not printed." >&2
  exit 1
fi

if ! pg_restore --list "$archive" >/dev/null 2>"$error_file"; then
  rm -f "$archive"
  echo "The PostgreSQL archive failed its integrity check." >&2
  exit 1
fi

(cd "$output_dir" && sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
printf 'Verified PostgreSQL backup: %s\n' "$archive"
printf 'Archive size: %s bytes\n' "$(stat -c %s "$archive")"
