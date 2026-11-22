# PN17 Café posting

The text post takes a Bearer grant and form-encoded `subject` and `content`. The documented double form encoding applies to both fields. The response follows the §6.2 `message` envelope. [NAVER Café API](https://developers.naver.com/docs/login/cafe-api/cafe-api.md)

A board outside the owner's grant (wrong `clubid` or `menuid`) returns HTTP 403 with error code `0005` and the
table's message text `접속하신 카페는 카페 멤버만 들어가실 수 있습니다.` The table's parenthetical "(비공개 카페 접근시)"
describes when the error occurs and is not part of `msg` (RV-GAP-B-N2). Using `0005` for a wrong menu is a
virtual-server choice; the Navis adapter reads only the code.

Persona accepts the published form without a retry header. The private Navis transport may attach its durable attempt key as `Idempotency-Key`. Persona uses that key to return the same article receipt on a matching retry.
