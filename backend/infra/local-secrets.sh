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
    for role in mig run; do
      write_secret ".secrets/$mode/db/${service}_${role}_password" openssl rand -hex 32
    done
  done
  for role in nvirtual_mig nvirtual_run; do
    write_secret ".secrets/$mode/db/${role}_password" openssl rand -hex 32
  done
  for service in pos inventory customer marketing insight; do
    write_secret ".secrets/$mode/db/${service}_rly_password" openssl rand -hex 32
  done
  for service in inventory marketing pos; do
    write_secret ".secrets/$mode/db/${service}_wrk_password" openssl rand -hex 32
  done
done

write_secret .secrets/local/account_signing_key.pem openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256
write_secret .secrets/local/gateway_account_token openssl rand -hex 32
write_secret .secrets/local/gateway_inventory_token openssl rand -hex 32
write_secret .secrets/local/pos_inventory_token openssl rand -hex 32
write_secret .secrets/local/inventory_account_token openssl rand -hex 32
write_secret .secrets/local/marketing_worker_inventory_token openssl rand -hex 32
write_secret .secrets/local/marketing_customer_sms_token openssl rand -hex 32
write_secret .secrets/local/marketing_sms_worker_token openssl rand -hex 32
write_secret .secrets/local/talktalk_draft_token openssl rand -hex 32

write_secret .secrets/local/gateway_pos_token openssl rand -hex 32
write_secret .secrets/local/gateway_customer_token openssl rand -hex 32
write_secret .secrets/local/customer_pos_token openssl rand -hex 32
write_secret .secrets/local/pos_customer_token openssl rand -hex 32
write_secret .secrets/local/pos_account_token openssl rand -hex 32
write_secret .secrets/local/nvirtual_aicall_customer_token openssl rand -hex 32
write_secret .secrets/local/nvirtual_talktalk_marketing_token openssl rand -hex 32
for service in customer inventory pos; do
  write_secret ".secrets/local/insight_${service}_read_token" openssl rand -hex 32
done

for workload in account pos inventory customer marketing insight marketing_worker; do
  write_secret ".secrets/local/nvirtual_${workload}_token" openssl rand -hex 32
done

persona_provider=.secrets/local/naver-virtual-provider
mkdir -p "$persona_provider"
chmod 755 "$persona_provider"

# Synthetic provider credentials are scoped by the Compose operation grants.
for name in pay-id pay-secret pay-chain talktalk hub-id hub-key maps-id maps-key login-id login-secret \
  works-read works-write ads-id ads-key sms-id sms-key alimtalk-id alimtalk-key brandmessage-id brandmessage-key \
  mail-id mail-key insight-studio-key marketing-studio-key worker-studio-key speech-secret ocr-domain ocr-invoke ocr-secret \
  account-storage-id account-storage-key promo-storage-id promo-storage-key inventory-commerce-id pos-commerce-id; do
  write_secret "$persona_provider/$name" openssl rand -hex 24
done

for workload in inventory pos; do
  write_secret "$persona_provider/$workload-commerce-salt" sh -c 'printf "\$2a\$04\$%s.\n" "$(openssl rand -hex 11 | cut -c 1-21)"'
done
for product in sms alimtalk brandmessage mail; do
  write_secret "$persona_provider/$product-service" printf '%s\n' "ncp:$product:kr:1000001:navis-cafe-fixture"
