# Project: whoop-mcp

An MCP (Model Context Protocol) server that wraps the WHOOP REST API, enabling AI assistants to query health and fitness data through natural conversation.

## Tech Stack

- **Language:** TypeScript ~5.x (strict mode, no `any`)
- **Runtime:** Node.js >= 18 (native `fetch`)
- **MCP SDK:** `@modelcontextprotocol/sdk` (latest)
- **Validation:** Zod (for MCP tool input schemas)
- **Test Framework:** Vitest
- **Lint:** ESLint + `@typescript-eslint`
- **Formatter:** Prettier
- **Build:** `tsc` (no bundler)
- **Package Manager:** npm
- **No other runtime dependencies.** Keep the dependency tree minimal.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm run dev          # Run in development (tsx)
npm test             # Run tests
npm test -- --coverage  # Tests with coverage
npm run lint         # Lint
npm run lint:fix     # Lint + fix
npm run format       # Format with Prettier
npm run typecheck    # Type check (no emit)
node dist/index.js   # Run MCP server (production)
```

## Project Structure

```
src/
├── index.ts                    # Entry point — creates MCP server, authenticates, starts stdio
├── server.ts                   # MCP server setup and tool registration
├── auth/
│   ├── oauth.ts                # OAuth2 Authorization Code flow
│   ├── token-store.ts          # Read/write/refresh tokens (~/.whoop-mcp/tokens.json)
│   └── callback-server.ts      # Temporary local HTTP server for OAuth callback
├── api/
│   ├── client.ts               # WHOOP API HTTP client (fetch + auth headers + retry)
│   ├── types.ts                # TypeScript types for all WHOOP API responses
│   └── endpoints.ts            # Endpoint URL constants
└── tools/
    ├── get-profile.ts          # Tool: get_profile
    ├── get-recovery.ts         # Tool: get_recovery_collection
    ├── get-sleep.ts            # Tool: get_sleep_collection
    ├── get-workout.ts          # Tool: get_workout_collection
    ├── get-cycle.ts            # Tool: get_cycle_collection
    └── get-body-measurement.ts # Tool: get_body_measurement

tests/                          # Mirrors src/ structure
├── auth/
├── api/
└── tools/
```

## Code Conventions

### Naming
- **Files:** `kebab-case.ts`
- **Types/Interfaces:** `PascalCase` (e.g., `RecoveryRecord`, `SleepCollection`)
- **Functions:** `camelCase` (e.g., `getRecoveryCollection`)
- **Constants:** `SCREAMING_SNAKE_CASE` (e.g., `WHOOP_API_BASE_URL`)
- **MCP tool names:** `snake_case` (MCP convention, e.g., `get_recovery_collection`)

### Patterns
- Explicit return types on all exported functions
- Zod for tool input validation (MCP SDK convention)
- One tool per file — handler + schema co-located
- Functional style — no classes except where SDK requires
- Named exports (no default exports)
- Errors throw typed errors, never return error codes
- Tests co-located in `tests/` directory mirroring `src/`

### Example — Tool Implementation Pattern

```typescript
// src/tools/get-recovery.ts
import { z } from "zod";
import { WhoopClient } from "../api/client.js";
import type { RecoveryCollection } from "../api/types.js";

export const getRecoveryCollectionSchema = {
  name: "get_recovery_collection",
  description:
    "Get recovery scores for a date range. Returns HRV, resting heart rate, SpO2, and skin temp.",
  inputSchema: z.object({
    start: z.string().optional().describe("ISO 8601 start time (inclusive)"),
    end: z.string().optional().describe("ISO 8601 end time (exclusive)"),
    limit: z.number().optional().describe("Max records (1-25). Default 10."),
  }),
};

