# Task 4 Plan: API Client

> **Parent spec:** `docs/specs/implementation-plan.md` → Task 4
> **Depends on:** Task 1 (scaffold) ✅, Task 2 (types) ✅, Task 3 (token store) ✅
> **Consumed by:** Task 5 (OAuth — uses client for token exchange), Task 7a–7f (all tools), Task 8 (error handling adds retry/re-auth)
> **Created:** 2026-04-10

---

## Overview

Build a thin HTTP client wrapper around native `fetch` that calls the WHOOP REST API. The client injects the OAuth Bearer token into every request, prepends the base URL, parses JSON responses, and throws typed errors for non-2xx status codes. It does **not** handle retry or re-auth — that's Task 8.

## Architecture Decisions

- **Functional factory, not a class** — `createWhoopClient(accessToken)` returns an object with a `get()` method. The spec example shows tools accepting a `WhoopClient`, but the project conventions prefer functional style. We export a `WhoopClient` type for the return shape.
- **`get<T>(path)` as the only method** — All 6 WHOOP endpoints are GET-only. No need for POST/PUT/DELETE until a future scope expansion. Keep it minimal.
- **Base URL prepended automatically** — Paths like `/v2/recovery?start=...` are passed in; the client prepends `WHOOP_API_BASE_URL`.
- **Typed errors, not error codes** — `WhoopApiError` carries `statusCode`, `statusText`, and the parsed error body. Thrown on any non-2xx response.
- **No retry logic in MVP client** — Retry (429) and re-auth (401) are explicitly Task 8. The client throws; callers decide what to do.
- **Token passed at construction time** — The client is created with a valid access token. If the token expires mid-session, a new client is created after refresh (Task 5 concern).

## Dependency Graph

```
src/api/client.ts
  ├── imports: WHOOP_API_BASE_URL from src/api/endpoints.ts
  ├── imports: nothing from token-store (token is passed in as a string)
  └── uses: global fetch (Node 18+)

tests/api/client.test.ts
  └── mocks: global fetch with vi.fn()

Consumed by:
  → src/tools/get-profile.ts (Task 7a) — client.get<UserProfile>(ENDPOINT_USER_PROFILE)
  → src/tools/get-recovery.ts (Task 7b) — client.get<RecoveryCollection>(...)
  → ... (all 6 tools)
  → src/api/client.ts (Task 8) — adds retry/re-auth wrapping
```

## API Surface

```typescript
/** Options for creating a WHOOP API client */
export interface WhoopClientOptions {
  accessToken: string;
  baseUrl?: string; // defaults to WHOOP_API_BASE_URL — overridable for tests
}

/** WHOOP API client returned by createWhoopClient */
export interface WhoopClient {
  get<T>(path: string): Promise<T>;
}

/** Error thrown when the WHOOP API returns a non-2xx response */
export class WhoopApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly body: unknown,
  ) { ... }
}

/** Create a WHOOP API client */
export function createWhoopClient(options: WhoopClientOptions): WhoopClient;
```

### Why this shape?

- **`WhoopClient` as an interface** — Tools depend on the interface, not the implementation. Tests can easily provide a mock matching `{ get: vi.fn() }`.
- **`WhoopApiError` as a class** — Enables `instanceof` checks. Carries structured data (statusCode, body) so Task 8 can branch on 429 vs 401.
- **`baseUrl` override** — Tests can point at a custom URL to avoid hardcoding the prod URL in assertions.

## Task List

### Task 4a: WhoopApiError class + tests

**Description:** Define the `WhoopApiError` class that carries statusCode, statusText, and body. This is the error type thrown by the client and consumed by Task 8.

**Acceptance criteria:**
- [ ] `WhoopApiError` extends `Error` with `statusCode`, `statusText`, `body` properties
- [ ] `message` is human-readable: `"WHOOP API error: 401 Unauthorized"`
- [ ] `instanceof Error` and `instanceof WhoopApiError` both work
- [ ] `name` property is `"WhoopApiError"`

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** None

**Files:**
- `src/api/client.ts` (partial — error class only)
- `tests/api/client.test.ts` (partial — error tests only)

**Estimated scope:** XS (1 file, ~15 lines of code + ~20 lines of test)