done
write_secret "$persona_provider/ads-customer" printf '%s\n' 1000001
write_secret "$persona_provider/sms-sender" printf '%s\n' 01000000000
write_secret "$persona_provider/mail-sender" printf '%s\n' cafe@example.invalid
write_secret "$persona_provider/talk-channel" printf '%s\n' @ansungjalbu-fixture
write_secret "$persona_provider/talk-template" printf '%s\n' fixture-order-notice
write_secret "$persona_provider/brand-consent" printf '%s\n' 01000000001
write_secret "$persona_provider/brand-friends" printf '%s\n' 01000000001
write_secret "$persona_provider/storage-bucket" printf '%s\n' ansungjalbu-fixture
write_secret "$persona_provider/account-storage-prefix" printf '%s\n' account/
write_secret "$persona_provider/promo-storage-prefix" printf '%s\n' promo/
write_secret "$persona_provider/commerce-seller" printf '%s\n' ansungjalbu-smartstore
write_secret "$persona_provider/owner-store-id" printf '%s\n' c05409a6-f082-5964-a787-c1ed3184988b
write_secret "$persona_provider/owner-actor-id" printf '%s\n' 9fee123c-ad63-5539-9775-3381f3c67ffe
write_secret "$persona_provider/calendar-owner-scope" printf '%s\n' calendar
write_secret "$persona_provider/cafe-owner-scope" printf '%s\n' cafe

for edge in gateway_insight gateway_marketing gateway_marketing_local_command gateway_sms_confirm marketing_account marketing_community_account \
  marketing_customer_read marketing_customer marketing_inventory marketing_pos insight_account insight_marketing insight_marketing_read \
  forecast_insight forecast_inventory promo_insight; do
  write_secret ".secrets/local/${edge}_token" openssl rand -hex 32
done
write_secret .secrets/local/fixture_cctv_token openssl rand -hex 32
write_secret .secrets/local/fixture_sms_key openssl rand -hex 32

for identity in relay pos inventory customer insight marketing marketing-worker; do
  write_secret ".secrets/local/${identity}_redis_password" openssl rand -hex 32
done

redis_hash() {
  tr -d '\r\n' < ".secrets/local/${1}_redis_password" | openssl dgst -sha256 -r | cut -d ' ' -f 1
}

acl_tmp=$(mktemp .secrets/local/redis_acl.XXXXXX)
trap 'rm -f "$acl_tmp"' EXIT
{
  printf '%s\n' 'user default on nopass -@all +ping'
  printf 'user relay on #%s -@all +ping +client|setinfo +eval +get +set +exists +del +xgroup|create +xadd +xrange ~navis.pos.0 ~navis.pos.0.epoch ~navis.inventory.0 ~navis.inventory.0.epoch ~navis.customer.0 ~navis.customer.0.epoch ~navis.marketing.0 ~navis.marketing.0.epoch ~navis.insight.0 ~navis.insight.0.epoch\n' "$(redis_hash relay)"
  for consumer in pos inventory customer insight marketing marketing-worker; do
    producer=pos
    extra_streams=
    extra_dlq=
    case "$consumer" in
      pos) producer=inventory ;;
      customer) extra_streams=' ~navis.inventory.0 ~navis.inventory.0.epoch ~navis.insight.0 ~navis.insight.0.epoch ~navis.marketing.0 ~navis.marketing.0.epoch' ;;
      insight) extra_dlq=' ~navis.dlq.insight-tables' ;;
      marketing) extra_streams=' ~navis.customer.0 ~navis.customer.0.epoch' ;;
      marketing-worker)
        producer=marketing
        extra_streams=' ~navis.inventory.0 ~navis.inventory.0.epoch'
        extra_dlq=' ~navis.dlq.marketing-supplier'
        ;;
    esac
    printf 'user %s on #%s -@all +ping +client|setinfo +eval +get +exists +xreadgroup +xautoclaim +xack +xpending ~navis.%s.0 ~navis.%s.0.epoch%s (+xadd ~navis.dlq.%s%s)\n' \
      "$consumer" "$(redis_hash "$consumer")" "$producer" "$producer" "$extra_streams" "$consumer" "$extra_dlq"
  done
} > "$acl_tmp"
chmod 444 "$acl_tmp"
if ! cmp -s "$acl_tmp" .secrets/local/redis_acl; then
  mv -f "$acl_tmp" .secrets/local/redis_acl
fi

if [ ! -e .env.local ]; then
  touch .env.local
fi
