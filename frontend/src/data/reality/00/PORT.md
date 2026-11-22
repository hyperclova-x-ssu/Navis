# F00 data port (REAL-PLAN D-344) — contract for F01/F02 and later Fnn

Types: `port.ts` (this folder). Status: **implemented** — `transport.ts` (session + request + reads), `real-port.ts` (loads, commands, receipts, undo, reconcile), `files.ts`, `registry.ts`, `autoload.ts`, `app-port.ts`, `testing.ts` (this folder); store hooks in `src/data/db/store.ts` and `src/data/react.tsx`. 88 tests across this folder and `backend-catalog`.
Backend counterpart for the request/receipt/error shapes: `.evidence/real/B01-menu-dto.md` (B01) and the rules in `03_architecture/REAL_PLAN.md` "Shared contracts and cutover".

## 1. What you build, what F00 gives you

You (Fnn) own `src/data/reality/nn/**`. Add exactly one module there: **`src/data/reality/nn/register.ts`**. It is picked up by an eager glob in
`src/data/reality/00/registry.ts`, so cutting your pair over needs no edit of any shared file:

```ts
// src/data/reality/01/register.ts
import { registerDomain } from '../00';
import { menuAdapter } from './adapter';
registerDomain(menuAdapter);
```

A `DomainAdapter` has three parts: `tables` (which `DataTables` keys it fills), `load()` (HTTP → table rows), `commands` (command name → request).
Selectors, widgets, Navis `WidgetFactSource` and `projectAgent*` keep reading the **`DataSnapshot`**, so nothing downstream changes.

## 2. Source mode (fixture vs http), per domain

| Build / env | Result |
| --- | --- |
| `VITE_NAVIS_DATA_SOURCE` unset or `fixture` | every domain is `fixture` (seed + local store; what all current tests use) |
| `VITE_NAVIS_DATA_SOURCE=http` | every domain **with a registered adapter** is `http`; the rest stay `fixture` |
| `+ VITE_NAVIS_FIXTURE_DOMAINS=menu,pos` | listed domains stay `fixture` (isolated demo reset, a pair not yet verified) |

Tests pick a mode explicitly: `createRealPort({ source: d => 'http', fetch: fakeFetch, adapters: [menuAdapter] })`, no env stubbing needed.
`import.meta.env` is read once in `dataSourceFor(domain)`; do not read it elsewhere.

## 3. HTTP request helper

`port.transport.request<T>(req)` — session, bearer, one TOKEN_EXPIRED refresh (cross-tab lock), `no-store`, `PortError` on failure.

```ts
// GET with filters (cursor/limit are query inputs):
await port.reads.page<Menu>({ resource: 'menu', path: '/inventory/menu', query: { category: 'drink', limit: 50 } });
// → GET /api/v1/stores/{storeId}/inventory/menu?category=drink&limit=50
//   body: { items: Menu[], nextCursor: string|null, asOf: ISO, sourceRevision: number }

// Command: the port adds Idempotency-Key and merges expectedRevision into the JSON body.
{ method: 'PATCH', path: `/inventory/menu/${id}`, body: { price: 4200 }, expectedRevision: 1 }
// → PATCH …/inventory/menu/{id}   Idempotency-Key: <uuid>   {"price":4200,"expectedRevision":1}
//   200 {"resourceId":"…","revision":2,"receiptId":"…","undoUntil":"…","affectedSources":["menu","pos"],"changed":true}
```

Errors map to `PortError {status, code, reason?, field?, details?, outcomeUnknown}`; the command result carries `reason`, `field`, `details` (sanitized plain JSON from the server: depth ≤ 3, ≤ 40 values, strings ≤ 200 chars, no personal data — the server sends masked values only) and `outcomeUnknown: true`. `409 STALE_REVISION` → the port re-reads and the command resolves
`{ok:false, code:'CONFLICT', reason:'STALE_REVISION'}`; the owner presses a refreshed card. `400 VALIDATION` →
`{ok:false, code:'VALIDATION', field, reason}`. `403 STORE_FORBIDDEN`/`401` → session ends (`SESSION_ENDED`). Network/timeout/5xx after send → `outcomeUnknown`:
the port resends the **same** key until the server returns the stored receipt; it never creates a second record. Messages use
`data.real.error.<REASON|CODE>`.

