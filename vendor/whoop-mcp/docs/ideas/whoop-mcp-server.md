# WHOOP MCP Server

## Problem Statement
How might we give AI assistants native access to WHOOP health data, so developers (and ourselves) can query recovery, sleep, strain, and workout data through natural conversation — without any existing industry-standard solution?

## Recommended Direction
Build a **thin, typed, OAuth2-authenticated MCP server** that maps WHOOP REST API endpoints 1:1 to MCP tools. Follow the conventions set by GitHub's official MCP server: TypeScript, `@modelcontextprotocol/sdk`, `stdio` transport, Claude Desktop compatible, npm-publishable.

The server handles exactly two hard problems — **OAuth2 token lifecycle** (authorize, store, refresh) and **clean tool schemas** (so Claude understands what each tool returns without drowning in untyped JSON). Everything else is a thin pass-through. The AI model does all the reasoning; the server just connects the pipe.

This positions `whoop-mcp` as the reference WHOOP integration for the MCP ecosystem. Ship quality (types, tests, docs, error handling) over feature breadth. A server with 6 solid tools beats one with 15 flaky ones.

## Key Assumptions to Validate
- [ ] **WHOOP API access is available with a standard developer account** — Create an app at developer.whoop.com, obtain OAuth credentials, and successfully hit `/v1/recovery`, `/v1/sleep`, `/v1/workout` endpoints. Do this before writing any code.
- [ ] **OAuth2 refresh tokens have a reasonable lifetime** — Authenticate, wait 24h, attempt a token refresh. Check WHOOP docs for explicit token TTL. If refresh tokens expire after short inactivity, the server needs a re-auth flow.
- [ ] **Claude reasons well over raw WHOOP JSON responses** — Paste a real WHOOP API response (recovery, sleep) into Claude and ask a health question. If responses are too verbose/nested, you'll need response shaping — know this upfront.
- [ ] **MCP `stdio` transport + Claude Desktop works for OAuth flows** — The initial OAuth browser redirect needs to work alongside a stdio-based MCP server. Confirm the pattern (local HTTP callback server for the auth code) works in Claude Desktop's lifecycle.

## MVP Scope

### Day 1: Foundation + Core Tools
| Task | Detail |
|------|--------|
| **Project scaffold** | TypeScript, `@modelcontextprotocol/sdk`, tsconfig, ESLint, Vitest, npm scripts |
| **OAuth2 module** | Authorization Code flow, token storage (file-based `~/.whoop-mcp/tokens.json`), automatic refresh, local callback server for auth |
| **Tool: `get_profile`** | `/v1/user/profile/basic` — User's WHOOP profile |
| **Tool: `get_recovery_collection`** | `/v1/recovery` — Recovery scores with date range filter |
| **Tool: `get_sleep_collection`** | `/v1/sleep` — Sleep records with date range filter |
| **Tool: `get_workout_collection`** | `/v1/workout` — Workouts with date range filter |

### Day 2: Complete + Ship
| Task | Detail |
|------|--------|
| **Tool: `get_cycle_collection`** | `/v1/cycle` — Physiological cycles with date range filter |
| **Tool: `get_body_measurement`** | `/v1/body_measurement` — Body measurements |
| **Error handling** | Rate limit retry, expired token re-auth prompt, clear error messages for Claude |
| **Tests** | Unit tests for OAuth module, tool schema validation, mocked API response tests |
| **Documentation** | README with: what it does, quickstart (Claude Desktop config), all available tools, env setup, contributing guide |
| **Publish** | npm package, Claude Desktop `mcp.json` example, GitHub release |

### What "Done" Looks Like
You open Claude Desktop, type **"How was my recovery this week?"**, and Claude calls `get_recovery_collection` with the right date range, gets your real WHOOP data, and gives you a useful answer. No copy-pasting, no screenshots, no manual API calls.

## Not Doing (and Why)
- **Weekly digest / aggregation tools** — The AI model can compute averages and trends from raw data. Pre-aggregating adds opinionated logic and maintenance burden. Ship raw, let Claude reason. (Future V2 candidate)
- **MCP Resources (ambient context)** — Exposing profile/recovery as always-available context is a great UX upgrade, but adds complexity to the MVP auth flow. Tools-only for now. (Future V2 candidate)
- **Webhook ingestion / local cache** — Eliminates redundant API calls but requires persistent storage and a webhook endpoint. Way too much infra for a weekend. (Future V3)
- **Multi-user / multi-tenant support** — Coach/team use case is real but requires a fundamentally different auth model. Single-user only. (Future V3)
- **Response shaping / transformation** — Pass raw WHOOP JSON through with typed schemas. If Claude struggles with verbose responses, add shaping later based on real usage.
- **HTTP/SSE transport** — `stdio` is the Claude Desktop standard. HTTP transport is for cloud deployments — out of scope for MVP.
- **CI/CD pipeline** — Nice to have, but not for a weekend. Manual publish is fine for V1.

## Open Questions
- What scopes does WHOOP grant to standard developer accounts? (Determines which tools are actually possible)
- What is the refresh token TTL? (Determines whether you need a re-auth UX or if "authenticate once" works)
- Does WHOOP enforce per-endpoint rate limits or a global limit? (Determines whether you need per-tool throttling)
- What's the npm package name availability? (`whoop-mcp`, `@whoop/mcp`, `mcp-whoop`?)
- Should the token store support OS keychain (macOS Keychain, etc.) or is a dotfile sufficient for V1?

## Future Roadmap (Parked Ideas)
| Version | Feature | Variation |
|---------|---------|-----------|
| **V2** | Weekly digest tools (`get_weekly_summary`, `compare_weeks`) | Variation 2 |
| **V2** | MCP Resources for ambient health context | Variation 4 |
| **V3** | Webhook + SQLite cache for instant offline queries | Variation 3 |
| **V3** | Multi-user support for coaches/teams | Variation 5 |
| **V3** | Analytical tools (`correlate_sleep_strain`, `detect_trend`) | Variation 6 |
