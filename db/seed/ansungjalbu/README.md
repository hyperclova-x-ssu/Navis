# 안숭잘부 카페 DB 시드

가상 카페 **안숭잘부 카페**의 `content.json`을 **ERD v1.1**의 PostgreSQL 시드 구문과 요약으로 변환합니다. Node 내장 모듈만 사용하며 **Node 20.20.1**과 호환됩니다. 모든 인물·연락처·거래처·승인번호는 가상입니다. 기준 문서는 [team/backend/ERD.md](../../../../team/backend/ERD.md)이며, “v1 대비 컬럼 변경 (시드 생성기용)” 점검표와 팀에서 아직 확정하지 않은 백엔드 초안을 참고합니다.

저장소 루트에서 실행합니다.

```sh
node 04_app/db/seed/ansungjalbu/generate.mjs
```

기본값은 생성기 옆 `content.json`, 종료일 **2026-11-17**, **90일**, seed **42**, 생성기 옆 `out/`입니다. 종료일은 현재 시각과 무관하게 고정해 두었습니다. 기본 기간은 **2026-08-20~2026-11-17**, 양 끝을 포함합니다. 날짜가 바뀌면 `--end`를 명시합니다.

```sh
node 04_app/db/seed/ansungjalbu/generate.mjs \
  --content 04_app/db/seed/ansungjalbu/content.json \
  --end 2026-11-17 --days 90 --seed 42 \
  --out 04_app/db/seed/ansungjalbu/out/

node --test 04_app/db/seed/ansungjalbu/generate.test.mjs
```

| 옵션 | 뜻 |
| --- | --- |
| `--content` | 입력 JSON. 명시한 상대 경로는 명령 실행 폴더 기준 |
| `--end` | 마지막 영업일, `YYYY-MM-DD` |
| `--days` | 포함할 연속 영업일 수, 1~3660. 현재 계약은 매일 영업하는 가게 |
| `--seed` | 0 이상의 JavaScript 안전 정수 |
| `--out` | 출력 폴더. 명시한 상대 경로는 명령 실행 폴더 기준 |
| `--help` | 옵션과 기본값 출력 |

출력은 `seed.sql`, `summary.json`, `summary.md` 세 개입니다. 매출 중앙값은 원 단위로 반올림합니다. `out/`은 이 폴더의 `.gitignore`로 제외합니다. 출력 위치를 바꿀 때도 큰 SQL과 요약을 커밋하지 않습니다. 입력 검증과 전체 일관성 검사가 끝난 뒤에만 출력 폴더를 만듭니다. 실패하면 stderr에 원인을 쓰고 종료 코드 1을 반환합니다. 기존 출력이 있으면 검증 실패 시 그 파일은 이전 결과 그대로 남습니다.

SQL은 500행씩 묶은 INSERT, BEGIN/COMMIT, 트랜잭션 내 UTC 시간대 설정과 PostgreSQL E 문자열 이스케이프를 사용합니다. NULL을 허용하는 `bill.reservation_first_order_id`는 먼저 NULL로 넣고 주문이 생성된 뒤 매장 범위를 제한한 UPDATE로 설정하여, 제약 검사를 지연하지 않고도 계산서/주문 간 FK 순환을 해결합니다. **비어 있는 가상 데이터용 ERD v1.1 스키마**는 별도로 준비합니다. 여기서는 DDL을 실행하거나 적재하지 않으며, 최종 NULL 허용 여부·열거형·공통 열·제약은 나중에 마련할 DDL과 대조해야 합니다.

같은 JSON 내용, 옵션, seed에서는 SQL과 두 요약 파일이 바이트 단위로 같습니다. 현재 시각·호스트 시간대·절대 입력/출력 경로를 결과에 넣지 않습니다. UUID는 seed와 업무 키의 SHA-256에서 만들며 v5 형식 비트만 사용한 **가상 UUID**입니다. 표준 UUID v5 네임스페이스 해시의 구현은 아닙니다. 영업일·주문 일련번호·회원 코드는 각각 별도로 만듭니다.

## 생성 범위와 계산

평일/주말 기본 주문 수에 요일·학사일정 배율과 seed 기반 ±7% 변동을 적용합니다. 영업시간 안에서 시간대 가중치를 다시 정규화하며, 09:30 같은 부분 시간도 반영합니다. 주문 품목 수·메뉴 인기도·회원층 선호·방문빈도 가중치·포장 비율·결제수단 비율을 입력에서 읽습니다. 기존 앱 목업의 매출·판매량을 가져오지 않습니다. 방학과 연휴에는 입력 배율에 따라 일매출이 평소 범위보다 낮을 수 있습니다.

