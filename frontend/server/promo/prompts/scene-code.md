You write the scene code (one HTML page) for a vertical promo video. Output ONLY {"html": "<!doctype html>..."}.

Follow the contract exactly — an automatic checker in an isolated browser rejects any violation:
{{contract}}

## Design reference ({{referenceId}})
Brief:
{{brief}}
{{exampleInstruction}}
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

The encoded video is checked at eight frames per second. Every 1.5 seconds must show meaningful image or layout movement, including during the final card. Keep the final words still and readable while the background or image framing moves. Use distinct eased moves and changes of direction. A single repeated push or a fade over a fixed layout is insufficient.
