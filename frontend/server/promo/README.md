# AI 홍보 영상 대본 생성

`POST /api/promo/jobs` (API-22)의 `story` 단계는 NAVER CLOVA Studio HCX-007의 Chat Completions v3 Structured Outputs를 사용합니다. 서버 프로세스에 `CLOVASTUDIO_API_KEY`를 주입합니다. `CLOVASTUDIO_BASE_URL`은 선택 항목입니다. 대본 모델은 HCX-007로 고정합니다. `scenes`(렌더용 HTML)는 기본이 Claude CLI입니다(D-327 Q7, 아래 “장면 제공자”).

`NAVIS_PROMO_HCX_PILOT`을 설정하지 않으면 서비스의 `look`(사진 분석)은 NAVER HCX-005를 사용합니다(D-328 Q3). 변수를 설정할 때는 정확히 `true`인 경우에만 NAVER를 사용합니다. `false`, `0`, `off`, `no`, 빈 값, 오타 등은 Claude CLI로 전환합니다. 이 설정은 사진 분석에만 적용됩니다. 서비스의 사진 분석 호출 한도는 작업 단위입니다. 사진은 최대 5장이고 러너 재시도와 시간 초과 재시도는 각각 1회입니다. 일일 또는 전체 호출 한도는 없습니다.

## 요청과 검사

