# @rewindrewind/cli

The RewindRewind command line. Built for humans and agents: no runtime dependencies, JSON output by default, and one command (`init`) that sets up all three surfaces — **front-end exceptions, back-end exceptions, and app events** — from a single key.

## Install

Run without installing (best for one-off setup and agents):

```sh
npx @rewindrewind/cli init
```

Install globally for a persistent `rewindrewind` (and `rr`) command:

```sh
npm install -g @rewindrewind/cli
rewindrewind --help
```

## For AI agents (Claude / Codex)

Setting this up from an agent? Paste [`AGENTS.md`](AGENTS.md) into your agent — it is a
self-contained runbook. The flow, in order:

1. **Verify a key first:** `rewindrewind status`. If `needs_api_key` is `true`, the agent
   must stop and ask the user for an `rr_` admin key — never fabricate one.
2. `rewindrewind init` — configure the project and fetch its public key.
3. `rewindrewind verify` — confirm all three surfaces work.

After a key is configured, the agent can do **everything** through the CLI (JSON in, JSON
out), including the generic `api` escape hatch for any endpoint.

## Two kinds of key

RewindRewind has two keys, and the CLI picks the right one for each command automatically:

- **Admin key** (`rr_…`) — for the CLI and system management: projects, issues, querying events, export, retention. It is a **secret**; keep it out of client code.
- **Project key** (`rrpub_…`) — how you authenticate *into a project* to send data (events, exceptions, source maps). It is **public by design, like a Sentry DSN** — safe to embed in browsers and servers.

You only need to paste the admin key. `init` reads the project key from the API for you.

## Setup

```sh
rewindrewind init --api-key rr_xxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`init` finds your project, fetches its public project key, writes the config, and prints copy-paste setup for all three surfaces with your real key filled in. Then confirm it works:

```sh
rewindrewind verify
```

`verify` sends a test app event and a test exception with the project key, then confirms the event landed via the admin API — reporting pass/fail per surface.

### Where the key lives

Paste the key inline, or **point the CLI at a file** that holds it (so it can rotate on disk and never sits in your shell history) — setting that pointer is a CLI action:

```sh
# Inline
rewindrewind configure --api-key rr_xxx

# Pointer to a file containing the key (long-term auth)
rewindrewind config set api-key-file /run/secrets/rewindrewind_admin_key
```

The config file is written to `~/.config/rewindrewind/config.json` (mode 600).

For CI and agents, environment variables work too:

```sh
export REWINDREWIND_API_KEY=rr_xxxxx...          # admin key (or _FILE for a path)
export REWINDREWIND_PROJECT_KEY=rrpub_xxxxx...   # project key (or _FILE for a path)
export REWINDREWIND_PROJECT_ID=PROJECT_ID
export REWINDREWIND_BASE_URL=https://rewindrewind.com
```

Resolution order per key kind: `--flag` → `--flag-file` → `ENV` → `ENV_FILE` → config inline → config file pointer. `REWINDREWIND_BASE_URL` defaults to `https://rewindrewind.com`.

## The three surfaces

**Front-end exceptions** — two tags, no build step (auto-captures uncaught errors and unhandled rejections):

```html
<script src="https://rewindrewind.com/sdk/v1/rewind.js"></script>
<script>
  RewindRewind.init({ key: "rrpub_xxx", environment: "production" });
</script>
```

**Back-end exceptions** — Node/Bun (`npm i @rewindrewind/sdk`), Ruby (`gem "rewind_rewind"`), or the Python helper. Or send straight from the CLI:

```sh
rewindrewind exceptions send --message "Stripe webhook failed" --level error --environment production
```

**App events** — from code (`rewind.captureEvent(...)`) or the CLI:

```sh
rewindrewind events send --type checkout.completed --properties '{"plan":"pro","amount":4900}'
```

## Common commands

```sh
rewindrewind health
rewindrewind events list --environment production --limit 50
rewindrewind events raw EVENT_ID
rewindrewind issues list --status open
rewindrewind issues get ISSUE_ID
rewindrewind issues resolve ISSUE_ID --reason "fixed in web@1.4.3"
rewindrewind issues reopen ISSUE_ID
rewindrewind issues snooze ISSUE_ID
rewindrewind issues archive ISSUE_ID
rewindrewind issues lifecycle ISSUE_ID
rewindrewind issues update ISSUE_ID --status ignored
rewindrewind comments create ISSUE_ID --body "Deployed fix."
rewindrewind sourcemaps upload --release web@1.4.2 --file dist/app.js.map --file-name app.js.map
rewindrewind export --limit 500 --include-raw
rewindrewind ingestion-health
rewindrewind retention run
```

## Projects

```sh
rewindrewind projects list
rewindrewind projects create --name "New App"
rewindrewind projects get
rewindrewind projects update --name "Production Web" --retention-days 90
rewindrewind projects delete
```

Project-scoped commands take the project from `--project`, `REWINDREWIND_PROJECT_ID`, or the configured `projectId`.

## Generic API wrapper

`api` reaches any endpoint, so nothing in the API is out of reach. It auto-selects the key by path (`/v1/*` → project key, everything else → admin key):

```sh
rewindrewind api get /api/projects/PROJECT_ID/issues --query status=open --query limit=25
rewindrewind api patch /api/projects/PROJECT_ID/issues/ISSUE_ID --data '{"status":"ignored"}'
rewindrewind api post /v1/events --data @event.json
rewindrewind api get /openapi.json --no-auth
```

`--data` accepts inline JSON, `@file`, or `-` for stdin.

## Output

JSON on stdout by default (human guidance goes to stderr, so piped output stays clean):

```sh
rewindrewind events list --limit 1 --format pretty   # pretty-print
rewindrewind retention run --quiet                   # suppress output
rewindrewind issues list --verbose                   # log request URLs to stderr
```

## Development

```sh
npm test
npm run lint
```

This project intentionally has no runtime dependencies. Keep the CLI thin: validate obvious local input, send fast HTTP requests, and preserve RewindRewind API responses for agents and scripts.
