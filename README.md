# rewindrewindcli

Fast command-line wrapper for the RewindRewind events and exceptions API.

It is built for humans and agents: no runtime dependencies, JSON output by default, API-key auth, and a generic `api` command for any endpoint that is not yet covered by a first-class command.

## Install

After the package is published:

```sh
npm install -g rewindrewindcli
```

Run without installing:

```sh
npx rewindrewindcli --help
```

Install from a checkout:

```sh
git clone https://github.com/bananatron/rewindrewindcli.git
cd rewindrewindcli
npm install -g .
```

Install directly from GitHub:

```sh
npm install -g github:bananatron/rewindrewindcli
```

The package installs two binaries:

```sh
rewindrewind --help
rr --help
```

## Setup

Create a RewindRewind API key from your project dashboard, then configure the CLI:

```sh
rewindrewind configure \
  --api-key rr_xxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --project PROJECT_ID
```

The config file is written to:

```txt
~/.config/rewindrewind/config.json
```

For CI, agents, and one-off use, environment variables are usually better:

```sh
export REWINDREWIND_API_KEY=rr_xxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export REWINDREWIND_PROJECT_ID=PROJECT_ID
export REWINDREWIND_BASE_URL=https://rewindrewind.com
```

`REWINDREWIND_BASE_URL` defaults to `https://rewindrewind.com`.

API key scopes depend on the command:

- `events:write`: `events send`, `events batch`
- `events:read`: `events list`, `events raw`
- `exceptions:write`: `exceptions send`, `sentry envelope`
- `exceptions:read`: `issues list`, `issues get`, `comments list`
- `source_maps:write`: `sourcemaps upload`
- `admin`: project updates, issue status changes, comments writes, export, ingestion health, retention

An `admin` key can call every project-scoped endpoint.

## Common Commands

Check the service:

```sh
rewindrewind health
```

Fetch the OpenAPI document:

```sh
rewindrewind openapi
```

Send an event:

```sh
rewindrewind events send \
  --type checkout.completed \
  --environment production \
  --release web@1.4.2 \
  --distinct-id user_123 \
  --properties '{"plan":"pro","amount":4900}'
```

Send a batch:

```sh
rewindrewind events batch --file @events.json
```

Send an exception:

```sh
rewindrewind exceptions send \
  --message "Stripe webhook failed" \
  --level error \
  --environment production \
  --release worker@7c8d9e
```

Send a full exception payload:

```sh
rewindrewind exceptions send --payload @exception.json
```

Upload a Sentry envelope:

```sh
rewindrewind sentry envelope --file envelope.txt
```

Upload a source map:

```sh
rewindrewind sourcemaps upload \
  --release web@1.4.2 \
  --file dist/app.js.map \
  --file-name app.js.map
```

List recent events:

```sh
rewindrewind events list --environment production --limit 50
```

Fetch a raw event payload:

```sh
rewindrewind events raw EVENT_ID
```

List open issues:

```sh
rewindrewind issues list --status open --environment production
```

Resolve an issue:

```sh
rewindrewind issues update ISSUE_ID --status resolved
```

Add an issue comment:

```sh
rewindrewind comments create ISSUE_ID --body "Deployed fix in web@1.4.3."
```

Read ingestion health:

```sh
rewindrewind ingestion-health
```

Export project data:

```sh
rewindrewind export --limit 500 --include-raw
```

Run retention cleanup:

```sh
rewindrewind retention run
```

## Projects

Project-scoped commands use `--project`, `REWINDREWIND_PROJECT_ID`, or the configured `projectId`.

```sh
rewindrewind projects get
rewindrewind projects update --name "Production Web"
rewindrewind projects delete
```

The CLI also exposes the documented project collection endpoints:

```sh
rewindrewind projects list
rewindrewind projects create --name "New App"
```

Those endpoints follow the RewindRewind server's current auth behavior. Project-scoped API keys work for project-specific commands; top-level project list/create may require account/session auth until account-level API keys are available.

## Generic API Wrapper

Use `api` when an agent needs a raw endpoint call:

```sh
rewindrewind api get /api/projects/PROJECT_ID/issues --query status=open --query limit=25
rewindrewind api patch /api/projects/PROJECT_ID/issues/ISSUE_ID --data '{"status":"ignored"}'
rewindrewind api post /v1/events --data @event.json
rewindrewind api get /openapi.json --no-auth
```

`--data` accepts inline JSON, `@file`, or `-` for stdin.

## Output

Output is JSON by default:

```sh
rewindrewind events list --limit 1
```

Pretty-print JSON:

```sh
rewindrewind events list --limit 1 --format pretty
```

Suppress output for scripts:

```sh
rewindrewind retention run --quiet
```

Show request URLs:

```sh
rewindrewind issues list --verbose
```

## Development

```sh
npm test
npm run lint
```

This project intentionally avoids runtime dependencies. Keep the CLI thin: validate obvious local input, send fast HTTP requests, and preserve RewindRewind API responses for agents and scripts.
