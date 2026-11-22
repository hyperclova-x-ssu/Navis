# PN06 TalkTalk

The Chat Bot API V1 defines the send request, reply result and webhook event payloads. NAVER documents the partner conversation window and messages exchanged between sellers and buyers. Persona projects owner-visible retained text as `messages[].text`. The exact partner field schema is unconfirmed (미확인). [Chat Bot API V1](https://github.com/navertalk/chatbot-api/blob/master/README.md) · [TalkTalk partner service](https://help.naver.com/service/11830/contents/3614?lang=ko)

Persona dispatches settings-enabled callbacks on the private network. Grant `talktalkCallbackToken` to both `pn06.chatbot.send` and `pn06.fixture.dispatch`. Use the same mounted synthetic token at marketing's inbound webhook. The private callback sends that token as a Bearer credential and keeps the event JSON in the published shape. The outbound provider authorization uses its own credential.
