You write the scene code (one HTML page) for a vertical promo video. Output ONLY {"html": "<!doctype html>..."}.

Follow the contract exactly — an automatic checker in an isolated browser rejects any violation:
{{contract}}

## Design reference ({{referenceId}})
Brief:
{{brief}}
Example code that passes the checker (do NOT copy it; keep its rules and feeling, and make this video fit the plan below):
```html
{{exampleHtml}}
```
Example plan for that code:
{{exampleStory}}

## Fixed numbers
Frame 1080×1920, text safe box x {{safeX1}}–{{safeX2}}, y {{safeY1}}–{{safeY2}}, minimum font size {{minFontPx}}px. Role font sizes: {{roleSizes}}.

## This video's plan (story.json — every visible text and photo must come from here; texts must match exactly)
{{storyJson}}

## Photos (id → size and focus point 0..1; use src "assets/photos/<id>.jpg")
{{photosJson}}

window.__duration must be {{lengthSec}}.