## 4. Scoped reads: how a selector reads a domain

```ts
export const menuAdapter: DomainAdapter = {
  domain: 'menu',
  sources: ['menu'],
  tables: ['menuItem', 'menuOption'],
  async load({ reads }) {
    const { items, asOf, sourceRevision, complete } = await reads.all<Menu>({ resource: 'menu', path: '/inventory/menu', query: { limit: 200 } });
    return {
      tables: { menuItem: items.map(toMenuItem), menuOption: items.flatMap(toMenuOptions) },
      revisions: Object.fromEntries(items.map(m => [`menu:${m.menuId}`, m.revision])),
      asOf, sourceRevision, complete,
    };
  },
  commands: [ /* §5 */ ],
};
```

* The store calls `load()` on first read of a widget of that domain and after every commit that lists the domain's `sources` in `affectedSources`.
* The `tables` you return **replace** the fixture rows of the keys in `adapter.tables` (empty list = empty table = the real empty state).
* Hooks (all `src/data/react.tsx`): `useRealPort()` → `RealPort | undefined` (`port?.files`), `useDomainState(domain)`, `useRealRetry(domain)`, `useDataExecute()`. Non-React: `store.real`, `store.execute(command)`.
* Widget state: `useDomainState('menu')` → `{status:'loading'|'ready'|'stale'|'error', error?, pending, refreshing}`. `useWidgetView('menu')` returns
  `empty` + `data.real.loading` while the first load runs, `error` + `data.real.error` after a failed first load (the existing error/empty chrome and
  retry), and the normal model + a `data.real.stale` note when a refresh failed but old data is kept. Retry = `useRealRetry('menu')`.
* Background refresh never remounts: the snapshot object changes, widget focus/scroll are untouched (same as the catalog refresh today).
* Cache scope = store + resource + path + query. A store change (account domain) resets every domain.
* A 401/403, explicit session change or reset discards HTTP rows, revisions, pending writes, retries and undo receipts for the old scope. Array tables become empty. Optional fields and required object tables return to their initial shape. An adapter writing part of a shared table can implement `clear(snapshot)` to erase its scoped fields while preserving the other owners' fields. Use the same hook to clear any external read cache owned by the adapter.

## 5. Command registration: how a widget/Navis command is implemented on the port

Command **names and argument shapes do not change** (`menu.setSaleStatus({menuId,status})` …). You add one binding per command type:

```ts
commands: [
  defineBinding({
    type: 'menu.setSaleStatus',
    optimistic: 'local',                       // run the existing fixture handler now, roll back on failure, replace by the re-read
    receiptBase: '/inventory',                 // undo → POST /inventory/receipts/{receiptId}/undo
    request: (c, ctx) => ({ method: 'PATCH', path: `/inventory/menu/${c.menuId}`,
                            body: { saleStatus: c.status }, expectedRevision: ctx.revision(`menu:${c.menuId}`) }),
  }),
  defineBinding({ type: 'menu.create', request: c => ({ method: 'POST', path: '/inventory/menu', body: { name: c.name, category: c.category, price: c.price, memo: c.memo ?? null } }) }),
],
```

* **Pending-until-confirmed** (omit `optimistic`): money, stock and sends. The widget awaits `useDataExecute()(command)` and shows its pending state; nothing is shown as saved before the receipt.
* **Optimistic** (`optimistic:'local'`): `useDataDispatch()` keeps returning the immediate `DataCommandResult` (now with `pending: true`); a failure rolls the tables back and returns through the notice channel. Navis cards and new code should prefer `execute()` (resolves with the authoritative result).
* Widgets in http mode **must** call `useDataExecute()` for non-optimistic commands; `useDataDispatch()` returns `{ok:false, reason:'ASYNC_REQUIRED'}` for them so a missed conversion is loud in tests, not silent.
* **Double press**: while a command with the same type + fingerprint is in flight, `execute()` returns the same promise and the server sees one key.
* **Idempotency**: `command.idempotencyKey` when present (Navis card key), else a generated UUID per logical attempt.
* **Navis**: `agent-actions` / `insight/actions` call `store.execute(command)`; the card press is still the only trigger. Same binding, same request: one dispatcher per command (do not also implement it in `insight/actions.ts`).

