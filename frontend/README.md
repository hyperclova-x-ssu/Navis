# Navis Frontend

Navis 웹 앱입니다. 브라우저에서 동작하는 **React SPA**와, 개발 서버에 붙어 HyperCLOVA X를 중계하는 **Node 서버 코드**로 이루어져 있습니다.
업무 데이터는 브라우저 안의 가짜 DB(가상 카페 '안숭잘부')에서 오며, 같은 계약으로 백엔드 HTTP 어댑터와 바꿔 끼울 수 있게 나뉘어 있습니다.

```bash
npm ci
npm run dev          # http://127.0.0.1:5173
npm run typecheck
npm run test:unit    # Vitest
npm run test:server  # Node test runner
npm run build
```

<br/>

## 의존 방향

```text
screens / features  ─▶  state · ui  ─▶  catalog · layout · data · pos  ─▶  contracts
     (화면)              (실행 상태·공용 UI)        (순수 로직)               (타입 계약)
```

- 공용 UI(`ui/`)는 업무 상태를 직접 읽지 않습니다.
- 배치 엔진(`layout/`)은 React·DOM·시계를 모르는 순수 함수이며, Web Worker에서 실행됩니다.
- 돈이 움직이는 처리는 `pos/runtime.ts` 한 곳에서만 일어나고, 화면은 명령을 보내고 결과를 그립니다.

<br/>

## `src/` 폴더 안내