export async function getRecoveryCollection(
  client: WhoopClient,
  params: { start?: string; end?: string; limit?: number }
): Promise<RecoveryCollection> {
  const searchParams = new URLSearchParams();
  if (params.start) searchParams.set("start", params.start);
  if (params.end) searchParams.set("end", params.end);
  if (params.limit) searchParams.set("limit", String(params.limit));
  return client.get<RecoveryCollection>(`/v2/recovery?${searchParams.toString()}`);
}
```

## Testing

- **TDD:** Write tests before code (Prove-It pattern for bugs)
- **Mock the WHOOP API:** Never hit the real API in tests. Use `vi.fn()` to mock `fetch`.
- **Test hierarchy:** unit > integration > e2e (use the lowest level that captures the behavior)
- **Coverage target:** >80% on `src/auth/` and `src/api/`, >70% overall
- **Run `npm test` after every change**

## WHOOP API Reference

- **Base URL:** `https://api.prod.whoop.com/developer`
- **OAuth Auth URL:** `https://api.prod.whoop.com/oauth/oauth2/auth`
- **OAuth Token URL:** `https://api.prod.whoop.com/oauth/oauth2/token`
- **Required Scopes:** `read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement`
- **All endpoints use v2.** Date params use ISO 8601. Collections default `limit=10` (max 25).

| MCP Tool | Endpoint | Method |
|----------|----------|--------|
| `get_profile` | `/v2/user/profile/basic` | GET |
| `get_recovery_collection` | `/v2/recovery` | GET |
| `get_sleep_collection` | `/v2/activity/sleep` | GET |
| `get_workout_collection` | `/v2/activity/workout` | GET |
| `get_cycle_collection` | `/v2/cycle` | GET |
| `get_body_measurement` | `/v2/user/measurement/body` | GET |

## Boundaries

### Always
- Run `npm test` before every commit
- Validate all tool input with Zod schemas
- Store tokens in `~/.whoop-mcp/` with `0600` permissions
- Return helpful error messages (Claude needs to understand failures)
- Build in small, verifiable increments: implement → test → verify → commit

### Ask First
- Adding any runtime dependency beyond `@modelcontextprotocol/sdk` and `zod`
- Changing the token storage location or format
- Adding WHOOP API endpoints not in the MVP 6 tools
- Changing the OAuth flow
- Database schema changes

### Never
- Commit `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, or tokens
- Store tokens in a world-readable location
- Make real WHOOP API calls in automated tests
- Use `any` — strict TypeScript throughout
- Remove or skip failing tests without discussion
- Mix formatting changes with behavior changes

## Implementation Status

> **Current phase:** Shipped. All 10 tasks complete. 212 tests passing, typecheck clean, build clean, lint clean.
> ✅ **MCP Inspector tested** (2026-04-12) — OAuth grant flow + `get_profile` returning real data.
> ✅ **Claude Desktop tested** (2026-04-12) — server connected, OAuth completed, tools accessible from chat.
> ✅ **Published to npm** (2026-04-12) — `whoop-ai-mcp@0.1.0` at https://www.npmjs.com/package/whoop-ai-mcp
> **Plan:** `docs/specs/implementation-plan.md`
> **Spec:** `docs/specs/whoop-mcp-server.md`
> **Code review:** `docs/reviews/code-review-checkpoint-1.md` (Tasks 1–5 approved)

## Implementation Order

1. ✅ Project scaffold (package.json, tsconfig, eslint, vitest)
2. ✅ WHOOP API types (`src/api/types.ts`, `src/api/endpoints.ts`)
3. ✅ Token store (`src/auth/token-store.ts`) — 18 tests
4. ✅ API client (`src/api/client.ts`) — 16 tests
5. ✅ OAuth flow (`src/auth/oauth.ts`, `src/auth/callback-server.ts`) — 41 tests
6. ✅ MCP server shell (`src/server.ts`) — 16 tests
7. ✅ Tool implementations (`src/tools/*.ts`) — 33 tool tests + 16 server integration tests
8. ✅ Error handling — WhoopNetworkError, 429 retry w/ backoff, 401 token refresh, safeTool wrapper — 17 new tests
9. ✅ Entry point + CLI (`src/index.ts`) — env var validation, auth wiring, client w/ token refresh, stdio transport — 14 tests
10. ✅ Docs + publish prep — README, LICENSE, CHANGELOG, CONTRIBUTING, package.json metadata

## Known Issues from Code Review
- Callback server tests use random port range (flaky in CI) — use port `0` instead
- Refresh failure silently swallowed in `authenticate()` — should log/differentiate errors
- `openBrowser` has shell injection vector — should use `spawn` with arg arrays