## 6. Receipt / undo / dependent refresh

`execute()` result on success:

```ts
{ ok: true, revision, value: CommandReceipt, undoToken?: 'real-undo:<receiptId>',   // only when receipt.undoUntil is set and the binding has receiptBase
  noticeKey?, duplicate?: true }                                                    // duplicate when the same key replays a stored receipt
```

1. The port waits for the receipt, then re-reads every domain whose `sources` intersect `receipt.affectedSources` (menu edit → `pos` re-reads its catalog).
2. `store.undo('real-undo:…')` → checks `undoUntil` (after expiry: `{ok:false, reason:'UNDO_EXPIRED'}`), POSTs `{receiptBase}/receipts/{id}/undo` with its own key, re-reads.
3. Existing fixture `undoToken`s are unchanged. The notice/toast uses the same expiry (`undoUntil`).

## 7. Navis impact (R1 rule: keep commands stable)

* Do not rename `agentCommandPolicy` commands or change argument contracts; add the binding for the same `type`.
* Facts/search read the same `DataSnapshot` tables that `load()` filled, so `WidgetFactSource`, `projectAgentWidget/Source/Search` and the card previews follow automatically.
* When a binding changes a capability (the 18/22 tables in REAL_PLAN), tell B17/F17 with the command name; they own the policy side.

## 8. Test helper (F00 provides)

```ts
import { createRealPort } from '../00';
import { fakeBackend, reply } from '../00/testing';
const backend = fakeBackend();                       // in-memory fetch (session endpoints included); records every call
backend.on('GET', '/inventory/menu', () => ({ items: [...], nextCursor: null, asOf: '…', sourceRevision: 3 }));
backend.on('PATCH', /\/inventory\/menu\/.+/, (req) => ({ resourceId: '…', revision: 2, receiptId: '…', affectedSources: ['menu'] }));
backend.on('POST', '/inventory/menu', () => reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION' }));
const store = createWidgetDataStore();
const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [menuAdapter], sleep: async () => {}, reconcileDelaysMs: [0] });
store.bindReal(port);                                // the app does this in createAppRealPort(store)
backend.callsTo('PATCH', /menu/)                     // store-relative path, query, body, headers
```

`src/data/reality/00/port.test.ts` is a worked example of every behavior above (loads, states, optimistic rollback, stale revision, double press, reconcile, undo, dependent re-read).

## 9. Attachments (`port.files`, account service)

```ts
const port = useRealPort();                                              // or ctx.files inside a binding
const file = await port.files.uploadDataUrl('menu-photo', customPhotoUrl); // {fileId, contentType, size, sha256}
const url = await port.files.readUrl(file.fileId);                        // authorized GET → object URL (revoke with URL.revokeObjectURL)
await port.files.revoke(file.fileId);
```

Wire (B00 confirms the final shapes; the port already speaks this): `POST /files {purpose,contentType,size,sha256}` with `Idempotency-Key: file:{purpose}:{sha256}` → `{fileId}`;
`PUT /files/{id}/content` raw bytes (`Content-Type` = the file type); `POST /files/{id}/complete {}` → `{fileId,contentType,size,sha256}`; `GET /files/{id}/content` (bearer, `no-store`);
`DELETE /files/{id}`. A binding that needs a file builds its request asynchronously: `request: async (c, ctx) => ({ …, body: { photoFileId: (await ctx.files.uploadDataUrl('menu-photo', c.customPhotoUrl)).fileId } })`.
The upload runs once per logical attempt; a reconcile resend of the command reuses the stored request, so a retried menu edit never uploads twice (and the create is idempotent by content hash anyway).

Ownership reminder: shared files (`src/data/{facts,widget-data,react,db/store}.ts`, `commands/*`, `models/select.ts`) are F00's; ask F00 for changes there instead of editing.

## 10. Account domain wire — F00 proposal for B00 (confirm or amend; F00 builds against this)