- v3 문서의 “Structured outputs are only available on the HCX-007 model.”에 따라 모델은 URL 끝에 지정합니다. 본문은 텍스트 `messages`, `responseFormat.type: "json"`, `responseFormat.schema`, `maxCompletionTokens`, `thinking.effort: "none"`을 보냅니다. `none`은 같은 문서의 요청 예시대로 추론을 끕니다. [Structured Outputs API](https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-so)
- 모델 가이드는 “이미지 입력, 튜닝, Function calling, Structured Outputs, 추론(Thinking) 기능은 동시 이용이 불가”라고 명시합니다. 대본의 시각 참고 정보는 `kind`, `amount`, `menuShown` 텍스트로 전달합니다. 문구에는 카탈로그에 있는 가게명, 위치, 메뉴명만 사실로 쓰도록 지시합니다. [CLOVA Studio 모델 가이드](https://guide.ncloud-docs.com/docs/clovastudio-model)
- 하위 객체와 배열까지 `type`, `properties`, `required`, `items`, `enum`, `minItems`·`maxItems`, `minimum`·`maximum`을 보냅니다. `pattern`은 “is not supported”로 명시돼 있고, `additionalProperties`, `minLength`, `maxLength`는 지원 키워드 목록에 없습니다. 응답을 원본 `STORY_SCHEMA`로 다시 검사해 이 제약들도 적용합니다. 기존 `checkStory`는 시간 합계, 장면·사진·문구 ID의 관계와 캡션 한도를 확인합니다. [지원 JSON Schema](https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-so)

## 승인 후 실호출 1회 제안

예시 카탈로그의 `ref-1` 10초·사진 5장 입력으로 `storyPrompt`를 만들고 `createHcxRunner({ transport, retries: 0 }).run`을 한 번 실행합니다. 응답의 스키마, `checkStory` 결과와 `usage`를 확인합니다. 가짜 전송에서 수집한 문구와 스키마가 총 6.2 KB로, 입력 약 1,600–2,100토큰과 출력 약 400–650토큰을 예상합니다. 실제 출력 상한은 2,048토큰입니다. 영상 전체의 기존 비용 표는 Claude 실측 기준입니다.

## S4 사진·장면 파일럿

아래 독립 실행 파일럿에는 `NAVIS_PROMO_HCX_PILOT=true`를 명시합니다. 사진은 HCX-005에 v3 이미지 파트로 보내며 결과를 서버에서 `PHOTO_META_SCHEMA`로 검사합니다. 파일럿의 NAVER 장면은 HCX-007 Structured Outputs, 정적 검사 및 격리 Chrome 검사로 확인합니다. 장면 고치기 한도는 2회입니다. [CLOVA Studio 이미지 요청](https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3) · [Structured Outputs](https://api.ncloud-docs.com/docs/en/clovastudio-chatcompletionsv3-so)

사진은 HCX-005에 `data:image/<형식>;base64,…` 주소(data URL)로 보내고, 이미지 파트를 텍스트 파트보다 앞에 둡니다. 형식은 파일의 첫 바이트로 정합니다(JPEG·PNG·WebP·GIF). 첫 시험은 맨 base64를 보내 39/39가 HTTP 400 / 40001로 끝났습니다(내부 검증 기록).

GPU 서버의 체크아웃(`<gpu-server>/web`, 이 저장소의 `frontend`)에서 Node 22와 앱의 기존 Chrome/Playwright 환경을 사용합니다. 결과 폴더는 아직 없어야 하며, 있으면 실행을 종료합니다. 환경 파일은 값을 열지 않고 `--env-file`로만 넘깁니다.

```sh
cd <gpu-server>/web
NAVIS_PROMO_HCX_PILOT=true node \
  --env-file=.env.local --env-file=.env.development.local \
  server/promo/dev/hcx-pilot.mjs <gpu-server>/promo-hcx-pilot-2
```

실호출 한도는 D-326 Q7에 따라 단계별로 걸립니다. `look`(카페 사진 39장)은 40회(사진마다 첫 호출 1회 + 예비 1회), `scenes`(15초 레퍼런스 6개)는 10회(첫 호출 6회 + 고치기·재시도 4회), 합계 50회입니다. 실패한 호출도 한도에 포함하며, 한 단계의 남은 입력마다 첫 호출 1회는 항상 남겨 둡니다. 스크립트는 `look`과 `scenes`만 실행합니다. 각 장면 중간의 JPEG 프레임을 `screenshots/`에 저장합니다.

`calls.jsonl`은 실제 호출별 모델, 토큰, 시간, 재시도, 고치기와 검사 결과를 기록합니다. `cases.jsonl`은 입력별 결과와 비교 자료의 유무를, `summary.json`은 전체와 단계별 호출 수·토큰을, `parity.md`는 스키마·검사 통과율·고치기·시간(전체와 첫 호출)을 기록합니다. 공급자가 토큰을 반환하지 않은 호출은 `missingCalls`에 집계합니다.

기존 Claude 사진 캐시는 이미지 해시, 메뉴 이름, 스키마 버전 및 모델로 일치 여부를 확인합니다. 비교용 Claude 저장 결과가 있다면 결과 디렉터리 뒤에 JSONL 경로를 추가합니다. 각 줄은 `stage`, `inputSha256`(`inputFingerprint(request)`), `output`(사진 메타데이터 또는 `{ "html": "…" }`), 전 과정의 `latencyMs`, 장면 단계의 `repairs`와 `firstPassed`(첫 응답 검사 통과 여부)를 담습니다. 공급자를 새로 호출하지 않고 저장된 HTML을 같은 검사와 스크린샷 조건으로 비교합니다. 일치하는 결과가 없는 비교 항목에는 `unavailable`을 표시합니다.

장면에는 레퍼런스의 `example-story.json`을 사용합니다. 실제 생성 프롬프트가 같은 레퍼런스의 HTML을 예시로 포함하므로 예시와 완전히 같은 출력은 `exactGalleryHtml`에 표시합니다. 갤러리 예시는 시각 비교 자료이며 Claude 실행 시간과 고치기 횟수는 제공하지 않습니다. 최종 시각 품질은 화면 캡처로 확인합니다.

## 장면 제공자 (PROMO-NEXT, D-327 Q7)

홍보 영상 3단계(장면 HTML)의 생성과 고치기 제공자는 `NAVIS_PROMO_SCENE_PROVIDER`로 고릅니다. 작업·API 계약, 고치기(최대 2회), 정적·Chrome 검사는 모든 장면 제공자에 적용됩니다. 두 번째 시험에서 장면 첫 검사와 최종 검사 통과 건수는 NAVER 1/6·2/6, Claude 6/6·6/6이었습니다(내부 검증 기록).

| 값 | 동작 |
| --- | --- |
| `claude` (기본) | 헤드리스 Claude CLI(`claude -p`), 기준선과 같은 길(`scene-provider.mjs`). 로그인한 구독만 쓰도록 `ANTHROPIC_*`는 자식 프로세스에 넘기지 않고, CLI가 유료 사용량 크레딧을 권하면 그 호출의 답을 버리고 `AI_UNAVAILABLE`로 끝내며 서버를 다시 켤 때까지 더 부르지 않습니다. |
| `naver` | HCX-007 장면 시험(기존 파일럿 경로). Claude 도구가 없어도 작업이 시작됩니다(사진 보기도 NAVER일 때). |
| `claude-api` | 서버용 Claude API 어댑터의 **자리만** 있습니다. W5 견적·승인 전이라 키도 호출도 없고, `NAVIS_PROMO_CLAUDE_API_APPROVED=true`가 없으면 `AI_UNAVAILABLE`(`CLAUDE_API_NOT_APPROVED`), 있어도 어댑터가 없어 `AI_UNAVAILABLE`(`CLAUDE_API_NOT_IMPLEMENTED`)로 끝납니다. |

알 수 없는 값은 `claude`로 읽습니다. 사진 분석이나 장면에 Claude CLI를 선택한 경우 CLI가 필요합니다(없으면 `TOOL_MISSING`).

## 사진 보기만 작게 돌리기 (PROMO-NEXT, D-327 Q8)

같은 GPU 서버 명령 모양에 옵션을 붙이면 한 단계·몇 장·낮은 호출 상한으로만 돕니다. 옵션이 없으면 위의 50회 시험 그대로입니다. 옵션은 호출 전에 검사하고, 틀리면 `PILOT_USAGE`로 끝납니다.

GPU 서버 최종 검증에서 세 장 모두 HCX-005 사진 분석을 통과했습니다(내부 검증 기록). 운영 담당자 승인 후 아래 명령으로 같은 사진 세 장을 확인합니다.

```sh
cd <gpu-server>/web
NAVIS_PROMO_HCX_PILOT=true node \
  --env-file=.env.local --env-file=.env.development.local \
  server/promo/dev/hcx-pilot.mjs <gpu-server>/promo-look-fix-verify-3 \
  --stage=look --photos=cafe-cafe-latte-02,cafe-vanilla-latte-04,cafe-saltbread-05 --max-calls=3
```

`--max-calls`는 그 실행의 실제 호출 상한이고 사진 수 이상이어야 합니다. 사진 수와 같으면 재시도 없이 사진마다 한 번만 부르고, 남는 호출이 있을 때만 재시도합니다. `calls.jsonl`의 `failure`는 응답 글 없이 실패 종류만 담습니다. JSON이 아닌 응답은 바깥 `{…}`만 떼어 검사한 결과를 `>ok`, `>schema:<경로>`, `>none`으로 덧붙입니다(예: `json:fenced>ok`).

HCX-005는 구조화 출력이 없고, “마크다운 금지”를 써도 JSON을 코드 울타리(```` ```json … ``` ````)로 감쌉니다(진단 3/3 `json:fenced>ok`, 두 번째 시험 40/40 실패의 원인). 사진 보기(look)만 응답 전체가 울타리 하나일 때 벗겨서 읽고, 그 호출은 `calls.jsonl`에 `parse: "fenced"`로 남습니다. 울타리가 닫히지 않았거나 뒤에 글이 붙으면 그대로 실패입니다. 스키마 검사는 그대로입니다. 대본·장면 단계는 구조화 출력이라 엄격한 읽기를 유지합니다.

울타리를 벗긴 뒤에도 `captionHints`(글머리 아이디어)가 스키마 한도(60자)를 넘는 일이 있었습니다(검증 3회 중 2회, `$.captionHints[n]: maxLength`). 사진 보기는 한도를 넘는 아이디어만 버리고 `calls.jsonl`의 `hintsDropped`에 개수를 기록합니다.

두 번째 검증에서는 `cafe-cafe-latte-02`의 `items` 두 항목이 각각 40자를 넘어 실패했습니다. 대본 프롬프트에는 사진의 `kind`·`amount`·`menuShown`이 들어가고, 문구와 사진이 맞는지 검사할 때는 `amount`·`menuShown`과 카탈로그 메뉴 이름을 씁니다. 장면 생성과 수정 프롬프트에는 사진 ID·크기·`focus`와 완성된 대본의 문구가 들어갑니다. UI에는 카탈로그 사진과 작업 진행 상태·결과가 표시됩니다. `items`·`flavors`는 사진 메타데이터 캐시에만 보관됩니다. 캐시 키는 사진 SHA-256, 스키마 버전, 메뉴 이름 해시, 모델로 구성됩니다.

HCX-005 사진 보기는 `items`·`flavors`의 배열 개수 제한(각각 8개·6개)을 적용한 뒤 40자를 넘는 문자열만 버립니다. `calls.jsonl`의 `itemsTrimmed`·`flavorsTrimmed`에는 버린 개수를 각각 기록합니다. 결과는 캐시에 쓰기 전에 원래 스키마로 검사하며, 배열 원소 타입과 `subject` 등 다른 필드의 제약도 검사합니다.

## Claude 비교 기준선 (PROMO-RETRY, D-326 Q8)

NAVER 호출과 같은 장면 입력 6개를 Claude로 1회씩 실행해 같은 검사로 비교합니다. NAVER 호출이나 앱 연결은 없습니다. 장면마다 `claude -p`를 한 번만 부르고 고치기는 하지 않습니다. 프롬프트와 스키마는 NAVER 첫 호출과 같고(입력 SHA-256이 같음), 정확한 모델 ID·지연·토큰과 첫 검사 결과를 기록합니다. 구독 로그인만 쓰도록 `ANTHROPIC_*` 환경 변수는 자식 프로세스에 넘기지 않으며, CLI가 유료 사용량 크레딧을 권하면 즉시 멈춥니다(종료 코드 2).

```sh
cd frontend
node server/promo/dev/claude-baseline.mjs ../verification/promo-hcx-pilot-2/claude-baseline.jsonl
node server/promo/dev/hcx-compare.mjs ../verification/promo-hcx-pilot-2 ../verification/promo-hcx-pilot-2/claude-baseline.jsonl
```

두 번째 명령은 저장된 HTML에 같은 정적·브라우저 검사와 스크린샷 조건을 적용해 `cases.jsonl`, `summary.json`, `parity.md`를 다시 만듭니다(NAVER만의 표는 `parity.naver-only.md`로 남습니다). 공급자는 부르지 않습니다.
