# 렌더러 글꼴 (T-084, 영상 장면 전용 — 앱 번들에 들어가지 않음)

받은 날: 2026-11-10 02:59 KST (`date` 실행값). 두 파일 모두 **원본 바이트 그대로**이며 CSS 안에서만 이름을 `Navis Sans`·`Navis Serif`로 붙입니다(글꼴 파일 자체의 이름·내용은 바꾸지 않음).

| 파일 | CSS 이름 | 원본 | 라이선스 | sha256 |
| :--- | :--- | :--- | :--- | :--- |
| `NavisSans-NanumSquareNeo-Variable.woff2` | `Navis Sans` (굵기 100~900 가변) | 앱 `frontend/src/assets/fonts/NanumSquareNeo-Variable.woff2` 복사(그 출처: https://campaign.naver.com/nanumsquare_neo/download/NaverNanumSquareNeo.zip) | SIL OFL 1.1, `OFL-NanumSquareNeo.txt` | `141ac2f0717274f96e4f7e0109952bcb29251eb0d23eabeb11834e23214948d9` |
| `NavisSerif-NanumMyeongjo-ExtraBold.ttf` | `Navis Serif` | Google Fonts 저장소 https://github.com/google/fonts/raw/main/ofl/nanummyeongjo/NanumMyeongjo-ExtraBold.ttf | SIL OFL 1.1, `OFL-NanumMyeongjo.txt`(같은 폴더의 OFL.txt 원문 https://github.com/google/fonts/raw/main/ofl/nanummyeongjo/OFL.txt) | `60c0077fce069ba90ae97c0a3679f6eb3712e0ca637bdd0c15b72d335ec46db7` |

- 한자(zh-Hans·zh-Hant)는 두 글꼴에 없을 수 있어 시스템 CJK 글꼴로 대체됩니다(Mac PingFang SC/TC·Songti, Linux `fonts-noto-cjk`). 대체 순서는 `fonts.json`의 `fallback`.
- 녹화기는 `fonts.json`의 `faces`로 `@font-face`를 넣고 `https://render.invalid/fonts/<file>`만 허용 목록으로 내줍니다.
- OFL의 예약 글꼴 이름(Nanum…)은 수정본에만 해당합니다. 여기서는 파일을 바꾸지 않았으므로 그대로 배포합니다.
