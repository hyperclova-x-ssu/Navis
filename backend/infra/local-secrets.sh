#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077

mkdir -p .secrets
chmod 700 .secrets
mkdir -p .secrets/local/db .secrets/test/db
# Compose mounts the inner DB directories for non-root users. The parent
# directory limits access to the Mac account that generated the files.
chmod 755 .secrets/local/db .secrets/test/db

write_secret() (
  path=$1
  shift
  if [ -e "$path" ]; then
    [ -s "$path" ] || { printf 'Empty secret file: %s\n' "$path" >&2; exit 1; }
    return
  fi
  tmp=$(mktemp "${path}.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  "$@" > "$tmp"
  chmod 444 "$tmp"
  ln "$tmp" "$path" 2>/dev/null || [ -s "$path" ]
)

for mode in local test; do
  write_secret ".secrets/$mode/db_bootstrap_password" openssl rand -hex 32
  for service in account pos inventory customer marketing insight; do
    for role in migrate runtime; do
      write_secret ".secrets/$mode/db/${service}_${role}_password" openssl rand -hex 32
    done
  done
  for service in pos inventory customer; do
    write_secret ".secrets/$mode/db/${service}_relay_password" openssl rand -hex 32
  done
done

write_secret .secrets/local/account_signing_key.pem openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256
write_secret .secrets/local/gateway_account_token openssl rand -hex 32
write_secret .secrets/local/gateway_inventory_token openssl rand -hex 32

write_secret .secrets/local/gateway_pos_token openssl rand -hex 32
write_secret .secrets/local/gateway_customer_token openssl rand -hex 32
write_secret .secrets/local/customer_pos_token openssl rand -hex 32

for identity in relay pos inventory customer; do
  write_secret ".secrets/local/${identity}_redis_password" openssl rand -hex 32
done

redis_hash() {
  tr -d '\r\n' < ".secrets/local/${1}_redis_password" | openssl dgst -sha256 -r | cut -d ' ' -f 1
}

acl_tmp=$(mktemp .secrets/local/redis_acl.XXXXXX)
trap 'rm -f "$acl_tmp"' EXIT
{
  printf '%s\n' 'user default on nopass -@all +ping'
  printf 'user relay on #%s -@all +ping +client|setinfo +eval +get +set +exists +del +xgroup|create +xadd +xrange ~navis.pos.0 ~navis.pos.0.epoch ~navis.inventory.0 ~navis.inventory.0.epoch\n' "$(redis_hash relay)"
  for consumer in pos inventory customer; do
    producer=pos
    if [ "$consumer" = pos ]; then producer=inventory; fi
    printf 'user %s on #%s -@all +ping +client|setinfo +eval +get +exists +xreadgroup +xautoclaim +xack +xpending ~navis.%s.0 ~navis.%s.0.epoch (+xadd ~navis.dlq.%s)\n' \
      "$consumer" "$(redis_hash "$consumer")" "$producer" "$producer" "$consumer"
  done
} > "$acl_tmp"
chmod 444 "$acl_tmp"
if ! cmp -s "$acl_tmp" .secrets/local/redis_acl; then
  mv -f "$acl_tmp" .secrets/local/redis_acl
fi

if [ ! -e .env.local ]; then
  touch .env.local
fi
