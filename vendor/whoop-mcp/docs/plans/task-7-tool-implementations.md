# Task 7: Tool Implementations

> **Spec:** `docs/specs/whoop-mcp-server.md`
> **Depends on:** Tasks 1–6 (all complete, 114 tests passing)
> **Created:** 2026-04-11

---

## Overview

Replace all 6 stub tool handlers in `src/server.ts` with real implementations that call the WHOOP API via `WhoopClient`. Each tool gets its own file in `src/tools/` (handler + Zod schema co-located) and a matching test file in `tests/tools/`.

## Architecture Decisions

1. **One file per tool** — handler function + exported Zod schema live together in `src/tools/<tool>.ts`. This follows the project convention and keeps each tool self-contained.

2. **Tool files export a handler function, not register themselves** — `server.ts` imports each handler and wires it into `registerTool`. This keeps the server as the single point of tool registration.

3. **Handler functions take `WhoopClient` + typed params, return API response types** — The `server.ts` callback wraps each handler, serializing the result to `{ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] }`.

4. **Collection tools share a `buildCollectionQuery` helper** — All 4 collection tools (recovery, sleep, workout, cycle) build query strings from `{ start?, end?, limit?, nextToken? }`. Extract this into a shared utility to avoid repetition.

5. **Tests mock `WhoopClient.get` with `vi.fn()`** — Never hit the real API. Each test verifies the correct endpoint + query string is called and the response is returned correctly.

6. **Keep `createWhoopServer(client)` inspectable** — The `server.ts` factory must remain a pure function that takes a `WhoopClient` and returns an `McpServer`. It must NOT start transports, handle OAuth, or read environment variables. This separation means the server can be connected to **any** transport — stdio for production (Task 9), `InMemoryTransport` for unit tests (current `server.test.ts`), or **MCP Inspector** (`npx @modelcontextprotocol/inspector`) for manual verification in later tasks. The entry point (`index.ts`, Task 9) is responsible for creating the client, calling `createWhoopServer()`, and connecting the stdio transport. After Task 7, the server will be fully functional for Inspector testing — just needs a real or mocked `WhoopClient` passed in.

## Shared Utility

Before implementing individual tools, extract a helper for building collection query strings:

```typescript
// Used by all 4 collection tool handlers
function buildCollectionQuery(params: {
  start?: string; end?: string; limit?: number; nextToken?: string;
}): string
```

This will live in a shared location (either a helper in `src/tools/` or inlined — decide during implementation based on size).

## Task List

### Task 7a: `get_profile` tool

**Description:** Implement the simplest tool — no input params, calls a single endpoint, returns a flat object.

**Acceptance criteria:**
- [ ] `getProfile(client)` calls `client.get<UserProfile>("/v2/user/profile/basic")`
- [ ] Returns `UserProfile` (`{ user_id, email, first_name, last_name }`)
- [ ] `server.ts` stub replaced — handler serializes result as JSON text content
- [ ] Tests pass with mocked client

**Verification:** `npm test -- tests/tools/get-profile.test.ts`

**Dependencies:** None (first tool, establishes the pattern)

**Files:**
- `src/tools/get-profile.ts` (create)
- `tests/tools/get-profile.test.ts` (create)
- `src/server.ts` (modify — replace get_profile stub)

**Estimated scope:** Small (3 files)

---

### Task 7f: `get_body_measurement` tool

**Description:** Second simple tool — no input params, single endpoint, flat object. Same shape as get_profile.

**Acceptance criteria:**
- [ ] `getBodyMeasurement(client)` calls `client.get<BodyMeasurement>("/v2/user/measurement/body")`
- [ ] Returns `BodyMeasurement` (`{ height_meter, weight_kilogram, max_heart_rate }`)
- [ ] `server.ts` stub replaced
- [ ] Tests pass with mocked client

**Verification:** `npm test -- tests/tools/get-body-measurement.test.ts`

**Dependencies:** Task 7a (reuse the same pattern)

**Files:**
- `src/tools/get-body-measurement.ts` (create)
- `tests/tools/get-body-measurement.test.ts` (create)
- `src/server.ts` (modify — replace get_body_measurement stub)

**Estimated scope:** Small (3 files)

---

### Task 7b: `get_recovery_collection` tool

**Description:** First collection tool — establishes the pattern for query string building with `start`, `end`, `limit`, `nextToken` params. All subsequent collection tools follow this shape.

