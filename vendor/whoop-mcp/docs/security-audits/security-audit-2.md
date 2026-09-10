# Security Audit Report #2

> **Auditor:** Security Auditor Agent (Security Engineer)
> **Date:** 2026-04-12
> **Scope:** Full codebase — `src/auth/`, `src/api/`, `src/server.ts`, `src/tools/`, `src/index.ts`
> **Dependencies:** 0 known vulnerabilities (`npm audit` clean)

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 3 |
| Info | 4 |

---

## Previous Audit Findings Status

All 8 tracked findings from Security Audit #1 (2026-04-11) were reviewed:

| Finding | Status |
|---------|--------|
| HIGH-1: OS command injection via `exec()` in `openBrowser` | ✅ **FIXED** — `spawn` with arg arrays now used |
| HIGH-2: Reflected XSS in OAuth callback error page | ✅ **FIXED** — `escapeHtml()` added; XSS is mitigated |
| MEDIUM-1: No request timeout on API client | ✅ **FIXED** — `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` in place |
| MEDIUM-2: Retry-After header not capped | ✅ **FIXED** — `MAX_RETRY_AFTER_MS = 60_000` caps the delay |
| MEDIUM-3: Callback server binds to `0.0.0.0` | ✅ **FIXED** — `server.listen(port, "127.0.0.1", ...)` |
| LOW-1: No token shape validation on load | ✅ **FIXED** — `isValidTokenShape()` guard added |
| LOW-2: OAuth flow does not use PKCE | ⚠️ **OPEN** — Acknowledged as known limitation in `SECURITY.md` |
| LOW-3: No `server.on('error')` handler | ✅ **FIXED** — `EADDRINUSE` handler with user-friendly message added |

---

## Findings

### [LOW-1] Missing security response headers on OAuth callback server

- **Location:** `src/auth/callback-server.ts:57-71` (`SUCCESS_HTML`, `errorHtml`)
- **Description:** The callback server HTML responses (`200 OK` and `400 Bad Request`) do not include browser security headers such as `Content-Security-Policy` or `X-Content-Type-Options`. The XSS fix from Audit #1 (`escapeHtml`) mitigates the immediate risk, but without CSP the browser has no enforcement layer if a future regression introduces an unescaped value.
- **Impact:** Defense-in-depth gap. A future developer adding a new query parameter to the error response that forgets to escape it would have no safety net. Additionally, without `X-Content-Type-Options: nosniff`, older browsers could MIME-sniff the HTML response.
- **Proof of concept:** Not currently exploitable given the `escapeHtml` fix. Risk is residual/future regression.
- **Recommendation:** Add security headers to all callback server HTTP responses:
  ```typescript
  const SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
  };

  // In the request handler, before res.writeHead:
  res.writeHead(200, { "Content-Type": "text/html", ...SECURITY_HEADERS });
  ```

### [LOW-2] Windows browser-launch routes URL through `cmd.exe` argument parsing

- **Location:** `src/auth/oauth.ts:193-200` (`openBrowser`)
- **Description:** On Windows, `openBrowser` spawns `["cmd", ["/c", "start", url]]`. While `spawn` avoids shell string injection, the URL argument is still processed by `cmd.exe`, which applies its own argument parsing rules. The `start` command in cmd.exe treats the first quoted string as a window title rather than a URL, which can cause subtle misbehavior.
- **Impact:** Low. In practice the WHOOP authorization URL produced by `buildAuthorizationUrl` is percent-encoded via `new URL()` + `searchParams.set()`, meaning characters that `cmd.exe` would interpret specially (`&`, `|`, `^`, `"`) are encoded to `%26`, `%7C`, `%5E`, `%22`. This prevents code execution. However, cmd.exe may still misparse the URL as a window title vs. target, causing the browser launch to silently fail on Windows.
- **Proof of concept:** Not exploitable given URL encoding. Functional impact: On Windows, `cmd /c start "https://..."` treats `"https://..."` as the window title — subsequent silent failure or launching the wrong app is possible.
- **Recommendation:** Use PowerShell for a safer Windows browser-open, or add an empty-string title argument to `start`:
  ```typescript
  win32: ["cmd", ["/c", "start", '""', url]],
  // The empty "" is treated as the window title; url is the target
  ```
  Alternatively, use PowerShell:
  ```typescript
  win32: ["powershell", ["-NoProfile", "-Command", `Start-Process '${url}'`]],
  ```
  Note: the PowerShell approach still requires verifying the URL does not contain single quotes (which are safe after URLSearchParams encoding).

### [LOW-3] PKCE not implemented in OAuth flow (carried over from Audit #1)

- **Location:** `src/auth/oauth.ts:59-72` (`buildAuthorizationUrl`), `src/auth/oauth.ts:84-117` (`exchangeCodeForTokens`)
- **Description:** The OAuth Authorization Code flow does not use PKCE (Proof Key for Code Exchange). PKCE prevents authorization code interception attacks where a malicious app on the same machine intercepts the callback redirect before this server processes it. This finding was LOW-2 in Audit #1 and is carried forward as unresolved.
- **Impact:** Low for this specific context — the `state` CSRF token and localhost-only binding provide partial mitigation. On a multi-user machine or in a compromised environment where another app registers the same URI scheme, a code interception attack is theoretically possible.
- **Recommendation:** Add PKCE (S256 method) if WHOOP's authorization server supports it:
  ```typescript
  import { createHash, randomBytes } from "node:crypto";

  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Pass codeVerifier in exchangeCodeForTokens body:
  body.set("code_verifier", codeVerifier);
  ```
  This is already acknowledged as a known limitation in `SECURITY.md`.