Same conventions as §3 (store-scoped `/api/v1/stores/{storeId}…`, `Idempotency-Key`, `expectedRevision` in the JSON body, receipts, `{items,nextCursor,asOf,sourceRevision}` lists).

| Purpose | Request | Response |
| --- | --- | --- |
| Start / end / refresh session | existing `POST /api/v1/auth/demo|refresh`; new `POST /api/v1/auth/login {loginId,password}`, `POST /api/v1/auth/logout` | `AccessTokenResponse` + rotating refresh cookie; `401 {code:'UNAUTHENTICATED',reason:'BAD_CREDENTIALS'}` |
| Stores of this account | `GET /api/v1/stores` (root) | `{items:[{storeId,name,role,current}],nextCursor:null,asOf,sourceRevision}` |
| Change store | `POST /api/v1/auth/store {storeId}` (root) | `AccessTokenResponse` for that store; `403 STORE_FORBIDDEN` when not a member. The browser then resets every domain and re-reads |
| Store profile / settings | `GET /profile`, `PATCH /profile {businessType?,paymentStyle?,tableLayout?,posPreferences?,cctvPosLinks?,onboardingDone?,expectedRevision}` | `{storeId,name,businessType,paymentStyle,tableLayout,posPreferences?,cctvPosLinks?,onboardingDone,revision}` / receipt |
| User preferences | `GET /preferences`, `PATCH /preferences {theme?,textScale?,locale?,expectedRevision}` | `{theme,textScale,locale,revision}` / receipt |
| Boards (pages + panels) | `GET /boards`; `PUT /boards/{boardId} {pages:[{pageId,panels:[{featureId,column,row,width,height,condition?}]}],currentPage,expectedRevision}` for `boardId ∈ management|marketing` | `{items:[{boardId,revision,currentPage,pages}],…}` / receipt `{resourceId:boardId,revision,receiptId,undoUntil?,affectedSources:['boards']}` |

Why one `PUT` per board: the layout engine commits a whole-board arrangement atomically (drag/resize/displace/page add), so the server stores pages and panels
normalized but accepts and returns them as one unit with one revision; `409 STALE_REVISION` means another tab changed the board (the browser re-reads, keeps the owner's
view and asks them to redo). Undo of a layout change stays a browser action that issues a new `PUT` (the existing layout undo), so `undoUntil` is optional here.

## 11. Widget dependencies, autoload, Navis facts

`WIDGET_DEPENDENCIES` (`port.ts`) lists the other domains a widget's numbers read (briefing ← staff/…, notice-send and ai-response ← staff/members, …).
`useWidgetView(id)` loads the widget's own domain and every dependency, and shows loading/error for the widget while any **HTTP** dependency is not loaded, so rows a dependency
still holds from the fixture seed never leak in. A dependency in fixture mode costs nothing. Ask F00 for a new edge when your projection reads another domain's tables (shared file).
Navis facts of an unopened widget: `await ensureWidgetData(store, [widgetId…])` (`data/widget-data.ts`) loads the same set first.

## 12. Toast undo and the account shell

* Widget toasts: `host.notify({kind, messageKey, undoToken: result.undoToken, undoUntil: receipt.undoUntil})` — the toast never outlives the receipt's deadline (expired receipt: no undo toast).
* Notice-toast undo is async for real receipts: `undoDataNotice(store, token)` / `useDataUndoAsync()` resolve after the server answers (`data.real.error.UNDO_EXPIRED` etc.). `store.undo()` stays the sync starter (`pending: true`).
* Account: `src/data/reality/00/account/{client,sync}.ts` (login, logout, stores, store switch, profile, preferences, boards; wire = §10). `createBrowserBootstrap` restores the stored account into the run before the first
  screen (`phase: 'signin'` when no session can start), `createAccountSync` writes board / settings / preference changes back (debounced, one write at a time, 409 → stored state restored + notice).
  Settings shows "매장 바꾸기" (more than one store) and "로그아웃"; the dashboard heading is the active store's name (fixture builds keep the sample cafe).
* Sign-in is a plain pre-provider screen (`src/app/SignIn.tsx`, like `AppFailure`); a designed version is an R4 request. Behavior is final.
