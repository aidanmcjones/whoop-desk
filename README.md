# WhoopDesk

A small personal Mac dock app that shows a WHOOP recovery/strain dashboard
in a native-feeling Electron window. Built for personal use only — not
affiliated with or endorsed by WHOOP.

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

## Where tokens come from

WhoopDesk doesn't handle WHOOP OAuth itself. It reads already-authenticated
tokens from `~/.whoop-mcp/tokens.json`, which are produced by the
`whoop-mcp` OAuth flow. Run that flow first (see the whoop-mcp project) to
populate the tokens file; WhoopDesk just reads from it.

## Personal use

This is a personal project for a single user's own WHOOP account. It is not
intended for distribution, does not use any WHOOP branding/trademarks, and
should not be treated as an official WHOOP product.
