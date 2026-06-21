# RewindRewind setup for AI agents (Claude / Codex)

Paste this whole block into your agent. It is self-contained: it tells the agent
where to get the CLI, how to authenticate, and how to do everything from there.

---

You are setting up **RewindRewind** (error + event tracking, like Sentry + PostHog)
in this project, using its CLI. Do it in this exact order.

## Step 0 — Get the CLI

No install needed. Use one of these to run it (`rr` is a short alias):

```sh
# Works today, straight from the public repo:
npx -p github:bananatron/rewindrewindcli rewindrewind <command>
# Or, once published to npm:
npx @rewindrewind/cli <command>          # or: npm i -g @rewindrewind/cli
```

In the steps below, `rewindrewind` means whichever form above you chose.

## Step 1 — Verify we have an API key (do this FIRST)

```sh
rewindrewind status
```

Read the JSON. **If `needs_api_key` is `true`, STOP and ask the user:**

> I need a RewindRewind **admin API key** to continue. It starts with `rr_`.
> Create one in your RewindRewind dashboard under **API keys**, then paste it here.

Do not guess or fabricate a key. Once the user provides it, configure it (pick one):

```sh
rewindrewind configure --api-key rr_xxx                 # store inline
rewindrewind config set api-key-file /path/to/keyfile   # or point at a file
export REWINDREWIND_API_KEY=rr_xxx                       # or just use env
```

Re-run `rewindrewind status` and confirm `ready: true` before moving on.

## Step 2 — Initialize

```sh
rewindrewind init
```

This finds the project, fetches its **public project key** (`rrpub_…`), saves the
config, and prints copy-paste setup for all three surfaces. Wire whichever surfaces
this project needs into the codebase.

## Step 3 — Verify it works

```sh
rewindrewind verify
```

This sends a test event and exception and confirms they landed. Expect `ok: true`.

---

## How the keys work

- **Admin key** (`rr_…`) — secret, for the CLI and management API. Never put it in
  client code.
- **Project key** (`rrpub_…`) — **public, like a Sentry DSN.** Used to send data and
  safe to embed in browsers and servers. `init` fetches it for you.

## The three surfaces

1. **Front-end exceptions** — `<script src="https://rewindrewind.com/sdk/v1/rewind.js">`
   then `RewindRewind.init({ key: "rrpub_…" })`. Auto-captures uncaught errors and
   unhandled rejections.
2. **Back-end exceptions** — `npm i @rewindrewind/sdk` (Node/Bun), `gem "rewind_rewind"`
   (Ruby), or the Python helper. Or send from the CLI: `rewindrewind exceptions send`.
3. **App events** — `rewind.captureEvent("checkout.completed", { total: 42 })` in code,
   or `rewindrewind events send --type checkout.completed --properties '{"total":42}'`.

## Primitives — you can do EVERYTHING from the CLI

```sh
rewindrewind projects   list | create | get | update | delete
rewindrewind events     send | batch | list | raw
rewindrewind exceptions send
rewindrewind issues     list | get | update | resolve | reopen | snooze | archive | lifecycle
rewindrewind comments   list | create | update | delete
rewindrewind sourcemaps upload
rewindrewind export | ingestion-health | retention run
rewindrewind health | openapi
# Escape hatch for ANY endpoint (auto-picks the right key by path):
rewindrewind api <get|post|patch|delete> <path> [--data <json|@file|->] [--query k=v]
```

Output is JSON on stdout (human guidance goes to stderr), so every command is
scriptable. Add `--format pretty` to read it, `--quiet` to silence it.

## Docs

- Setup guide: https://rewindrewind.com/docs/exception-capture-sdk
- OpenAPI: https://rewindrewind.com/openapi.json
- Agent/LLM index: https://rewindrewind.com/llms.txt
- CLI help: `rewindrewind --help`
