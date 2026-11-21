# 장면 코드 계약 (scene contract v2)

이 문서는 영상 장면 코드를 쓰는 Claude에게 그대로 주는 계약입니다. 기준: ARCHITECTURE 12.8·12.9, PROMO_TEMPLATES [고정] 값(`rules.json`). 이 계약을 어기면 자동 검사가 위반 목록을 돌려주고, 앞 코드와 위반 목록을 보고 고쳐야 합니다(최대 2번).

## 1. 출력 모양

- 출력은 JSON `{"html": "<!doctype html>..."}` 하나입니다. 한 장짜리 HTML이며 CSS는 `<style>`, JS는 인라인 `<script>`만 씁니다. **64KB(65,536바이트) 이하**.
- 무대는 `<div id="stage">` 하나이고 **정확히 1080×1920 CSS px**(디자인 단위)입니다. `body{margin:0}`, `#stage{position:relative;width:1080px;height:1920px;overflow:hidden}`. `vw`·`vh`·`%`로 창 크기에 맞추지 말고, 창 크기를 읽지 마세요. 녹화기가 720×1280(갤러리는 360×640)으로 줄여 찍습니다.
- 자산 주소
  - 사진: `assets/photos/<photoId>.jpg` — 장면 구성(`story.json`)에 있는 사진 id와 외관 `store-exterior`만.
  - 글꼴: 이름으로만. 고딕 `font-family: "Navis Sans", sans-serif`(한글 전체, 굵기 100~900), 명조 `font-family: "Navis Serif", serif`(가게 이름 등). `@font-face`는 녹화기가 넣으니 쓰지 마세요. 손글씨 느낌은 `Navis Sans` 700 + 종이 카드 모양으로 냅니다.
  - 그 밖의 주소(`http:`·`https:`·`//`·`data:`·`blob:`·`file:`)는 쓰지 않습니다. 아이콘·장식은 CSS 도형이나 인라인 `<svg>`로 그립니다.
- 사진 크기·초점은 입력으로 받습니다. `object-fit: cover`와 `object-position`(초점)으로 자르세요.

## 2. 검사용 표시 (필수)

| 표시 | 어디에 | 규칙 |
| :--- | :--- | :--- |
| `data-scene="<sceneId>"` | 장면마다 맨 바깥 요소 하나 | 장면 구성의 모든 장면 id가 있어야 합니다(`s1`, `s2` …). 장면 요소끼리 중첩하지 않습니다 |
| `data-photo="<photoId>"` | 사진 `<img>` 또는 사진을 배경으로 쓰는 요소 | 그 사진이 나오는 장면 안에 둡니다 |
| `data-text="<textId>"` | 글자를 담는 요소 | 요소의 글자(공백 정규화)가 장면 구성의 그 글자와 **정확히 같아야** 합니다. `data-text` 요소 안에 다른 `data-text`를 넣지 않습니다. 안쪽 강조용 `<b>`·`<span>`(표시 없음)은 됩니다 |
| `data-text="store-name"`·`data-text="store-location"` | 엔딩의 가게 이름·위치 | 입력의 가게 이름·위치를 **한 글자도 바꾸지 않고** 씁니다(번역·줄임 금지) |

- 장면 구성에 없는 글자는 화면에 쓰지 않습니다. 장식 기호·숫자·시각·이름표도 장면 구성에 적힌 것만 씁니다. 줄바꿈은 `\n`이 들어간 자리에서 `<br>`로 바꿉니다(그 밖에는 자동 줄바꿈).
- 여러 장면에 걸쳐 남는 글자(예: 고정 자막, 밀려 올라가는 말풍선)는 장면 요소 밖에 두어도 됩니다. 그때 그 글자의 `sceneIds`에 **보이는 동안의 모든 장면**이 있어야 합니다.

## 3. 시간 지정 재생