### [INFO-1] OAuth state value included in CSRF error message (logged to stderr on fatal error)

- **Location:** `src/auth/callback-server.ts:147-153`
- **Description:** The state mismatch error message includes the expected state value verbatim: `State mismatch: expected "${options.expectedState}", got "${state}"`. This error propagates through `performOAuthFlow` → `authenticate` → `main()`, where it is written to stderr by `console.error("Fatal error:", error)`.
- **Impact:** Informational. The state parameter is single-use (consumed at callback receipt), so an attacker who sees this error in stderr logs gains no actionable information. However, security-sensitive values should not appear in log output as a general principle.
- **Recommendation:** Remove the expected state value from the error message:
  ```typescript
  reject(new Error("State parameter mismatch — possible CSRF attack. Restart the authentication flow."));
  ```

### [INFO-2] Unvalidated date string parameters in collection tool inputs

- **Location:** `src/server.ts:46-69` (`collectionInputSchema`)
- **Description:** The `start` and `end` query parameters are declared as `z.string().optional()` — any non-empty string is accepted. Passing an invalid date (e.g., `"not-a-date"`) triggers a WHOOP API error that is caught and returned as a `WhoopApiError`. There is no client-side format validation.
- **Impact:** Informational. Invalid inputs cause unnecessary API calls and return unhelpful error messages to the AI assistant. No security risk.
- **Recommendation:** Add ISO 8601 datetime validation:
  ```typescript
  start: z.string().datetime({ offset: true }).optional().describe(...)
  end: z.string().datetime({ offset: true }).optional().describe(...)
  ```

### [INFO-3] `getPackageVersion()` uses synchronous file I/O on startup

- **Location:** `src/server.ts:29-37` (`getPackageVersion`)
- **Description:** `readFileSync` is called synchronously during server initialization to read `package.json`. This blocks the Node.js event loop for the duration of the file read.
- **Impact:** Not a security concern. Negligible performance impact for a startup-time operation.
- **Recommendation:** Consider using `await readFile()` in an async initialization path if startup latency becomes a concern in future. No immediate action required.

### [INFO-4] `client_secret` transmitted in POST body (vs. HTTP Basic Auth)

- **Location:** `src/auth/oauth.ts:88-100` (`exchangeCodeForTokens`), `src/auth/oauth.ts:128-143` (`refreshAccessToken`)
- **Description:** `client_secret` is sent in the `application/x-www-form-urlencoded` POST body rather than via HTTP Basic Authentication. Both methods are permitted by OAuth 2.0 (RFC 6749 §2.3.1) and the transport is HTTPS, so the secret is protected in transit.
- **Impact:** No current risk. HTTP Basic Auth for client credentials is slightly preferred by some security guidelines (OAuth 2.0 Security Best Current Practice §2.4) because it avoids the secret appearing in server-side request logs that capture POST bodies.
- **Recommendation:** Consider migrating to HTTP Basic Auth:
  ```typescript
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
  },
  // Remove client_id and client_secret from the body
  ```
  Only apply if WHOOP's token endpoint supports Basic Auth client authentication.

---

## Positive Observations

- **All High and Medium findings from Audit #1 were fully resolved.** All 5 High/Medium fixes are correctly implemented and verified: `spawn` for browser launch, `escapeHtml` for XSS, `AbortSignal.timeout`, `MAX_RETRY_AFTER_MS`, and `127.0.0.1` binding. This demonstrates an effective remediation process.

- **`isValidTokenShape` properly validates the token file structure.** The implementation guards against corrupted or tampered `tokens.json` files, throwing early rather than propagating `undefined` property errors. The `token_type` field is deliberately not required, which is a sound design choice.

- **SECURITY.md is accurate and complete.** The security policy correctly documents the OAuth design, token storage, credential handling, and known limitations (PKCE). The documented behaviors match the actual implementation.

- **`server.on("error")` handler added correctly.** The `EADDRINUSE` case produces a human-readable message, and the `settled` guard prevents double-rejection on concurrent events.

- **Zero runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod`.** The minimal dependency footprint significantly reduces the supply-chain attack surface. `npm audit` reports 0 vulnerabilities.

- **No secrets in source code or git history.** `git log` confirms that `tokens.json` and `.env` files have never been committed. All credential access goes through environment variables.

---

## Action Items (Priority Order)

| # | Severity | Finding | Recommendation |
|---|----------|---------|----------------|
| 1 | Low | Missing security headers on callback server HTML | Add CSP, X-Content-Type-Options, X-Frame-Options |
| 2 | Low | Windows `cmd /c start` lacks empty title guard | Add `""` title arg or switch to PowerShell |
| 3 | Low | PKCE not implemented (carried over) | Add S256 PKCE if WHOOP supports it |
| 4 | Info | State value in CSRF error message | Remove state from error text |
| 5 | Info | No ISO 8601 validation on date params | Use `z.string().datetime()` in Zod schema |
| 6 | Info | Synchronous `readFileSync` at startup | Low priority; convert to async if needed |
| 7 | Info | `client_secret` in POST body | Consider HTTP Basic Auth if WHOOP supports it |