회원의 약 1/7에게 처음부터 보유한 가상 횟수권을 주고, 기간 안에 대상 메뉴를 주문하면 사용합니다. 회원권은 60일 유효하며 사용 잔량과 취소 복원을 맞춥니다. 회원권 판매 수납 관계가 ERD에 없으므로 이 시드에서는 **기간 시작 전 보유한 혜택**으로만 취급합니다. 회원권 상품 가격을 카페 POS 매출에 더하지 않습니다. 회원 직접 할인·쿠폰·회원권은 계산서마다 하나만 적용합니다. 각 회원의 방문 수가 `visits_per_month`와 정확히 같도록 강제하지 않고 고객 선택 가중치로 사용합니다.

취소는 원금·원래 할인·수량·판매 당시 원가를 전부 돌려놓는 전액 취소입니다. 환불은 결제액 절반을 원 단위로 배분한 금액 환불이며, 판매 수량·원가·재고·회원권 사용은 유지합니다. 둘 다 원본 결제와 정산 줄을 보존하고 정정 행을 추가합니다. 순매출은 **원 승인액 − 취소액 − 환불액**입니다. `payment.status='canceled'`라는 이유로 원금을 먼저 제외한 다음 취소액을 또 빼면 안 됩니다. 0원 계산서는 판매/정산/혜택 사용만 있고 결제 행은 없습니다.

마감의 `gross`·`discount`·`paymentCount`·`orders`는 원본 합계/건수를 유지하며, 취소 합계/건수는 별도로 둡니다. 취소를 제외한 결제 건수는 `paymentCount - cancelCount`입니다. `netSales`와 `byMethod`는 정정을 이미 차감한 값입니다. 모든 마감 JSON 스냅샷은 `version: 1`을 포함하고, `based_on_revision`은 해당 영업일의 최종 수정 번호를 복사합니다. 앱의 마감 JSON 계약에 맞추는 어댑터는 이번 작업 범위 밖입니다.

실제 PostgreSQL 적재와 별개로 생성기에 다음 검사가 내장되어 있습니다.

- 모든 PK 중복·FK 대상·단일 매장 범위, UUID 형식, 정수 KRW와 `numeric(12,0)` 범위
- 계산서별 결제 원금 = 정산 줄 총액 − 원래 할인, 수단별 합 = 결제 원금
- 주문 줄·옵션 가격·배정 수량 = 정산 줄, 할인 배분 합 = 할인 원금
- 인정된 판매를 대상으로 하는 정정, 종류별 NULL 규칙, 원래 할인과의 연결, 결제수단/수량/할인/원가 한도
- 영업일별 유효 마감 하나, `based_on_revision` 일치, 버전이 있는 스냅샷과 현금/원장 합계, 시재 확인 시각과 현금 결제 순서
- `store.timezone`과 `business_day_start` 기준 영업일, 자정 뒤 주문·결제·정정·마감
- 일별 재고 이월, 모든 판매 시점의 추적 재고 음수 방지, 입고당 재고 변동 한 번, 품목과 발주 줄의 단위 및 변환 배수 일치, 발주 납기와 지출 단위 변환
- 회원권 잔여 횟수·취소 복원·유효기간

## ERD v1.1 매핑

매핑은 `generate.mjs`의 `SCHEMA`와 업무 영역별 생성/검사 코드에 선언합니다. [team/backend/ERD.md](../../../../team/backend/ERD.md)를 기준으로 ERD가 바뀌면 표·열·PK·FK와 이를 사용하는 코드를 함께 수정한 뒤 다시 생성합니다. 요약에는 ERD 버전, 전체 표 수/행이 있는 표 수와 표별 행 수를 표시합니다.