- `window.__duration = <고른 길이(초)>;` 를 스크립트 맨 앞에서 정합니다. 녹화기는 정확히 `round(L×30)` 프레임을 찍습니다.
- 모든 움직임은 **CSS `@keyframes` 애니메이션(필요하면 `animation-delay`) 또는 `element.animate()`(Web Animations)**로 만들고, **처음 불러올 때 모두 만듭니다**. 나중에 클래스를 붙여 새 애니메이션·트랜지션을 만들지 마세요. 녹화기는 매 프레임 `document.getAnimations()`의 모든 애니메이션을 멈추고 `currentTime = t×1000`으로 맞춥니다. 그래서 애니메이션 시간은 0초(페이지 시작)가 영상 0초입니다. `fill`은 `both`(또는 CSS `animation-fill-mode: both`)로 두세요.
- 한 요소의 보임·숨김은 영상 전체 길이(`L×1000`ms)의 애니메이션 하나에 `offset`으로 시각을 적어 만드는 방법을 권장합니다.
- 글자 바꾸기처럼 CSS 속성이 아닌 변화는 `window.__onFrame = (t) => { ... }`에서 **t만으로** DOM을 정합니다(같은 t면 같은 화면, 앞 프레임 상태에 기대지 않음). 녹화기는 애니메이션을 맞추기 전에 이것을 부릅니다. 가능하면 숫자마다 요소를 따로 두고 opacity 애니메이션으로 바꾸는 쪽을 쓰세요.
- `<canvas>` 2D는 `__onFrame` 안에서 그릴 때만 씁니다.
- 마지막 0.6초 어두워짐과 음악은 녹화기가 넣습니다. 장면 코드는 어두워짐을 따로 만들지 않습니다.

### 3.1 전환·움직임·겹침 (v2, T-087)

- **전환 길이**: 장면 바꿈은 컷이거나 **0.4초 이하**의 크로스페이드입니다. 이웃 두 장면이 함께 보이면서 한쪽이 반투명한 시간이 0.4초를 넘으면 위반(`transition.length`)입니다.
- **전환 중 글자는 한 장면 것만**: 나가는 장면의 글자는 전환이 시작되기 전에 숨기고, 들어오는 장면의 글자는 전환이 끝난 뒤에 보이게 합니다. 사진은 서로 섞여도 되지만 두 장면의 글자가 같은 순간에 함께 보이면 위반(`transition.text`)입니다(여러 장면에 걸친 글자는 `sceneIds`가 겹치므로 예외). 글자 요소에 `visibility`(또는 `opacity`) 애니메이션을 하나 더 두는 방법을 권장합니다.
  ```js
  // 장면 [a, b], 전환이 경계 앞 pre초·뒤 post초에 걸칠 때: 그 장면 글자는 a+post ~ b-pre 동안만 보임
  el.animate([{ offset: 0, visibility: 'hidden' }, { offset: (a + post) / L, visibility: 'hidden' }, { offset: (a + post) / L, visibility: 'visible' },
    { offset: (b - pre) / L, visibility: 'visible' }, { offset: (b - pre) / L, visibility: 'hidden' }, { offset: 1, visibility: 'hidden' }], { duration: L * 1000, fill: 'both' });
  ```
- **글자 겹침 금지**: 보이는 글자끼리 줄 상자가 15% 이상 겹치거나, 사진(`data-photo`, 화면 전체를 덮는 배경 사진은 제외)이 글자 위에 올라와 글자의 15% 이상을 가리면 위반(`text.overlap`)입니다. 말풍선·고정 자막·사진 썸네일은 서로 다른 자리에 둡니다. 밀려 올라가는 말풍선은 위 말풍선이 다 올라간 뒤 다음 것이 들어오게 합니다.
- **멈춘 화면 금지**: 화면(보이는 요소의 위치·크기·불투명도·글자)이 **1.5초 이상** 그대로이면 위반(`scene.still`)입니다(마지막 엔딩 장면은 예외). 사진은 장면 내내 천천히 확대·이동(예: 1.00→1.06)하게 두세요.
- **빈 장면 금지**: 엔딩이 아닌 장면은 장면 시간 동안 글자가 하나 이상 보여야 합니다. 글자가 없는 장면(장면 구성에서 1.5초 이하 짧은 시작 장면만 허용)은 사진·요소가 24px 이상 움직여야 합니다(`scene.empty`).

**금지 API**(쓰면 실행되지 않고 위반으로 보고됨): `setTimeout`·`setInterval`·`requestAnimationFrame`·`requestIdleCallback`, `Date`·`performance.now`, `Math.random`, `fetch`·`XMLHttpRequest`·`WebSocket`·`EventSource`·`navigator.sendBeacon`, `import()`·`eval`·`new Function`, `Worker`·`SharedWorker`·`ServiceWorker`, `RTCPeerConnection`, `localStorage`·`sessionStorage`·`indexedDB`·`document.cookie`, `window.open`·`location` 변경·`<form>` 제출, 태그 `<iframe>`·`<video>`·`<audio>`·`<object>`·`<embed>`·`<link>`·`<script src>`·`<base>`·`<meta http-equiv>`. 무작위가 필요하면 고정된 숫자 표를 코드에 적어 씁니다.

## 4. 자동 검사가 보는 것 (`rules.json` 값)

