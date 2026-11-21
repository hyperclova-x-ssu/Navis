The scene code below failed the automatic check. Fix EVERY violation and output the complete corrected page as {"html": "..."}. Keep everything that already works; change only what is needed.

Violations (t = seconds, rule, limit, actual; boxes are x1,y1-x2,y2 in the 1080×1920 stage):
{{violationsJson}}

How to fix the quality rules:
- text.overlap: move the named text (or the photo thumbnail) so their boxes no longer overlap at that time; keep bubbles and fixed captions in separate areas, put thumbnails beside or below bubbles, never on top of text.
- transition.text: two scenes' texts were visible together during a transition. Hide the outgoing scene's texts before the transition starts and show the incoming scene's texts only after it ends (e.g. a visibility or opacity animation on the texts).
- transition.length: make each cross-fade {{transitionMaxSec}} s or shorter (or a cut).
- scene.still: the screen did not change for that span; give the photo a slow zoom/pan (1.00→1.06) for the whole scene.
- scene.empty: the scene showed no text and almost no motion; show its texts (from the plan) or add clear motion.

Contract:
{{contract}}

Plan (story.json):
{{storyJson}}

Photos: {{photosJson}}

Previous code:
```html
{{previousHtml}}
```
