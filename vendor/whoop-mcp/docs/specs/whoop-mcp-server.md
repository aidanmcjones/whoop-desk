# Spec: WHOOP MCP Server

## Objective

Build an industry-standard MCP (Model Context Protocol) server that wraps the WHOOP REST API, enabling AI assistants like Claude to query a user's health and fitness data — recovery, sleep, strain, workouts, cycles, and body measurements — through natural conversation.

**Users:**
- **Primary:** Developer with a WHOOP device who wants AI-powered access to their health data via Claude Desktop
- **Secondary:** Developer community looking for a reusable, npm-installable WHOOP MCP package

**Success Criteria:**
- [ ] User can configure `whoop-mcp` in Claude Desktop's `claude_desktop_config.json` and authenticate with their WHOOP account
- [ ] User can ask Claude "How was my recovery this week?" and receive an accurate answer from real WHOOP data
- [ ] All 6 MCP tools return typed, well-structured data from the WHOOP API
- [ ] OAuth2 tokens are stored securely, refresh automatically, and prompt for re-auth when expired
- [ ] Package is publishable to npm with a working `npx whoop-mcp` experience
- [ ] All code passes lint, type check, and tests with >80% coverage on core modules (OAuth, API client)

## Tech Stack

| Concern | Choice | Version |
|---------|--------|---------|
| Language | TypeScript | ~5.x |
| Runtime | Node.js | >= 18 |
| MCP SDK | `@modelcontextprotocol/sdk` | latest |
| HTTP Client | Native `fetch` (Node 18+) | — |
| Test Framework | Vitest | latest |
| Linter | ESLint + `@typescript-eslint` | latest |
| Formatter | Prettier | latest |
| Build | `tsc` (no bundler needed for a CLI/server) | — |
| Package Manager | npm | — |

**No other runtime dependencies.** The WHOOP API is standard REST — no SDK needed. Keep the dependency tree minimal for a server that runs inside Claude Desktop's process.

## Commands

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development (ts-node / tsx)
npm run dev

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Lint
npm run lint

# Lint + fix
npm run lint:fix

# Format
npm run format

# Type check (no emit)
npm run typecheck

# Run the MCP server (production)
node dist/index.js

# Run via npx (after npm publish)
npx whoop-mcp
```

## Project Structure

```
whoop-mcp/
├── src/
│   ├── index.ts                  # Entry point — creates MCP server, registers tools
│   ├── server.ts                 # MCP server setup and tool registration
│   ├── auth/
│   │   ├── oauth.ts              # OAuth2 Authorization Code flow
│   │   ├── token-store.ts        # Read/write/refresh tokens from ~/.whoop-mcp/tokens.json
│   │   └── callback-server.ts    # Temporary local HTTP server for OAuth callback
│   ├── api/
│   │   ├── client.ts             # WHOOP API HTTP client (fetch wrapper with auth headers)
│   │   ├── types.ts              # TypeScript types for all WHOOP API responses
│   │   └── endpoints.ts          # Endpoint URL constants
│   └── tools/
│       ├── get-profile.ts        # Tool: get_profile
│       ├── get-recovery.ts       # Tool: get_recovery_collection
│       ├── get-sleep.ts          # Tool: get_sleep_collection
│       ├── get-workout.ts        # Tool: get_workout_collection
│       ├── get-cycle.ts          # Tool: get_cycle_collection
│       └── get-body-measurement.ts # Tool: get_body_measurement
├── tests/
│   ├── auth/
│   │   ├── oauth.test.ts
│   │   └── token-store.test.ts
│   ├── api/
│   │   └── client.test.ts
│   └── tools/
│       ├── get-profile.test.ts
│       ├── get-recovery.test.ts
│       ├── get-sleep.test.ts
│       ├── get-workout.test.ts
│       ├── get-cycle.test.ts
│       └── get-body-measurement.test.ts
├── docs/
│   ├── ideas/                    # Ideation artifacts
│   └── specs/                    # This spec
├── .github/                      # Copilot agents, skills, instructions (existing)
├── references/                   # Checklists (existing)
├── package.json
├── tsconfig.json
├── .eslintrc.json
├── .prettierrc
├── .gitignore
├── .env.example                  # WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET placeholders
├── LICENSE
└── README.md
```

## Code Style

### Naming Conventions
- Files: `kebab-case.ts`
- Types/Interfaces: `PascalCase` (e.g., `RecoveryRecord`, `SleepCollection`)
- Functions: `camelCase` (e.g., `getRecoveryCollection`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `WHOOP_API_BASE_URL`)
- MCP tool names: `snake_case` (MCP convention, e.g., `get_recovery_collection`)

### Example — Tool Implementation

```typescript
// src/tools/get-recovery.ts
import { z } from "zod";
import { WhoopClient } from "../api/client.js";
import type { RecoveryCollection } from "../api/types.js";

