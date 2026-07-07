# RewindRewind setup for AI agents (Claude / Codex)

Paste this whole block into your agent. It is self-contained: it tells the agent
where to get the CLI, how to authenticate, and how to do everything from there.

---

You are setting up **RewindRewind** (error + event tracking, like Sentry + PostHog)
in this project, using its CLI. Do it in this exact order.

## Step 0 — Get the CLI

No install needed — run it straight from the public repo:

```sh
npx github:bananatron/rewindrewindcli <command>
```

Optionally install it for a persistent `rewindrewind` (and `rr`) command:

```sh
npm install -g github:bananatron/rewindrewindcli
```

In the steps below, `rewindrewind <command>` means `npx github:bananatron/rewindrewindcli <command>`
(or the installed `rewindrewind` command).

## Step 1 — Verify we have an API key (do this FIRST)

```sh
rewindrewind status --json
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

Re-run `rewindrewind status --json` and confirm `ready: true` before moving on.

## Step 2 — Initialize

```sh
rewindrewind init --json
```

This finds the project, fetches its **public project key** (`rrpub_…`), saves the
config, and returns setup metadata. Run `rewindrewind init` without `--json` when
you want the human copy-paste setup for all three surfaces. Wire whichever surfaces
this project needs into the codebase.

For runtime-specific SDK instructions, ask the CLI instead of guessing:

```sh
rewindrewind help sdk
rewindrewind help sdk node
rewindrewind help sdk browser
rewindrewind help sdk python
rewindrewind sdk show node --pretty
rewindrewind sdk primitives node --pretty
rewindrewind sdk doctor --pretty
rewindrewind sdk upgrade --pretty
```

## Step 3 — Verify it works

```sh
rewindrewind verify --json
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
rewindrewind help       agent | auth | sdk | events | exceptions | troubleshooting
rewindrewind sdk        list | show <name> | primitives <name> | doctor [name] | upgrade [name] | snippet <name> | env
rewindrewind projects   list | create | get | update | delete
rewindrewind events     send | batch | list | raw
rewindrewind exceptions send
rewindrewind issues     list | get | update | resolve | reopen | ignore | snooze | lifecycle
rewindrewind comments   list | create | update | delete
rewindrewind sourcemaps upload
rewindrewind export | ingestion-health | retention run
rewindrewind health | openapi
# Escape hatch for ANY endpoint (auto-picks the right key by path):
rewindrewind api <get|post|patch|delete> <path> [--data <json|@file|->] [--query k=v]
```

Output is human-readable by default. Add `--json` for compact JSON on stdout,
`--pretty` for readable JSON, or `--quiet` to silence normal output.

## Docs

- Setup guide: https://rewindrewind.com/docs/exception-capture-sdk
- OpenAPI: https://rewindrewind.com/openapi.json
- Agent/LLM index: https://rewindrewind.com/llms.txt
- CLI directory: `rewindrewind --help`
- Structured CLI help: `rewindrewind --help --json`