| 입력/업무 | 출력 표와 규칙 |
| --- | --- |
| 계정 / 매장 / 배치 | `app_user`, `store`, `store_member`, `store_table_layout`, `store_table`을 만듭니다. 가상 소유자 한 명과 9×6 배치를 사용합니다. `store.timezone`과 `store.business_day_start`는 필수이며 이 카페의 입력값인 `Asia/Seoul`과 `05:00`을 저장합니다. `store.area_key/lat/lng`는 명시된 입력 필드를 사용하고, 없으면 NULL로 둡니다. 주소 설명문을 행정동 코드나 좌표로 취급하지 않습니다. |
| 공통 열 | ERD 기본 규칙에 따라 매장 표에 `store_id`, `created_at`, `updated_at`을 추가. `app_user`는 명시된 열만 사용. `store`도 생성/수정 시각 포함 |
| 메뉴 / 옵션 / 레시피 | `menu_item`, 옵션 표와 `recipe_line`을 만듭니다. 분류는 drink/dessert로 매핑하고 활성 날짜를 지킵니다. 선택 항목인 `menu_item.memo`를 보존합니다. |
| 원가 | 기본 레시피 원가를 반올림하여 `settlement_line.unit_cost_at_sale`에 고정합니다. 선택된 옵션의 추가 레시피는 명시적으로 비어 있으므로 `option_cost_at_sale=0`입니다. 레시피가 없는 유료 옵션은 카탈로그에만 둡니다. v1의 두 원가 열은 각각 NULL을 허용하며, 검사기는 모르는 원가를 NULL로 유지합니다. |
| 옵션 | 모든 옵션을 카탈로그에 넣되 추가 레시피가 없는 유료 옵션은 판매에서 선택하지 않음. 선택된 무료 옵션의 `extra_recipe=[]`. `option_recipe_line`은 생략 |
| 재고 / 거래처 | `inventory_item.track_restock=content.track`으로 설정합니다. 판매 상품의 부족 기준이 없는 이 재료들은 `low_stock_per_channel=NULL`로 둡니다. 유통기한 자료가 없으면 `track_expiry=false`로 설정합니다. |
| 발주 단위 | `purchase_item.purchase_unit`은 g/kg/mL/L/pcs입니다. 필수 열 `purchase_item.base_per_unit`에는 발주 단위 하나에 해당하는 재고 기본 단위의 수를 저장하며 변환이 없으면 1을 저장합니다. 최소 수량/주문 간격은 해당 단위로 환산한 입력 포장 한 묶음이며, `unit_price`는 **한 단위당** 정확한 정수 원 가격입니다. 1000g에 25,700원 → kg, 최소 수량/주문 간격 1, 단가 25,700, `base_per_unit=1000`입니다. 케이크 열 개에 21,000원 → pcs, 최소 수량/주문 간격 10, 단가 2,100, 변환 배수 1입니다. |
| 포장 표기 | 정확한 원가와 완포장 발주를 유지합니다. 지휘자가 승인한 탄산수 매핑은 24×350mL에 13,200원 → pcs(한 캔), 최소 수량/주문 간격 24, 단가 550, `base_per_unit=350`입니다. 정확히 환산할 수 없으면 가격을 반올림하거나 단위를 만들어 내지 않고 명확한 오류를 냅니다. |
| 발주 / 입고 | 기존의 예측 기간 기준 보충, 거래처별 발주 요일·납기·최소 발주금액을 유지합니다. `purchase_order.expected_time`은 모델에 있는 개점 시각 도착을 사용하고, 발주 줄에는 품목의 발주 단위와 변환 배수를 각각 `unit_snapshot`과 `base_per_unit`에 복사하고 단가와 이름도 고정합니다. 발주/입고 수량은 발주 단위이며, 재고 변동=`receipt.qty × base_per_unit`, 지출=`receipt.qty × unit_price`입니다. |
| 재고 | `stock_daily_opening`의 PK는 `(item_id, business_date, channel)`이며, 모델의 모든 시작 재고/변동은 `channel='store'`를 사용합니다. 일별 이월에 입고당 변동 한 번을 더하고 정산×레시피를 빼며 취소 시 복원합니다. 입고와 재고 변동을 이중으로 더하지 않습니다. `channel_stock`은 v1에서 삭제되었습니다. |
| 비추적 소모품 | `track_restock=false`를 SQL에 보존하고 부족 검사에서 제외합니다. 기존 소모품 보충 시뮬레이션을 유지하며 새 보충 기능은 추가하지 않습니다. |
| POS / 계산서 | 한 주문·한 계산서·최대 한 결제를 만듭니다. 영업일별 주문 번호를 `pos_order.seq`와 `payment.seq`에 사용합니다. `requested_at`은 주문 시각이며, `member_link_chosen`은 모델에 있는 회원 연결을 기록합니다. 연결된 예약에는 수락 결정과 첫 주문 FK를 둡니다. `cart_id=NULL`이며, 준비 시작 사건이 없으므로 `prepared_at=NULL`입니다. 선택 항목인 주문/시재 메모는 NULL로 둡니다. |
| 정정 / 마감 | `target='recognized_sale'`로 설정합니다. 환불 줄은 `amount`를 사용하고 gross/discount/cost는 NULL로 둡니다. 취소 줄은 gross/discount/cost를 사용하고 amount는 NULL로 둡니다. `correction_discount`는 취소된 원래 할인 배분을 각각 보존합니다. `business_day.drawer_counted_at`은 `drawer_actual`과 함께 채우며 마감의 `closed_at`을 사용합니다. 두 값은 함께 NULL이거나 함께 채워집니다. 세대는 1을 유지합니다. ERD 팀 기본안 8번에 따라 `payment.created_by` / `payment_correction.created_by`는 가상 소유자를 참조합니다. |
| 손님 | `customer`, `member_profile`, `customer_visit`를 만듭니다. 고객/영업일당 방문 한 번을 기록하며 전액 취소는 제외하고 환불은 유지합니다. `phone_last4`는 정규화한 가상 번호에서 가져오며, `phone_hash=SHA256(store_id + ':' + digits)`로 해시 범위를 매장 안으로 제한합니다. |
| 횟수권 | `membership_product`, `membership`, `membership_use`. 대상 메뉴 관계는 ERD 열이 없어 content와 함께 보관해야 함 |
| 예약 | 회원 예약에는 `guest_name` 대신 `guest_name_enc`를 사용합니다. 비회원 신원/요청/제안은 모델에 없으므로 선택 암호화 필드와 `proposed_at`은 NULL로 둡니다. `confirmed_by='auto'`, `capacity_override=false`, `override_reason=NULL`로 설정하고 변경 스냅샷에는 상태만 보존합니다. |
| 할인 / 쿠폰 | `bill_id`를 `bill_discount.origin_bill_id`로 바꾸고, `contribution_member_id`에 원래 회원을 보존합니다. 현재 적용 관계는 할인 배분 → 계산서 배분 → 계산서로 따라갑니다. 수동 쿠폰의 `origin_slot_keys`(`text[]`)는 비우고 품목/영상/세트 가격 출처는 NULL로 둡니다. 기존 유효기간·한도·채널 매핑을 유지합니다. |
| 지출 | 입고 지출과 월 정기 지출의 기존 분류 매핑을 유지하고, 입력의 선택 항목인 `memo`를 보존합니다. 증빙 파일을 만들어 내지 않습니다. |
| 문의 / 리뷰 | `body`를 `inquiry_thread.body_enc`로 바꿉니다. 공개 네이버 리뷰는 `is_public=true`, 직접 문의는 false로 설정합니다. 감정이 명시되어 있으면 복사하고 없으면 NULL로 둡니다. 평점으로 감정을 만들어 내지 않습니다. |
| 매뉴얼 / 일정 | `manual`, `manual_step`, `calendar_event`를 만듭니다. 선택 항목인 휴무 필드가 명시되어 있으면 보존하고 없으면 NULL로 둡니다. 동네 행사는 지역 관측이 아닌 가상 캘린더 일정으로 유지하며 `done_at=NULL`로 설정합니다. |
| 새 빈 원본 표 | `demand_forecast`, `cart`, `cart_line`, `split_plan`, `payment_part`, `payment_part_line`은 v1 매핑을 선언하고 행은 만들지 않습니다. 예측과 영구 저장/분할 결제 장바구니 사건은 모델에 없으며, 요약의 `skipped`에 표시합니다. |

