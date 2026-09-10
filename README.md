# WhoopDesk

A personal desktop dashboard for a WHOOP account, in a native-feeling
Electron window (1280x820 by default, 1024x700 minimum, resizes freely).
Sections: Overview, Sleep, Strain, Health and Trends. Built for personal
use only — not affiliated with or endorsed by WHOOP.

## Running

```
npm install
npm start
```

## Smoke test

Renders the app off-screen, waits for it to settle, saves a screenshot to
`smoke.png`, and prints any renderer console errors:

```
npm run smoke
```

`--size=WIDTHxHEIGHT` shoots a different window size and `--view=<section>`
(sleep, strain, health, trends) shoots a section other than the Overview:

```
npm run smoke -- --size=1024x700 --view=trends
```

## Where tokens come from

WhoopDesk doesn't handle WHOOP OAuth itself. It reads already-authenticated
tokens from `~/.whoop-mcp/tokens.json`, which are produced by the
`whoop-mcp` OAuth flow. Run that flow first (see the whoop-mcp project) to
populate the tokens file; WhoopDesk just reads from it.

## Personal use

This is a personal project for a single user's own WHOOP account. It is not
intended for distribution, does not use any WHOOP branding/trademarks, and
should not be treated as an official WHOOP product.

## Relationship to whoop-mcp

`vendor/whoop-mcp` is a vendored copy of the MIT-licensed WHOOP MCP server
(this user's fork of whoop-ai-mcp). Its OAuth flow is what produces
`~/.whoop-mcp/tokens.json`; WhoopDesk itself only reads those tokens and
never performs OAuth on its own. If the tokens are lost or expire, re-run
the OAuth flow via the vendored server in `vendor/whoop-mcp` to regenerate
them.
