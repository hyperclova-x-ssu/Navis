# server/promo/references — AI 홍보 영상 디자인 레퍼런스 (T-084·T-085)

Claude가 영상마다 장면 코드를 새로 쓸 때 주는 입력과, 생성 코드를 검사하는 규칙입니다. 기준: ARCHITECTURE 12.8·12.9, DATA_MODEL 10.16.5, PROMO_TEMPLATES(R4).

| 경로 | 내용 | 소유 |
| :--- | :--- | :--- |
| `contract/scene-contract.md` | Claude에게 그대로 주는 장면 코드 계약 | T-084 |
| `rules.json` | PROMO_TEMPLATES [고정] 값(프레임·안전 영역·글자 역할별 한도·길이별 장면 수·사진 재사용·금지 낱말·번쩍임). 글자 검사기·장면 검사기가 함께 읽음 | T-084 |
| `fonts/` | 렌더러 글꼴 `Navis Sans`(NanumSquare Neo)·`Navis Serif`(Nanum Myeongjo ExtraBold), `fonts.json`(녹화기가 넣을 @font-face), 라이선스·출처 | T-084 |
| `tools/` | 예시 검사(`check-example.mjs`), 갤러리 렌더(`render-gallery.mjs`), 같은 규약의 최소 녹화기·검사기(`lib/`), 시험 | T-084 |
| `ref-1`~`ref-3/` | `brief.md`·`meta.json`·`example.html`·`example-story.json`·`poster.jpg`·`preview.mp4` (ref-1은 `SOURCE.md`) | T-084 |
| `ref-4`~`ref-6/` | 같은 형식 | T-085 |

## 명령 (frontend에서)
```sh
node server/promo/references/tools/check-example.mjs ref-1 ref-2 ref-3   # 글자 검사 + 정적 검사 + 장면 검사 (위반 0이어야 함)
node server/promo/references/tools/render-gallery.mjs ref-1 ref-2 ref-3  # poster.jpg + preview.mp4 (같은 실행)
node server/promo/references/tools/render-gallery.mjs ref-1 --full <폴더> # + 15초 mp4(음원·끝 0.6초 어두워짐)와 프레임 3장 (확인용)
node --test server/promo/references/tools/*.test.mjs                    # 시험 (Chrome·ffmpeg 없으면 해당 시험 건너뜀)
```
- 예시 코드를 고치면 `check-example` → `render-gallery` 순서로 다시 돌립니다. 갤러리 파일은 미리 만들어 두는 파일이며 사장님 요청 때 렌더하지 않습니다.
- 도구 탐지: Chrome `NAVIS_CHROME_PATH` → Mac·Linux 기본 위치, ffmpeg `NAVIS_FFMPEG_PATH` → PATH → `/opt/homebrew/bin` …, playwright-core는 앱 devDependency(T-082).
- 예시 글자는 한국어만(D-83). `rules.json`의 4개 언어 한도 구조는 그대로 둡니다.

## 예시 장면 구성 규약 (T-082 검사기와 같음)
- 장면 밖에 둔 `data-text`·`data-photo`(고정 자막·밀려 올라가는 말풍선 등)는 그 시점에 가장 잘 보이는 장면(`data-scene` 실효 불투명도가 가장 큰 것)과 짝을 맞춥니다. 그래서 그런 글자의 `sceneIds`에는 보이는 동안의 모든 장면이 들어갑니다.
- 외관 `store-exterior`는 사진 재사용 규칙의 예외입니다(ref-1이 3장면에서 씀).
- `rules.json`의 `minSceneSecByRefSkipFirst: ["ref-3"]`: ref-3의 2.5초 최소 장면 시간은 시작 외관 장면(PROMO_TEMPLATES 2.3 표의 1~2초)에는 적용하지 않습니다.
- 장면 수는 `meta.json`의 `lengths.<L>.sceneCount`가 있으면 그것이 `rules.json`의 일반 범위보다 우선합니다. ref-1은 사용자 레퍼런스의 [고정] 5단계 순서라 30초도 5장면입니다(PROMO_TEMPLATES 3절 표 5/5/5, 일반 범위 30초 6~14와 다름).
- 미리보기 구간은 PROMO_TEMPLATES 8절 구간을 장면 전환 페이드 바깥으로 0.1~0.3초 옮긴 값입니다(ref-1 2.1~6.9, ref-2 2.7~7.0, ref-3 1.8~5.7). 8절 공통 규칙(반복 지점은 전환 직전·직후, 시작 프레임이 전환 중이면 반복 때 튐)을 지키기 위해서입니다.
