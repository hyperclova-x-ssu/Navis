# Account service

Account owns the synthetic café identity, store memberships, access JWTs and refresh sessions. Run migrations and seeding through the backend tools container with `npm run migrate -- account` and `npm run seed -- account`. Readiness checks the migrated account DB using its runtime role. Café identifiers come from the SPA-date generator input. The synthetic comparison store `33123a19-6780-4d38-9bca-ce96efcf8559` matches inventory's comparison fixture.

## Gateway contract for T-305

Use `NAVIS_ACCOUNT_URL` and send `Authorization: Bearer <workload token>` to each route below. Read the token from `NAVIS_GATEWAY_ACCOUNT_TOKEN_FILE`. Forward the edge's `X-Request-Id`. Use the verified JWT payload for the internal authorization body and replace any client-supplied internal headers. Keep `/internal/v1/auth/*` private to the workload network.

| Route | Request | Success |
| --- | --- | --- |
| `GET /internal/v1/auth/jwks` | Workload credential | `200 { keys: [...] }` with public P-256 JWKs. Each key has `kty`, `crv`, `x`, `y`, `kid`, `alg` and `use`. |
| `POST /internal/v1/auth/authorize` | Workload credential and JSON `{ sid, sub, store_id, role }` from the verified JWT | `204` with an empty body. Check this on every protected request. |
| `POST /api/v1/auth/demo` | Workload credential and original browser `Host` and `Origin`. Empty body. | `200 { accessToken, expiresIn, storeId }` and a refresh cookie. |
| `POST /api/v1/auth/refresh` | Same headers as demo, plus the original `Cookie`. Empty body. | Same body as demo and a replacement refresh cookie. |

JWT verification uses ES256 only, issuer `navis-account`, audience `navis-api` and the JWK matching the protected `kid`. Require `sub`, `sid` and `store_id` as UUIDs, `role` as `owner` or `staff`, and integer `iat` and `exp`. The gateway permits five seconds of clock skew when checking issuance and expiration, with a maximum signed lifetime of 600 seconds. Accept only the account service's current `204` decision for authorization and fail closed on upstream errors or timeouts. The gateway also checks the required store and role.

Account returns `400 INVALID_REQUEST` for malformed authorization bodies, `401 UNAUTHENTICATED` for missing or invalid workload credentials, invalid refreshes, and missing, expired or revoked sessions, `403 STORE_FORBIDDEN` for a wrong browser Host or Origin or a role that disagrees with current membership, and `503 SERVICE_UNAVAILABLE` for DB failures. The gateway maps access JWT expiration to `401 TOKEN_EXPIRED` and upstream outages to `503 SERVICE_UNAVAILABLE`. Error bodies have shape `{ code }`. Account sets `Cache-Control: no-store`.

## Browser integration

Enable demo issuance locally with `NAVIS_BACKEND_DEMO_AUTH=1`. The demo route otherwise returns `404` because it is absent. The loopback demo and refresh calls require `Host: 127.0.0.1:18180` and `Origin: http://127.0.0.1:18180`. Pass the account service's `Set-Cookie`, cache control and status through the gateway. The browser keeps the access token in memory and sends it as a bearer. The `navis_refresh` cookie is host-only, `HttpOnly`, `SameSite=Strict` and scoped to `/api/v1/auth`. It has `Secure` on HTTPS and uses the loopback HTTP exception locally. `NAVIS_ACCOUNT_PUBLIC_ORIGIN` optionally configures an HTTPS origin at account startup. Demo issuance remains local to the default loopback origin.

Serialize refreshes and retry a read that returns `TOKEN_EXPIRED` once after refresh succeeds. Each refresh consumes its old credential and leaves the original eight-hour absolute expiry in place. Reuse revokes the session family and its access tokens on the next authorization. A committed membership deletion removes its session and refresh rows through composite foreign keys. Rejoining permits a new session.

Real login will require cross-tab refresh coordination. An origin-scoped lock must cover the refresh request through completion so the next tab sends the browser's latest cookie. This preserves immediate revocation for actual reuse and keeps refresh credentials hash-only on the server. The demo continues to coordinate within each tab, and sending the same consumed credential twice revokes the family.

## Signer and rollover

Account reads the mounted `NAVIS_ACCOUNT_SIGNING_KEY_FILE` at startup. The local secret generator supplies a single P-256 private PEM. For rollover the mounted file may instead be a JSON object with `activePkcs8` (the active PEM) and `publicKeys` (additional public P-256 JWKs). Each `kid` is the public JWK's SHA-256 thumbprint.

Each gateway instance caches the public JWKS for 30 seconds and refreshes on an unknown `kid`. Concurrent misses share a single fetch. Every protected request still checks current authorization with account.

1. Reload account with the current signer and the replacement public JWK in `publicKeys`. Confirm the gateway can verify with the published replacement.
2. Reload account with the replacement signer and the retiring public JWK still in `publicKeys`.
3. Keep publishing the retiring verifier through the last old access token's expiration and the clock tolerance. Allow 605 seconds from the last time any account instance signed with it before removing it.