이름·전화번호·문의/리뷰 본문에는 기존 **공개 테스트 자료용** AES-256-GCM 변환을 사용합니다. 키는 `SHA256("PUBLIC-FIXTURE-KEY:" + seed)`, IV는 업무 키로 정한 12바이트이며, `IV(12) + tag(16) + ciphertext` 형식으로 저장합니다. 비밀값이나 환경변수는 필요하지 않습니다. `_enc` 값은 이진 암호문이며, 이 테스트 자료용 변환은 운영 환경의 KMS/키 관리 방식이 아닙니다.

영업일은 IANA 시간대로 현지 시각을 구한 뒤 넘김 기준 이전이면 전날로 잡습니다. 영업시간이 자정을 넘어도 처리하지만, 영업일 경계를 가로지르는 영업시간과 DST로 존재하지 않는 현지 시각은 오류로 거절합니다. 현재 가게의 Asia/Seoul 05:00 경계에는 DST가 없습니다.

## 미확정 범위

ERD v1은 v0의 추적 여부/단위/스냅샷, 할인 원본, 정정 줄과 CCTV 키 누락을 해결했으므로 이를 더 이상 스키마 누락으로 표시하지 않습니다. 팀 질문의 결정 권한은 팀에 있으며, 여기서 확정하지 않고 문서에 적힌 기본안을 적용합니다. ERD 질문 1, 2, 4, 6, 12의 답은 [team/backend.md](../../../../team/backend.md)의 백엔드 초안, 팀 확정 전입니다. 실행할 때마다 생략한 원본을 `summary.md`와 `summary.json.skipped`에 표시합니다.