```text
src/
├── main.tsx                     // 앱 진입점
├── app/                         // 앱 셸: 레이어(주문/결제·관리·마케팅) 전환, 세션 동작, 오류 복구, 마감 오버레이
│   ├── App.tsx                  //   최상위 컴포넌트와 화면 전환
│   ├── run.ts                   //   실행 상태 생성과 배치 어댑터 연결
│   ├── session-actions.ts       //   세션 단위 명령(초기화·템플릿 적용 등)
│   └── pos-host.tsx             //   어느 레이어에서든 열 수 있는 결제 창 호스트
│
├── screens/                     // 화면 단위 컴포넌트
│   ├── dashboard/               //   관리·마케팅 대시보드: 격자, 끌어다 놓기, 코칭마크, Navis 대화창 자리
│   ├── detail/                  //   위젯 '자세히 보기' 창(기본 크기 ↔ 전체 화면 토글)
│   ├── order/                   //   주문/결제(POS): 주문 담기, 결제, 테이블, 주문 현황, 마감 정산, 적립
│   ├── onboarding/              //   업종 선택과 시작 위젯 고르기, 테이블 배치 편집
│   ├── briefing/                //   출근·퇴근 브리핑 카드
│   ├── settings/                //   설정: 언어, 테마, 글자 크기, 주문 방식, CCTV 연결
│   └── layer-placeholder/       //   준비 중 레이어 안내
│
├── features/
│   ├── widgets/                 // 대시보드 위젯 30개 (각 폴더 = 위젯 묶음)
│   │   ├── registry.ts          //   위젯 등록부: id·크기·조건 검증 후 앱에 노출
│   │   ├── mgmt-products/       //   메뉴 관리, 메뉴 사진, POS 메뉴판
│   │   ├── mgmt-supply/         //   재고·발주·캘린더 (재고 표, 발주서, 입고)
│   │   ├── mgmt-money/          //   손익·마진·세무·정부지원·브리핑, 영수증 OCR 지출 입력
│   │   ├── mgmt-customers/      //   회원목록, 예약, CCTV 현황
│   │   ├── mgmt-store/          //   매뉴얼 작성
│   │   ├── i7-staff/            //   직원 스케줄표
│   │   ├── i7-environment/      //   매장 환경 (온·습도, 매장 음악)
│   │   ├── i7-custom/           //   주문제작 (픽업 예약, 선금)
│   │   ├── i7-credit/           //   충전금·외상 관리
│   │   ├── i7-notice/           //   공지 발송
│   │   ├── mkt-local/           //   동네 변화, 상권분석, 로컬 트렌드, 커뮤니티, AI 응답(리뷰 답글)
│   │   ├── mkt-coupon/          //   빈 시간 쿠폰, 마감 쿠폰, 쿠폰 현황, 단골 관리
│   │   └── mkt-promo/           //   오늘 할 홍보, AI 홍보 영상, 마케팅 성과
│   ├── assistant/               // Navis AI 비서
│   │   ├── conversation.tsx     //   대화창 UI (스트리밍 답, 멈추기, 다시 묻기)
│   │   ├── provider.ts          //   /api/navis/chat SSE 연결과 오류·대기 처리
│   │   ├── snapshot.ts          //   질문과 관련된 가게 자료만 골라 서버로 보낼 묶음 만들기
│   │   ├── navis-input.ts       //   한국어 금액·수량·날짜·시간 해석 ("삼천오백 원", "다음 주 화요일")
│   │   ├── proposal-card.tsx    //   위젯 후보·확인 카드 (누르거나 끌어서 실행)
│   │   ├── agent-actions.ts     //   "재고 위젯 추가해줘" 같은 명령을 놓기 동작으로 연결
│   │   ├── domains/             //   도메인별 질문 처리 (메뉴·재고·예약·쿠폰·회원·공지 등)
│   │   └── media/               //   마이크 음성 입력
│   └── cctv/                    // CCTV
│       ├── playback/            //   예시 영상 재생과 사람·컵 상자 그리기
│       ├── live/                //   실시간 분석 서버(WebSocket) 연결
│       └── zones/               //   테이블 구역 그리기와 마스크 압축(RLE)
│
├── data/                        // 브라우저 안의 가짜 DB와 데이터 계층
│   ├── db/                      //   테이블 타입, 시드, 영업 시계, 생성된 90일 운영 데이터
│   ├── models/                  //   위젯이 읽는 모델(매출·재고·회원·일정 등) 계산
│   ├── derive/                  //   파생 지표: 손익, 마진, 재고 소진, 예약, 결제 집계
│   ├── commands/                //   데이터 변경 명령과 검증 (메뉴 수정, 예약, 공지 등)
│   ├── marketing/               //   쿠폰·홍보·상권 데이터와 명령
│   ├── pos/                     //   POS 결과를 관리 위젯 숫자로 투영 (한 숫자 한 출처)
│   ├── iteration7/              //   직원·공지·매장 환경·주문제작·충전금·회원권·회계 도메인
│   ├── cctv/                    //   CCTV 탐지 결과 읽기, 자리 상태, 음료 대기 판정
│   ├── backend-catalog/         //   백엔드 HTTP 메뉴 조회 어댑터
│   └── messages/                //   데이터 계층 문구 (4개 언어)
│
├── pos/                         // 결제 도메인 로직
│   ├── runtime.ts               //   돈이 움직이는 유일한 처리기 (준비 → 승인 → 공개를 원자적으로)
│   ├── domain/                  //   계산서, 할인 배분, 결제 수단, 정산 규칙
│   ├── reversals/               //   취소·환불과 정정 영수증
│   ├── closing/                 //   마감 정산, 시재 확인, 다시 열기
│   ├── loyalty/                 //   회원 적립·충전금·회원권 사용
│   ├── tables/                  //   테이블 이용 상태
│   └── status/                  //   주문 현황
│
├── layout/                      // 격자 배치 엔진
│   ├── index.ts                 //   좌표 검증, 가장 가까운 빈 자리 찾기, 정확한 밀어내기 탐색
│   ├── layout.worker.ts         //   탐색을 화면 입력과 분리하는 Web Worker
│   └── presets.ts               //   업종별 시작 배치
│
├── catalog/                     // 위젯 등록부, 관리 템플릿, 위젯 모듈 자동 등록
├── contracts/                   // 화면·데이터·POS가 공유하는 타입 계약 (세션, 좌표, 결제)
├── state/                       // RunStore: 레이어별 보드 상태, 되돌리기, 브리핑 날짜
├── ui/                          // 디자인 시스템
│   ├── tokens.css               //   색·간격·글자·그림자 토큰 (라이트·다크)
│   ├── components/              //   버튼, 표, 차트, 대화상자, 입력 필드 등 공용 컴포넌트
│   ├── motion.ts                //   전환 시간과 감속 곡선 (동작 줄이기 설정 대응)
│   └── icons.tsx                //   아이콘 세트
├── i18n/                        // 4개 언어(ko·en·zh-Hans·zh-Hant) 번역 엔진, ICU 복수형, 숫자·날짜 포맷
├── orders/                      // 주문 현황용 주문 행·요약·알림
└── assets/                      // 브랜드 로고, 글꼴(OFL), 좌석 배치도 그림
```

