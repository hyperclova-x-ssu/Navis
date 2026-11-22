#!/usr/bin/env bash
# Download the official public files behind the Sangdo-dong snapshot into OUT_DIR (keep OUT_DIR outside the repo).
# Uses only the portals' public file download and "CSV 내려받기" endpoints. No login, no API key, no page scraping.
# Usage: fetch-official.sh OUT_DIR [YYYYMM ...]   (default months: 202607 202608 202609 202610)
set -euo pipefail
out="${1:?Usage: fetch-official.sh OUT_DIR [YYYYMM ...]}"
shift
months=("$@")
[ "${#months[@]}" -gt 0 ] || months=(202607 202608 202609 202610)
codes='11590530|11590540|11590550|11590560' # 상도1동 상도2동 상도3동 상도4동 (OA-22172 code table)
mkdir -p "$out/pop" "$out/sheet" "$out/codes" "$out/licenses" "$out/events"
manifest="$out/manifest.tsv"
printf 'path\tdataset\turl\tcontentDisposition\tbytes\tsha256\tretrievedAt\n' > "$manifest"

record() { # path dataset url headers
  local disposition
  disposition="$(grep -i '^content-disposition:' "$4" | tr -d '\r' | sed 's/^[^:]*: *//')"
  [ -n "$disposition" ] || { echo "No file returned for $1" >&2; exit 1; }
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${1#"$out"/}" "$2" "$3" "$disposition" "$(wc -c < "$1" | tr -d ' ')" \
    "$(sha256sum "$1" | cut -d' ' -f1)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$manifest"
}

file_download() { # infId seq infSeq target dataset
  local url='https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false'
  curl -fsS --max-time 900 -D "$4.headers" -o "$4" -X POST --data "infId=$1&seqNo=&seq=$2&infSeq=$3" "$url"
  record "$4" "$5" "https://data.seoul.go.kr/dataList/$1/S/1/datasetView.do#file-$2" "$4.headers"
}

sheet_csv() { # infId target dataset [filterColumn filterText]
  local form="$out/sheet/form-$1.html" where order user
  curl -fsS --max-time 60 -o "$form" -X POST --data "infId=$1&srvType=S&serviceKind=1" \
    "https://data.seoul.go.kr/dataList/sheetView.do?infId=$1&srvType=S"
  where="$(grep -o -E 'name="strWhere" id="strWhere" value="[^"]*"' "$form" | sed -E 's/.*value="([^"]*)"/\1/' | sed "s/&#39;/'/g; s/&gt;/>/g; s/&lt;/</g; s/&amp;/\&/g")"
  order="$(grep -o -E 'name="strOrderby" id="strOrderby" value="[^"]*"' "$form" | sed -E 's/.*value="([^"]*)"/\1/')"
  user="$(grep -o -E 'name="ssUserId" id="ssUserId" value="[^"]*"' "$form" | sed -E 's/.*value="([^"]*)"/\1/')"
  curl -fsS --max-time 900 -D "$2.headers" -o "$2" -X POST \
    --data-urlencode "srvType=S" --data-urlencode "infId=$1" --data-urlencode "serviceKind=1" \
    --data-urlencode "pageNo=1" --data-urlencode "gridTotalCnt=" --data-urlencode "ssUserId=$user" \
    --data-urlencode "strWhere=$where" --data-urlencode "strOrderby=$order" \
    --data-urlencode "filterCol=${4:-필터선택}" --data-urlencode "txtFilter=${5:-}" \
    "https://datafile.seoul.go.kr/bigfile/iot/sheet/csv/download.do"
  record "$2" "$3" "https://data.seoul.go.kr/dataList/$1/S/1/datasetView.do#csv${5:+-$5}" "$2.headers"
}

# [내국인] 행정동별 서울 생활인구(250m), monthly files. Keep only the four Sangdo administrative dongs.
for month in "${months[@]}"; do
  zip="$out/pop/250_LOCAL_RESD_ADMDONG_$month.zip"
  file_download OA-23016 "$month" 1 "$zip" 'OA-23016 [내국인] 행정동별 서울 생활인구(250m)'
  filtered="$out/pop/250_LOCAL_RESD_ADMDONG_${month}_sangdo.csv"
  : > "$filtered"
  for entry in $(unzip -Z1 "$zip" | sort); do
    unzip -p "$zip" "$entry" | grep -a -E "\"($codes) *\"" >> "$filtered" || true
  done
done
# The same dataset's recent rows (the Sheet keeps about two months) for days after the last monthly file.
for code in 11590530 11590540 11590550 11590560; do
  sheet_csv OA-23016 "$out/pop/recent_$code.csv" 'OA-23016 [내국인] 행정동별 서울 생활인구(250m)' H_DNG_CD "$code"
done
# Official administrative-dong code table (상권분석서비스 점포-행정동, 2025 file).
file_download OA-22172 7 3 "$out/codes/store_admdong_2025.zip" 'OA-22172 서울시 상권분석서비스(점포-행정동)'
# Dongjak-gu food business licenses (general and rest restaurants, which include cafés).
sheet_csv OA-18671 "$out/licenses/dongjak_general_restaurants.csv" 'OA-18671 서울시 동작구 일반음식점 인허가 정보'
sheet_csv OA-18696 "$out/licenses/dongjak_rest_restaurants.csv" 'OA-18696 서울시 동작구 휴게음식점 인허가 정보'
# Seoul cultural events and festivals (Seoul culture portal).
sheet_csv OA-15486 "$out/events/seoul_cultural_events.csv" 'OA-15486 서울시 문화행사 정보'
echo "Wrote $manifest"
