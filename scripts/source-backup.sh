#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
output_dir="${1:-generated-artifacts/source}"
mkdir -p "$output_dir"
umask 077

bundle="$output_dir/gods-bot-history.bundle"
source_archive="$output_dir/gods-bot-source.tar.gz"

git bundle create "$bundle" --all
tar \
  --exclude=.git \
  --exclude=node_modules \
  --exclude='*/node_modules' \
  --exclude=generated-artifacts \
  --exclude=.cache \
  --exclude=.turbo \
  --exclude=coverage \
  --exclude=dist \
  --exclude=build \
  --exclude=.env \
  --exclude='.env.*' \
  --exclude='*/.env' \
  --exclude='*/.env.*' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude=secrets \
  --exclude='*/secrets' \
  --exclude='*.dump' \
  --exclude='*.sql.gz' \
  -czf "$source_archive" \
  -C "$root" .

sha256sum "$bundle" "$source_archive" > "$output_dir/SHA256SUMS"
printf 'Git history bundle: %s\n' "$bundle"
printf 'Current project files: %s\n' "$source_archive"
printf 'Checksums: %s/SHA256SUMS\n' "$output_dir"