export const getRecoveryCollectionSchema = {
  name: "get_recovery_collection",
  description:
    "Get recovery scores for a date range. Returns HRV, resting heart rate, SpO2, and skin temp for each day.",
  inputSchema: z.object({
    start: z
      .string()
      .optional()
      .describe("Return recoveries after this time (inclusive). ISO 8601 format, e.g. 2026-04-01T00:00:00.000Z"),
    end: z
      .string()
      .optional()
      .describe("Return recoveries before this time (exclusive). ISO 8601 format. Defaults to now."),
    limit: z
      .number()
      .optional()
      .describe("Max records to return (1-25). Defaults to 10."),
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
  return client.get<RecoveryCollection>(
    `/v2/recovery?${searchParams.toString()}`
  );
}
```

### Key Conventions
- Explicit return types on all exported functions
- Zod for tool input validation (MCP SDK convention)
- One tool per file — handler + schema co-located
- No `any` — strict TypeScript throughout
- Errors throw typed errors, never return error codes

## Testing Strategy

| Level | Framework | Location | What it covers |
|-------|-----------|----------|----------------|
| **Unit** | Vitest | `tests/` | OAuth logic, token store, API client, tool handlers |
| **Integration** | Vitest | `tests/` | Tool → API client → mocked HTTP flow |

### Testing Approach
- **Mock the WHOOP API** — Never hit the real API in tests. Use Vitest's `vi.fn()` to mock `fetch` with fixture responses.
- **Test tool schemas** — Validate that each tool's input schema accepts valid inputs and rejects invalid ones.
- **Test OAuth flow** — Mock the token store, test refresh logic, test expired token handling.
- **Test error paths** — Rate limit (429), expired token (401), network errors, malformed responses.
- **Coverage target:** >80% on `src/auth/` and `src/api/`, >70% overall.

### Example Test

```typescript
// tests/tools/get-recovery.test.ts
import { describe, it, expect, vi } from "vitest";
import { getRecoveryCollection } from "../../src/tools/get-recovery.js";
import { WhoopClient } from "../../src/api/client.js";

describe("get_recovery_collection", () => {
  it("fetches recovery data for a date range", async () => {
    const mockClient = {
      get: vi.fn().mockResolvedValue({
        records: [
          {
            cycle_id: 1,
            score: { recovery_score: 78, hrv_rmssd_milli: 45.2 },
          },
        ],
      }),
    } as unknown as WhoopClient;

    const result = await getRecoveryCollection(mockClient, {
      start: "2026-04-01T00:00:00.000Z",
      end: "2026-04-07T00:00:00.000Z",
    });

    expect(mockClient.get).toHaveBeenCalledWith(
      "/v2/recovery?start=2026-04-01T00%3A00%3A00.000Z&end=2026-04-07T00%3A00%3A00.000Z"
    );
    expect(result.records).toHaveLength(1);
    expect(result.records[0].score.recovery_score).toBe(78);
  });
});
```

## Boundaries

### Always:
- Run `npm test` before every commit
- Validate all user/tool input with Zod schemas
- Store tokens in `~/.whoop-mcp/` with `0600` permissions (user-only read/write)
- Include `.env.example` with placeholder values — never commit real credentials
- Return helpful error messages when WHOOP API calls fail (Claude needs to understand what went wrong)

### Ask First:
- Adding any new runtime dependency beyond `@modelcontextprotocol/sdk` and `zod`
- Changing the token storage location or format
- Adding new WHOOP API endpoints not in the MVP scope
- Changing the OAuth flow (e.g., switching to Device Code flow)

### Never:
- Commit `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, or any tokens to version control
- Store tokens in plaintext in a world-readable location
- Make real WHOOP API calls in automated tests
- Skip type checking (`any` usage)
- Remove or skip failing tests without discussion

## API Mapping — MCP Tools ↔ WHOOP Endpoints

> **Note:** WHOOP API uses **v2** endpoints. All date parameters use **ISO 8601 date-time** format (e.g., `2026-04-01T00:00:00.000Z`). Collection endpoints default to `limit=10` (max 25).

| MCP Tool | WHOOP Endpoint | Method | Key Parameters | OAuth Scope |
|----------|---------------|--------|----------------|-------------|
| `get_profile` | `/v2/user/profile/basic` | GET | — | `read:profile` |
| `get_recovery_collection` | `/v2/recovery` | GET | `limit`, `start`, `end`, `nextToken` | `read:recovery` |
| `get_sleep_collection` | `/v2/activity/sleep` | GET | `limit`, `start`, `end`, `nextToken` | `read:sleep` |
| `get_workout_collection` | `/v2/activity/workout` | GET | `limit`, `start`, `end`, `nextToken` | `read:workout` |
| `get_cycle_collection` | `/v2/cycle` | GET | `limit`, `start`, `end`, `nextToken` | `read:cycles` |
| `get_body_measurement` | `/v2/user/measurement/body` | GET | — | `read:body_measurement` |

All collection endpoints support pagination via `nextToken`. For MVP, fetch up to 25 records per call. Automatic pagination can be added in V2.

### WHOOP API Base URL
```
https://api.prod.whoop.com/developer
```

### OAuth URLs
```
Authorization: https://api.prod.whoop.com/oauth/oauth2/auth
Token:         https://api.prod.whoop.com/oauth/oauth2/token
```

### Required Scopes
```
read:recovery read:cycles read:workout read:sleep read:profile read:body_measurement
```

## OAuth2 Flow

```
1. User runs `npx whoop-mcp` for the first time
2. Server checks ~/.whoop-mcp/tokens.json
3. No tokens found → start OAuth flow:
   a. Start temporary HTTP server on localhost:3000/callback
   b. Open browser to WHOOP authorization URL
   c. User authorizes → WHOOP redirects to localhost:3000/callback?code=XXX
   d. Exchange code for access_token + refresh_token
   e. Save tokens to ~/.whoop-mcp/tokens.json (0600 permissions)
   f. Shut down temporary HTTP server
4. Tokens found → validate:
   a. If access_token valid → use it
   b. If expired → use refresh_token to get new access_token
   c. If refresh_token expired → restart OAuth flow (step 3)
5. Server starts in stdio mode, ready for MCP tool calls
```

## Environment Variables

```bash
# .env.example
WHOOP_CLIENT_ID=your_client_id_here
WHOOP_CLIENT_SECRET=your_client_secret_here
WHOOP_REDIRECT_URI=http://localhost:3000/callback
```

## Claude Desktop Configuration

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "whoop": {
      "command": "npx",
      "args": ["whoop-mcp"],
      "env": {
        "WHOOP_CLIENT_ID": "your_client_id",
        "WHOOP_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

## Open Questions
- Does WHOOP's OAuth require PKCE or is plain Authorization Code sufficient?
- What's the rate limit? (API returns 429 — need to know threshold for retry strategy)
- Is `zod` already a peer dependency of `@modelcontextprotocol/sdk` or do we need to add it separately?
- What are the exact token lifetimes for access and refresh tokens?