**Acceptance criteria:**
- [ ] `getRecoveryCollection(client, params)` calls `client.get<RecoveryCollection>("/v2/recovery?...")` with correct query string
- [ ] Query string only includes provided params (omits undefined)
- [ ] `nextToken` maps to query param `nextToken`
- [ ] `limit` is converted to string for URLSearchParams
- [ ] Returns `RecoveryCollection` (`{ records: Recovery[], next_token? }`)
- [ ] `server.ts` stub replaced — handler passes parsed args to function
- [ ] Tests cover: no params, all params, partial params

**Verification:** `npm test -- tests/tools/get-recovery.test.ts`

**Dependencies:** Task 7a (pattern established)

**Files:**
- `src/tools/get-recovery.ts` (create)
- `tests/tools/get-recovery.test.ts` (create)
- `src/server.ts` (modify — replace get_recovery_collection stub)

**Estimated scope:** Small (3 files)

---

### Task 7c: `get_sleep_collection` tool

**Description:** Collection tool for sleep data. Same query pattern as recovery.

**Acceptance criteria:**
- [ ] `getSleepCollection(client, params)` calls `client.get<SleepCollection>("/v2/activity/sleep?...")`
- [ ] Query string built correctly from params
- [ ] Returns `SleepCollection`
- [ ] `server.ts` stub replaced
- [ ] Tests cover: no params, all params

**Verification:** `npm test -- tests/tools/get-sleep.test.ts`

**Dependencies:** Task 7b (collection pattern established)

**Files:**
- `src/tools/get-sleep.ts` (create)
- `tests/tools/get-sleep.test.ts` (create)
- `src/server.ts` (modify — replace get_sleep_collection stub)

**Estimated scope:** Small (3 files)

---

### Task 7d: `get_workout_collection` tool

**Description:** Collection tool for workout data. Same query pattern.

**Acceptance criteria:**
- [ ] `getWorkoutCollection(client, params)` calls `client.get<WorkoutCollection>("/v2/activity/workout?...")`
- [ ] Query string built correctly from params
- [ ] Returns `WorkoutCollection`
- [ ] `server.ts` stub replaced
- [ ] Tests cover: no params, all params

**Verification:** `npm test -- tests/tools/get-workout.test.ts`

**Dependencies:** Task 7b (collection pattern established)

**Files:**
- `src/tools/get-workout.ts` (create)
- `tests/tools/get-workout.test.ts` (create)
- `src/server.ts` (modify — replace get_workout_collection stub)

**Estimated scope:** Small (3 files)

---

### Task 7e: `get_cycle_collection` tool

**Description:** Collection tool for physiological cycle data. Same query pattern.

**Acceptance criteria:**
- [ ] `getCycleCollection(client, params)` calls `client.get<CycleCollection>("/v2/cycle?...")`
- [ ] Query string built correctly from params
- [ ] Returns `CycleCollection`
- [ ] `server.ts` stub replaced
- [ ] Tests cover: no params, all params

**Verification:** `npm test -- tests/tools/get-cycle.test.ts`

**Dependencies:** Task 7b (collection pattern established)

**Files:**
- `src/tools/get-cycle.ts` (create)
- `tests/tools/get-cycle.test.ts` (create)
- `src/server.ts` (modify — replace get_cycle_collection stub)

**Estimated scope:** Small (3 files)

---

### Task 7g: Update `server.test.ts` + full verification

**Description:** Update the existing server tests. The stub handler tests currently assert `isError: true` and "Not implemented" text — these must be updated to expect real JSON responses from the now-implemented handlers. Also run full test suite.

**Acceptance criteria:**
- [ ] `server.test.ts` stub handler tests updated to use a mock client that returns fixture data
- [ ] Calling each tool via MCP returns JSON content (not error stubs)
- [ ] All 114+ tests pass
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run lint` passes

**Verification:** `npm test && npm run typecheck && npm run build && npm run lint`

**Dependencies:** Tasks 7a–7f (all tools implemented)

**Files:**
- `tests/server.test.ts` (modify — update stub tests)

**Estimated scope:** Small (1 file)

---

## Implementation Order

```
7a (get_profile)          ← establishes singleton tool pattern
    │
7f (get_body_measurement) ← second singleton, validates pattern
    │
