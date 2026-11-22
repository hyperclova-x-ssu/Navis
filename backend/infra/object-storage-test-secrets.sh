#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p .secrets/local

for name in object_storage_access_key object_storage_secret_key; do
  path=".secrets/local/$name"
  if [ -s "$path" ]; then
    continue
  fi
  temporary=$(mktemp "$path.XXXXXX")
  trap 'rm -f "$temporary"' EXIT
  openssl rand -hex 24 > "$temporary"
  chmod 444 "$temporary"
  ln "$temporary" "$path" 2>/dev/null || test -s "$path"
  rm "$temporary"
  trap - EXIT
done