---

### Task 4b: createWhoopClient + successful GET

**Description:** Implement `createWhoopClient()` and `client.get<T>()` for the happy path — sends GET with Authorization header, parses JSON response.

**Acceptance criteria:**
- [ ] `client.get("/v2/recovery")` calls `fetch("https://api.prod.whoop.com/developer/v2/recovery")`
- [ ] Request includes `Authorization: Bearer <token>` header
- [ ] Request includes `Content-Type: application/json` header
- [ ] Successful 200 response is parsed as JSON and returned as `T`
- [ ] `baseUrl` override works (tests don't depend on prod URL)

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** Task 4a (needs WhoopApiError for the module to compile)

**Files:**
- `src/api/client.ts` (add createWhoopClient + get)
- `tests/api/client.test.ts` (add happy-path GET tests)

**Estimated scope:** S (1 file, ~25 lines of code + ~40 lines of test)

---

### Task 4c: Error handling — non-2xx responses

**Description:** When the WHOOP API returns a non-2xx status, `get()` throws a `WhoopApiError` with the status code, status text, and parsed body (if JSON) or raw text.

**Acceptance criteria:**
- [ ] 401 response throws `WhoopApiError` with `statusCode: 401`
- [ ] 429 response throws `WhoopApiError` with `statusCode: 429`
- [ ] 500 response throws `WhoopApiError` with `statusCode: 500`
- [ ] Error body is parsed as JSON if possible, raw text otherwise
- [ ] Error `message` includes status code and status text

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** Task 4b

**Files:**
- `src/api/client.ts` (modify get to throw on non-2xx)
- `tests/api/client.test.ts` (add error tests for 401, 429, 500)

**Estimated scope:** S (same files, ~15 lines of code + ~40 lines of test)

---

### Task 4d: Edge cases + network errors

**Description:** Handle edge cases: network failures (fetch throws), non-JSON success responses, and empty response bodies.

**Acceptance criteria:**
- [ ] Network error (fetch rejects) propagates as-is (not swallowed)
- [ ] Non-JSON response body in error case falls back to raw text in `WhoopApiError.body`
- [ ] `WhoopClient` and `WhoopClientOptions` types are exported for downstream consumers

**Verification:** `npm test -- tests/api/client.test.ts`

**Dependencies:** Task 4c

**Files:**
- `src/api/client.ts` (edge case handling)
- `tests/api/client.test.ts` (add edge case tests)

**Estimated scope:** XS (same files, ~10 lines of code + ~25 lines of test)

---

### Task 4e: Final verification

**Description:** Full pipeline check. Confirm all tests pass, typecheck clean, lint clean, build clean.

**Acceptance criteria:**
- [ ] All client tests pass: `npm test -- tests/api/client.test.ts`
- [ ] Full suite passes: `npm test`
- [ ] Build clean: `npm run build`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Lint clean: `npm run lint`

**Verification:** `npm test && npm run typecheck && npm run lint && npm run build`

**Dependencies:** Tasks 4a–4d

**Files:** None (verification only)

**Estimated scope:** XS (no code changes)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Mocking `fetch` in Vitest is tricky with native Node fetch | 🟡 Medium | Use `vi.stubGlobal("fetch", vi.fn())` — works reliably with Node 18+ native fetch |
| WHOOP API might return non-JSON error bodies | 🟢 Low | Try JSON parse, fall back to text — tested in 4d |
| Downstream tools expect a class-based `WhoopClient` (spec example) | 🟢 Low | Export `WhoopClient` as an interface — tools depend on shape, not constructor. Mock-friendly. |
| Task 8 will need to wrap/modify the client for retry | 🟢 Low | Keeping the client simple now makes it easy to wrap or extend later |

## Checkpoint: After Task 4e

- [ ] All client tests pass: `npm test -- tests/api/client.test.ts`
- [ ] Full suite passes: `npm test`
- [ ] Build clean: `npm run build`
- [ ] Typecheck clean: `npm run typecheck`
- [ ] Lint clean: `npm run lint`
- [ ] Exports: `WhoopClient`, `WhoopClientOptions`, `WhoopApiError`, `createWhoopClient`
- [ ] No secrets committed