7b (get_recovery)         ← establishes collection tool pattern
    │
    ├── 7c (get_sleep)    ┐
    ├── 7d (get_workout)  ├─ parallel (same pattern, different endpoint)
    └── 7e (get_cycle)    ┘
         │
7g (server test update + full verification)
```

**Why this order:**
1. **7a first** — simplest tool (no params), establishes the handler → server.ts wiring pattern
2. **7f second** — same shape as 7a, validates the pattern works for both singleton tools
3. **7b next** — first collection tool, establishes query string building pattern
4. **7c/7d/7e parallel** — identical shape to 7b, just different endpoints and types
5. **7g last** — update integration tests after all handlers are real

## Checkpoint: After Task 7g

- [ ] All tests pass (`npm test`)
- [ ] TypeScript compiles (`npm run typecheck`)
- [ ] Build succeeds (`npm run build`)
- [ ] Lint clean (`npm run lint`)
- [ ] `src/tools/` contains 6 files (one per tool)
- [ ] `tests/tools/` contains 6 test files
- [ ] `server.ts` has zero stubs — all handlers call real tool functions
- [ ] No `any` types introduced
- [ ] All tool handlers have explicit return types
- [ ] `createWhoopServer()` remains a pure factory — no transport, no OAuth, no env vars — ready for MCP Inspector in Task 9

## MCP Inspector Testing (deferred to Task 9)

After Task 7, the server is fully functional but has no standalone entry point with a real client yet. MCP Inspector testing becomes possible once Task 9 wires up `index.ts` with OAuth + stdio transport:

```bash
# After Task 9, verify all 6 tools interactively:
npx @modelcontextprotocol/inspector node dist/index.js
```

The `createWhoopServer(client)` factory design ensures this works — Inspector connects via stdio to the same server that unit tests connect to via `InMemoryTransport`. No code changes needed between test and Inspector environments.

If you want to test with Inspector **before** Task 9 (e.g., right after Task 7), you could write a small script that creates a mock client and connects the server to stdio — but this is optional and not part of the Task 7 deliverables.

## Patterns to Follow

### Tool file pattern (`src/tools/get-<name>.ts`)

```typescript
import type { WhoopClient } from "../api/client.js";
import type { ResponseType } from "../api/types.js";
import { ENDPOINT_CONSTANT } from "../api/endpoints.js";

// For collection tools: shared params type
export interface CollectionParams {
  start?: string;
  end?: string;
  limit?: number;
  nextToken?: string;
}

export async function handlerName(
  client: WhoopClient,
  params: CollectionParams,  // or no params for singleton tools
): Promise<ResponseType> {
  // Build query string (collection tools only)
  // Call client.get<ResponseType>(endpoint)
  // Return result
}
```

### Server.ts wiring pattern

```typescript
// Replace stub:
//   async () => STUB_RESPONSE,
// With:
//   async (args) => {
//     const result = await handlerFunction(client, args);
//     return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
//   },
```

### Test file pattern (`tests/tools/get-<name>.test.ts`)

```typescript
import { describe, it, expect, vi } from "vitest";
import { handlerName } from "../../src/tools/get-name.js";
import type { WhoopClient } from "../../src/api/client.js";

const FIXTURE = { /* realistic mock response */ };

function createMockClient(response: unknown): WhoopClient {
  return { get: vi.fn().mockResolvedValue(response) } as unknown as WhoopClient;
}

describe("handlerName", () => {
  it("calls the correct endpoint", async () => { ... });
  it("returns the API response", async () => { ... });
  // Collection tools: test query string building
  it("passes start/end/limit/nextToken as query params", async () => { ... });
  it("omits undefined params from query string", async () => { ... });
});
```

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `registerTool` callback signature mismatch | 🟡 Compile error | Verified: callback receives `(args, extra)` for schema tools, `(extra)` for no-schema tools |
| Query string encoding differences | 🟢 Low | Use `URLSearchParams` consistently, test the exact strings |
| `server.test.ts` becomes flaky after handler change | 🟡 Medium | Mock client must return valid fixture data for each tool |

## Out of Scope

- Error handling improvements (429 retry, 401 re-auth) → Task 8
- MCP Inspector manual testing with real WHOOP credentials → Task 9 (server factory is ready, needs entry point + OAuth wiring)
- Real API integration testing → Manual after Task 9
- Pagination helpers (auto-fetching all pages) → Future enhancement