1. 정적: 크기 ≤ 64KB, 금지 API·태그·외부 주소, 모든 장면 id의 `data-scene`.
2. 실행: 페이지 오류·콘솔 오류 없음, 금지 API 기록 없음, 막힌 요청 없음, `__duration` = L(±0.05), 불러오기·글꼴 준비 10초 안, 프레임 하나 맞추기 500ms 안.
3. 0.25초마다 + 장면 경계 앞뒤(±0.05초)에서:
   - **안전 영역**: 보이는 글자는 모두 x 60~1020, y 120~1620 안(아래 300은 Reels·클립·쇼츠 버튼 자리). 사진·배경은 화면 전체를 채워도 됩니다.
   - **글자 크기** ≥ 36px(계산된 `font-size`), 글자를 담는 요소가 넘치지 않음(`scrollWidth`·`scrollHeight`가 상자보다 크지 않음 — 고정 폭 상자에 `white-space:nowrap`을 쓰면 넘침이 됩니다).
   - **선언된 글자만**: 보이는 글자는 모두 `data-text` 안에 있고 그 문장이 장면 구성과 같음.
   - **짝 맞춤**: 보이는 사진·글자는 자기가 속한 장면(가장 가까운 `data-scene`, 없으면 그 시점에 가장 잘 보이는 장면)의 장면 구성에 있는 것. 자막은 그 장면 사진에 실제로 보이는 것만 말합니다(초코 사진 위에 “피스타치오” 금지).
   - **장면 시간**: 장면이 가장 잘 보이는 구간이 장면 구성의 `start`~`start+duration`과 ±0.3초 안.
   - **사진**: 고른 사진·외관만, 같은 사진은 최대 2장면, 이웃 장면에서 반복 금지(외관은 예외).
   - **겹침**(v2): 글자끼리·사진이 글자를 가림 15% 미만(`text.overlap`, actual에 시각과 상자 위치 `x1,y1-x2,y2`).
   - **전환**(v2): 장면 경계 앞뒤 0.6초를 0.05초 간격으로 봐서 크로스페이드 0.4초 이하(`transition.length`), 모든 검사 시점에서 두 장면 글자가 함께 보이지 않음(`transition.text`).
   - **움직임**(v2): 1.5초 넘게 같은 화면 없음(`scene.still`, 엔딩 제외), 글자도 움직임도 없는 장면 없음(`scene.empty`).
4. 엔딩: 끝나기 1.0초 전에 `store-name`·`store-location`이 보이고 문장이 입력과 똑같고, 위치가 2줄 이하(가장 긴 위치 24자도 2줄 안에 들어가게 폭 960·`sub` 48px 기준으로 상자를 잡으세요).
5. 녹화 뒤: 길이·해상도, 번쩍임(밝기 평균의 큰 변화가 초당 3회 초과 금지). 깜빡임·반복 점멸·흰 화면 번쩍임을 만들지 마세요.

위반 한 줄 모양: `{t, sceneId, textId|photoId, rule, limit, actual}`. `rule` 값: `static.size`·`static.forbidden`·`static.url`·`runtime.error`·`runtime.forbiddenApi`·`runtime.blockedRequest`·`runtime.duration`·`runtime.timeout`·`text.safeArea`·`text.minSize`·`text.overflow`·`text.undeclared`·`pair.photo`·`pair.text`·`timing.scene`·`photo.reuse`·`ending.missing`·`ending.mismatch`·`video.flash`·`video.duration`, v2에서 더함: `text.overlap`·`transition.text`·`transition.length`·`scene.still`·`scene.empty`.

## 5. 디자인 기준

- 레퍼런스의 `brief.md`가 느낌·구성·[고정] 순서를 정합니다. `example.html`은 이 계약과 검사를 통과한 예시입니다. **그대로 베끼지 말고 규칙과 느낌만 지키며** 입력(분위기·컨셉·메모·사진)에 맞춰 매번 새로 쓰세요.
- 사진 위 글자는 불투명 띠·어두운 면(검정 55%) 위에 두거나, 레퍼런스가 정한 윤곽 글자(흰 글자 + 검은 윤곽 8 + 그림자)를 씁니다. 대비 4.5:1 이상.
- 사진 움직임은 확대 1.00→1.12 이하·이동 6% 이하(가로 훑기는 18% 이하). 장면 전환은 레퍼런스가 정한 페이드(0·120·150·300·400ms, **최대 400ms**).
- 이모지·리뷰 작성자 이름·손님 말 따옴표 인용·쿠폰 코드·전화번호·계정 이름·특정 메신저·SNS 이름과 로고·네이버 표기를 쓰지 않습니다.