- ERD 질문 12의 DB와 서버 스택 및 비용은 아직 결정되지 않았으며 사용자의 승인이 필요합니다.
- 보존 기간, K11 추천 할인 단계의 숫자, 14일 귀속의 정확한 정의는 아직 열려 있습니다.
- 기본 입력에는 행정동 `area_key`, 좌표, 준비 시작 사건, 주문/시재 메모, 예약 요청/제안, 감정이나 휴무 자료가 없으므로 선택 열은 NULL로 둡니다. 새 필수 원본 자료는 콘텐츠 소유자에게 요청해야 하며, 최종 DDL의 NULL 허용 여부는 검증하지 않았습니다.
- 예측 표는 있지만 예측/제공처 사건은 모델에 없습니다. 수요 가중치는 시뮬레이션 입력으로 유지합니다. K07/K17은 별도로 두며, 귀속·14일 규칙·재방문 지표는 팀의 정의가 필요합니다.
- 분할 결제, 영구 저장 장바구니, 테이블 이동과 일부 수량 취소는 모델에 없습니다. 회원권 대상 메뉴 관계와 취득/수납 원본은 매핑이 더 필요하며, 혜택은 기간 시작 전 보유분으로 유지합니다. 옵션 추가 레시피가 없으므로 유료 옵션은 판매하지 않습니다.
- 마감에는 수정 번호/버전의 근거를 보존하지만, 재열기·동시성·원자적 명령 원장·원격 승인 복구는 시뮬레이션하지 않습니다. 정정은 원래 영업일 안에서 처리하므로 처리일 기준 기본안을 적용해도 이 모델에서는 날짜가 같습니다. 이 카페는 미설정 매장에 대한 ERD의 00:00 기본값 대신 05:00 넘김 시각을 명시적으로 설정합니다.
- 운영 환경의 KMS, 동의 철회, 보존/삭제와 백업은 팀/DDL 작업으로 남습니다. 매번 같은 결과를 내는 테스트 자료용 암호화와 매장별 솔트는 운영 환경의 키 관리 방식이 아닙니다.
- 직원/근무표, `assistant_*`, `ai_usage`, 대시보드 환경설정과 명령 원장에는 여기서 사용할 입력 사건이 없습니다. 대화의 영구 저장은 꺼진 상태로 유지하며, 발송·답장·체크리스트 완료 사건을 만들어 내지 않습니다.
- CCTV 관측, 지역 자료 제공처 기록, 파일과 홍보/음악 사건이 없습니다. v1의 `promo_video.music_track_id`는 varchar이며 음악 FK는 출력하지 않습니다. 나머지 변경 표(`grant_notice`, `cash_movement`, `member_note`, `call_log`, `message_send`, `area_event`, `partnership_offer`, `user_coach_state`, `dashboard_panel`, `command_ledger`, `file_object`, 구역/집계 구간/위치 확인 표, `manual_draft`)도 모델에 있는 사건이 없어 생략합니다.
- 복합 FK/RLS 제약, DDL, PostgreSQL 적재, DB/서버 선택, 외부 연동, 앱 어댑터와 Navis 연동은 후속 작업입니다.

DB/서버 설정, PostgreSQL 적재 검증, 앱 데이터 소스 교체, 미정 지표의 Navis 연결은 후속 작업입니다. 이 생성기를 실행해도 현재 앱 화면의 목업 숫자는 바뀌지 않습니다.
