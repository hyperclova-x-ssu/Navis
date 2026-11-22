# PN08 SmartCall and AiCall

The partner-assumed SmartCall view projects the assigned 050 virtual number, aggregate channels and daily call statistics. The owner help documents the virtual number and call analytics. [050 number](https://help.naver.com/service/30026/contents/20471) · [Analytics](https://help.naver.com/service/30026/contents/20474)

The internal `POST /internal/naver-virtual/v1/aicall/fixture/dispatch` command accepts an empty request. The `pn08.fixture.dispatch` grant is restricted to internal fixture and test workloads. The configured private `NAVIS_NAVER_VIRTUAL_AICALL_CALLBACK_URL` uses the production callback allowlist. The grant maps `providerCredentialFiles["pn08.fixture.dispatch"].aicallCallbackToken` to a separate synthetic bearer file shared with the Customer callback authenticator.

The fixture sends the documented Custom Condition V2.0 POST envelope of `userId`, `userKey` and `userVariables`. The configured example uses the four reservation date, time, party-size and phone variables encoded as string values with `typ`; the date JSON includes `name`. Customer may acknowledge the fixture only with `reservationFailed` while the candidate awaits owner review. [Custom Condition V2.0](https://guide.ncloud-docs.com/docs/chatbot-chatbot-2-3) · [AiCall scenario](https://guide.ncloud-docs.com/docs/clovaaicall-aicall-1-9)

The private account and seed generation identify the synthetic call. The dispatch claims it durably before delivery and replies 204 after acknowledgement. A duplicate of an acknowledged call returns 204. An in-flight or ambiguous delivery returns 202 without another delivery. The command has no timer, public gateway route, or booking mutation.

The AiCall fixture sends `Authorization: Bearer` solely for Navis authentication on
the private persona network. The [Custom Condition V2.0 reference](https://guide.ncloud-docs.com/docs/chatbot-chatbot-2-3)
documents the callback body and response. Live AiCall caller authentication is
미확인. A live receiver needs independently verified authentication.
