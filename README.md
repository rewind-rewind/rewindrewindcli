# rewindrewindcli

The RewindRewind command line. Built for humans and agents: no runtime dependencies, human-readable output by default, explicit JSON for automation, and one command (`init`) that sets up all three surfaces — **front-end exceptions, back-end exceptions, and app events** — from a single key.

The SDK help is agent-ready: it explains the primitives an agent needs to map into a project (`initialize-client`, request/job exception capture, app events, flush), while keeping framework-specific guidance as compact hook hints instead of trying to codify every framework.

## Install

Run without installing, straight from this public repo (best for one-off setup and agents):

```sh
npx github:bananatron/rewindrewindcli init
```

Install globally for a persistent `rewindrewind` (and `rr`) command:

```sh
npm install -g github:bananatron/rewindrewindcli
rewindrewind --help
```

## Help system

`rewindrewind --help` is the top-level directory: first-run flow, help topics,
SDK setup guides, commands, and global options. Drill in from there:

```sh
rewindrewind help agent
rewindrewind help auth
rewindrewind help sdk
rewindrewind help sdk node
rewindrewind help sdk python
rewindrewind help troubleshooting
```

Agents can request structured help:

```sh
rewindrewind --help --json
rewindrewind help sdk node --json
rewindrewind sdk list --json
rewindrewind sdk show python --json
rewindrewind sdk primitives rails --json
rewindrewind sdk doctor --json
rewindrewind sdk upgrade --json
rewindrewind sdk snippet browser --json
```

## For AI agents (Claude / Codex)

Setting this up from an agent? Paste [`AGENTS.md`](AGENTS.md) into your agent — it is a
self-contained runbook. The flow, in order:

1. **Verify a key first:** `rewindrewind status --json`. If `needs_api_key` is `true`, the agent
   must stop and ask the user for an `rr_` admin key — never fabricate one.
2. `rewindrewind init --json` — configure the project and fetch its public key.
3. `rewindrewind verify --json` — confirm all three surfaces work.

After a key is configured, the agent can do **everything** through the CLI. Use `--json`
for compact machine-readable stdout, including the generic `api` escape hatch for any endpoint.

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

For current copy-paste SDK setup per runtime, use:

```sh
rewindrewind help sdk browser
rewindrewind help sdk node
rewindrewind help sdk bun
rewindrewind help sdk ruby
rewindrewind help sdk rails
rewindrewind help sdk python
rewindrewind help sdk go
```

For agent-readable integration hints and upgrade planning:

```sh
rewindrewind sdk primitives node --json      # events vs exceptions, wiring primitives, hook hints
rewindrewind sdk doctor [name] --json        # local stack/key/reference checks
rewindrewind sdk upgrade [name] --json       # non-mutating upgrade plan for agents or humans
```

Agents should inspect the app, use the primitives, then wire RewindRewind into the idiomatic framework boundaries already present in the project. For example, Rails usually means an initializer plus middleware/job hooks; Go usually means explicit middleware/wrappers around `net/http`, framework handlers, workers, or CLIs.

## Common commands

```sh
rewindrewind health
rewindrewind events list --environment production --limit 50
rewindrewind events raw EVENT_ID
rewindrewind issues list --status open
rewindrewind issues get ISSUE_ID
rewindrewind issues resolve ISSUE_ID --reason "fixed in web@1.4.3"
rewindrewind issues reopen ISSUE_ID
rewindrewind issues ignore ISSUE_ID --reason "third-party noise"
rewindrewind issues ignore ISSUE_ID --mode until_time --preset 1w
rewindrewind issues snooze ISSUE_ID --preset 1d
rewindrewind issues lifecycle ISSUE_ID
rewindrewind comments list ISSUE_ID
rewindrewind comments create ISSUE_ID --body "Deployed fix."
rewindrewind comments update ISSUE_ID COMMENT_ID --body "Deployed fix in web@1.4.3."
rewindrewind comments delete ISSUE_ID COMMENT_ID
rewindrewind sourcemaps upload --release web@1.4.2 --file dist/app.js.map --file-name app.js.map
rewindrewind export --limit 500 --include-raw
rewindrewind ingestion-health
rewindrewind retention run
```

An issue is triaged into one of two end states, matching the dashboard: **resolve**
it (you fixed it) or **ignore** it (it's noise you don't want to hear about). Both
can take optional reactivation flags so the issue auto-reopens on a trigger:
`--mode until_time --preset 1w`, `--mode new_release`, `--mode occurrences_since_snooze
--threshold-count 50`, or `--mode manual` (never, until you reopen it). A `snooze` is
just a timed ignore, so it requires one of those flags. There is no `archive` verb —
an issue you want gone is `ignore`d.

Comments created or edited through the CLI are attributed to the admin key's
name and shown with an "API" tag in the dashboard, so it's clear they came from
automation rather than a person. Editing a comment keeps the original on record;
the dashboard marks edited comments but never loses the prior text.

## Projects

```sh
rewindrewind projects list
rewindrewind projects create --name "New App"
rewindrewind projects get
rewindrewind projects update --name "Production Web" --retention-days 90
rewindrewind projects update --uptime-url "https://example.com/health" --uptime-enabled true
rewindrewind projects update --uptime-enabled false --uptime-url null
rewindrewind projects delete
```

Project-scoped commands take the project from `--project`, `REWINDREWIND_PROJECT_ID`, or the configured `projectId`.

## Health rules

Agents can read and configure the same typed, versioned health rules shown in the dashboard. Create and update accept inline JSON, `@file`, or `-` for stdin; updates replace the complete specification and create a new immutable version.

```sh
rewindrewind health-rules list
rewindrewind health-rules get RULE_ID
rewindrewind health-rules create --data @health-rule.json
rewindrewind health-rules update RULE_ID --data @health-rule.json
rewindrewind health-rules delete RULE_ID
```

A `daily_visits` measure asserts against the current UTC day's aggregate visit
counter (see below) — e.g. `{ "measure": { "kind": "daily_visits", "metric": "unique" }, "operator": "<", "target": 100 }` goes red when today's unique visitors (DAU) drop below 100. Use `"metric": "total"` (the default) for raw visits.

## Visits (DAU)

Pre-aggregated daily visits / DAU are stored as a per-project-per-UTC-day
counter — never a durable event, never metered. Fire one signal per page load
with the public project key; read the per-day series with the admin key.

```sh
rewindrewind visits send --environment production
rewindrewind visits send --environment production --visitor-id user-42
rewindrewind visits list --from 2026-07-01 --to 2026-07-13
rewindrewind visits list --environment production
```

`visits list` returns a gap-filled series of `{ day, total_hits, unique_visitors }`
(defaults to the last 30 days). Omitting `--environment` sums across environments.

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

Human-readable output is the default. Use `--json` for compact JSON and `--pretty` for
pretty-printed JSON:

```sh
rewindrewind status                                  # human-readable
rewindrewind status --json                           # compact JSON for scripts
rewindrewind events list --limit 1 --pretty          # pretty-printed JSON
rewindrewind retention run --quiet                   # suppress output
rewindrewind issues list --verbose                   # log request URLs to stderr
```

## Development

```sh
npm test
npm run lint
```

This project intentionally has no runtime dependencies. Keep the CLI thin: validate obvious local input, send fast HTTP requests, and preserve RewindRewind API responses for agents and scripts.