<br/>

## `server/` 폴더 안내

Vite 개발 서버(`vite.config.ts`)에 미들웨어로 장착되어 같은 출처의 `/api/*` 요청을 처리합니다. API 키는 서버 쪽 환경변수에서만 읽습니다.

```text
server/
├── vite-plugin.mjs              // .env.local을 읽어 각 서비스를 Vite 미들웨어로 장착
├── bridge.mjs                   // POST /api/navis/chat — Navis 대화 중계
│                                //   입력 검증 → 관련 자료 정리 → HCX-005 호출(SSE)
│                                //   → 문장 단위 근거 검사 → 위젯 후보 검증 → 브라우저로 스트리밍
├── clova-studio.mjs             // CLOVA Studio native v3 클라이언트 (스트리밍, 토큰 계산, 오류 분류)
├── navis/                       // Navis 도구: 도메인별 질문 해석과 확인 카드 만들기
│   ├── registry.mjs             //   도구 등록부와 대상 위젯 결정
│   ├── conversation.mjs         //   이전 대화 요약과 이어 묻기 해석
│   └── menu · inventory · booking · coupons · members · money · notices ...
├── widget-drafts.mjs            // 리뷰 답글·매뉴얼·정부지원 신청서 초안, 테스트 문자 확인 단계
├── sens-sms.mjs                 // SENS 문자 발송 (허용 목록 번호만, 기본 꺼짐)
├── media/                       // 영수증 OCR·음성 인식 중계 (기본은 가짜 응답)
├── promo/                       // AI 홍보 영상
│   ├── pipeline.mjs             //   사진 분석 → 대본(HCX-007) → 장면 코드 → 검사 → 녹화
│   ├── jobs.mjs                 //   작업 큐, 동시 실행 제한, 취소
│   ├── check-story.mjs          //   대본 글자 수·금지어·장면 수 검사
│   ├── check-scene.mjs          //   생성된 장면 코드의 정적·실행 검사 (격리된 브라우저)
│   ├── recorder.mjs             //   장면을 프레임으로 녹화해 영상으로 합성
│   ├── estimate.mjs             //   예상 시간·비용 계산
│   ├── prompts/                 //   단계별 프롬프트
│   ├── references/              //   장면 레퍼런스 예시와 글꼴
│   └── assets/                  //   AI 생성 카페 사진, CC0 배경 음악
├── private-origin.mjs           // 같은 출처·Host·Fetch Metadata 확인
└── fixtures/                    // 키 없이 동작하는 가짜 모델 응답
```

<br/>

## 환경변수

`.env.local.example`을 `.env.local`로 복사해 사용합니다. 값을 비워 두면 모든 외부 호출은 가짜 모드로 동작합니다.

| 변수 | 설명 |
| :--- | :--- |
| `CLOVASTUDIO_API_KEY` | CLOVA Studio API 키 (없으면 Navis 간단 모드) |
| `CLOVASTUDIO_MODEL` | 기본 `HCX-005` |
| `NAVIS_AGENT_MODE` | `fixture`(기본) 또는 `live` |
| `NAVIS_WIDGET_MODE` | 초안·문자 전송 모드, 비우면 가짜 전송 |
| `NAVIS_REPLY_SEND_ENABLED` | `true`일 때만 실제 테스트 문자 발송 |
| `SENS_SMS_*`, `NCP_APIGW_KEY*` | SENS 문자 발송 설정 |

<br/>

## 시험

| 명령 | 범위 |
| :--- | :--- |
| `npm run test:unit` | 화면·데이터·배치 엔진·i18n 단위 시험 (jsdom) |
| `npm run test:server` | Navis 중계, CLOVA 클라이언트, 홍보 영상 파이프라인, 문자 발송 가드 |
| `npm run test:core` | 카탈로그·배치 엔진·실행 상태 핵심 시험 |

일부 시험은 저장소 밖에 보관하는 자료(녹음된 Navis 대화 시나리오, 제품 문구 표)를 읽습니다. 그 자료가 없으면 해당 시험은 자동으로 건너뜁니다.
