# RewindRewind setup for AI agents (Claude / Codex)

Paste this whole block into your agent. It is self-contained: it tells the agent
where to get the CLI, how to authenticate, and how to do everything from there.

---

You are setting up **RewindRewind** (error + event tracking, like Sentry + PostHog)
in this project, using its CLI. Do it in this exact order.

## Step 0 — Get the CLI

No install needed — run it from the public GitHub repository:

```sh
npx github:rewind-rewind/rewindrewindcli <command>
```

Optionally install it for a persistent `rewindrewind` (and `rr`) command:

```sh
npm install -g github:rewind-rewind/rewindrewindcli
```

In the steps below, `rewindrewind <command>` means `npx github:rewind-rewind/rewindrewindcli <command>`
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

This sends a test event and exception, confirms the event, and validates support
routing/auth without creating an inbox request. Expect `ok: true`.

The `event confirmed in project` check reads the event back through the management
API. It needs an admin key, and a project id — taken from `--project`,
`REWINDREWIND_PROJECT_ID`, config, or resolved from the configured project key.
Ingestion is async, so the read-back retries for a few seconds before reporting a
miss; a miss is a soft warning (`skip`), not a failure.

## Keep the CLI current

```sh
rewindrewind update --check --json
rewindrewind update --yes
rewindrewind doctor --json
rewindrewind doctor --fix
```

Ordinary human commands use a 24-hour cached release check and print a short
notice when a newer semantic version is available. Structured `status` and
`init` results include `cli_update`; other JSON output is unchanged.

---

## How the keys work

- **Admin key** (`rr_…`) — secret, for the CLI and management API. Never put it in
  client code.
- **Project key** (`rrpub_…`) — **public, like a Sentry DSN.** Used to send data and
  safe to embed in browsers and servers. `init` fetches it for you.

## The three surfaces

1. **Front-end exceptions** — paste the async pre-load loader from
   `rewindrewind sdk snippet browser` into `<head>`, then
   `RewindRewind.init({ key: "rrpub_…" })` in the same inline script. Auto-captures
   uncaught errors, framework errors reported through a direct `window.onerror`
   call (Stimulus, Vue, jQuery), and unhandled rejections. Don't hand out a bare
   `<script src>` + init pair: the bundle loads async, so the init can run first
   and throw, and errors during the load window are lost.
2. **Back-end exceptions** — `npm i @rewindrewind/sdk` (Node/Bun), `gem "rewind_rewind"`
   (Ruby), or the Python helper. Or send from the CLI: `rewindrewind exceptions send`.
3. **App events** — `rewind.captureEvent("checkout.completed", { total: 42 })` in code,
   or `rewindrewind events send --type checkout.completed --properties '{"total":42}'`.

## Primitives — you can do EVERYTHING from the CLI

```sh
rewindrewind help       agent | auth | sdk | events | exceptions | visits | support | health | metrics | noise | notifications | members | sourcemaps | troubleshooting
rewindrewind sdk        list | show <name> | primitives <name> | doctor [name] | upgrade [name] | snippet <name> | env
rewindrewind projects   list | create | get | update | delete
rewindrewind members    list | invite | role | remove
rewindrewind invites    list | get | resend | revoke
rewindrewind support    submit | list | get | reply | note | edit-note | status | assign | settings [update] | erase
rewindrewind noise      catalog | catalog-set | list | get | preview | create | update | disable | enable | matches
rewindrewind notifications get | update | environment
rewindrewind project-health get | evaluate
rewindrewind health-rules list | get | create | update | delete
rewindrewind metrics    list | get | create | update | delete | evaluate
rewindrewind event-types list
rewindrewind visits     send | list
rewindrewind usage      get
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

## Inviting teammates

Members are `admin` (account settings, billing, API keys, members) or `member`
(projects and issues):

```sh
rewindrewind members invite --email teammate@example.com --role member
rewindrewind invites list --status pending
```

An invited email that already has a RewindRewind user joins immediately; a new
one joins when it uses the emailed link, which expires in 24 hours. Each invite
tracks as `pending`, `accepted`, or `expired`; `invites resend` and
`invites revoke` act on a pending one.

## Docs

- Setup guide: https://rewindrewind.com/docs/exception-capture-sdk
- OpenAPI: https://rewindrewind.com/openapi.json
- Agent/LLM index: https://rewindrewind.com/llms.txt
- CLI directory: `rewindrewind --help`
- Structured CLI help: `rewindrewind --help --json`
