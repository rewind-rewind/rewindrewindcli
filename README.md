# RewindRewind CLI

[RewindRewind](https://rewindrewind.com) combines error tracking and product event tracking in one service. This CLI connects projects, provides SDK setup guidance, verifies data ingestion, and manages the RewindRewind API.

It is designed for people, coding agents, and scripts. Output is readable by default, every workflow supports structured JSON, and the package has no runtime dependencies.

## Quick start

Node.js 18.18 or newer is required.

Install the CLI from its public GitHub repository:

```sh
npm install -g github:rewind-rewind/rewindrewindcli
```

Create an admin API key in [RewindRewind](https://rewindrewind.com), then initialize and verify your project:

```sh
rewindrewind status
rewindrewind init --api-key rr_xxx
rewindrewind verify
```

You can use `rr` as a shorter alias for `rewindrewind`.

To run the CLI without installing it:

```sh
npx github:rewind-rewind/rewindrewindcli status
```

## What `init` does

`rewindrewind init` selects a project, fetches its public project key, saves the configuration, and prints setup instructions for three data sources:

1. Front-end exceptions, including uncaught errors and unhandled promises.
2. Back-end exceptions from servers, jobs, and command-line programs.
3. App events such as signups, purchases, and feature usage.

Run `rewindrewind verify` after setup. It sends a test event and exception, then confirms that RewindRewind received them.

## Authentication

RewindRewind uses two key types:

| Key | Purpose | Safe in client code? |
| --- | --- | --- |
| Admin key (`rr_...`) | Manages projects, issues, events, exports, and configuration | No |
| Project key (`rrpub_...`) | Sends events, exceptions, visits, and source maps to one project | Yes |

The CLI automatically chooses the correct key for each command. You provide the admin key during setup, and `init` fetches the project key.

To keep an admin key out of shell history, store it in a file and configure a pointer:

```sh
rewindrewind config set api-key-file /run/secrets/rewindrewind_admin_key
```

The default configuration file is `~/.config/rewindrewind/config.json`. Environment variables are also supported:

```sh
export REWINDREWIND_API_KEY=rr_xxx
export REWINDREWIND_PROJECT_KEY=rrpub_xxx
export REWINDREWIND_PROJECT_ID=PROJECT_ID
export REWINDREWIND_BASE_URL=https://rewindrewind.com
```

Each key can also use a matching `_FILE` environment variable that points to a file containing the key.

## SDK setup

Ask the CLI for current, runtime-specific instructions:

```sh
rewindrewind help sdk browser
rewindrewind help sdk node
rewindrewind help sdk bun
rewindrewind help sdk ruby
rewindrewind help sdk rails
rewindrewind help sdk python
rewindrewind help sdk go
```

The SDK tools can inspect a project and produce structured integration guidance:

```sh
rewindrewind sdk doctor --pretty
rewindrewind sdk primitives node --pretty
rewindrewind sdk upgrade node --pretty
rewindrewind sdk snippet browser
```

Coding agents can use [`AGENTS.md`](AGENTS.md) as a self-contained setup runbook. Agents should always run `rewindrewind status --json` first and ask for an admin key if `needs_api_key` is `true`.

## Common workflows

Send and inspect app events:

```sh
rewindrewind events send --type checkout.completed --properties '{"plan":"pro","amount":4900}'
rewindrewind events list --environment production --limit 50
rewindrewind events raw EVENT_ID
```

Send an exception and manage grouped issues:

```sh
rewindrewind exceptions send --message "Stripe webhook failed" --level error
rewindrewind issues list --status open
rewindrewind issues get ISSUE_ID
rewindrewind issues resolve ISSUE_ID --reason "fixed in web@1.4.3"
rewindrewind issues ignore ISSUE_ID --reason "third-party noise"
rewindrewind issues snooze ISSUE_ID --preset 1d
```

Resolve an issue when it is fixed. Ignore it when it is unwanted noise. Snooze it when it should return after a set period.

Work with issue comments and source maps:

```sh
rewindrewind comments list ISSUE_ID
rewindrewind comments create ISSUE_ID --body "Deployed fix."
rewindrewind sourcemaps upload --release web@1.4.2 --file dist/app.js.map --file-name app.js.map
```

Manage projects and project health:

```sh
rewindrewind projects list
rewindrewind projects create --name "New App"
rewindrewind projects update --retention-days 90
rewindrewind health-rules list
rewindrewind health-rules create --data @health-rule.json
rewindrewind ingestion-health
```

Track daily visits without storing a durable event for every page load:

```sh
rewindrewind visits send --environment production --visitor-id user-42
rewindrewind visits list --from 2026-07-01 --to 2026-07-31
```

## Automation and API access

Use `--json` for compact JSON or `--pretty` for formatted JSON:

```sh
rewindrewind status --json
rewindrewind issues list --pretty
rewindrewind retention run --quiet
rewindrewind issues list --verbose
```

The generic API command can call any RewindRewind endpoint. It uses the project key for `/v1/*` paths and the admin key for management paths.

```sh
rewindrewind api get /api/projects/PROJECT_ID/issues --query status=open
rewindrewind api post /v1/events --data @event.json
rewindrewind api get /openapi.json --no-auth
```

`--data` accepts inline JSON, `@file`, or `-` for standard input.

## Help

Use the built-in help as the authoritative command reference:

```sh
rewindrewind --help
rewindrewind --help --json
rewindrewind help auth
rewindrewind help events
rewindrewind help exceptions
rewindrewind help troubleshooting
```

## Development

```sh
npm test
npm run lint
```

### Test coverage

Generate a coverage report with Node's built-in test-runner coverage (no extra
dependencies):

```sh
npm run coverage
```

This prints per-file line, branch, and function coverage along with the
uncovered line ranges. When a machine-readable report is needed (for example, to
upload to a coverage service), add Node's `lcov` reporter:

```sh
mkdir -p coverage && node --test --experimental-test-coverage \
  --test-reporter=lcov --test-reporter-destination=coverage/lcov.info
```

Coverage artifacts are written under `coverage/`, which is git-ignored. CI runs
`npm run coverage` on every push and pull request (see
`.github/workflows/ci.yml`).

Keep the CLI thin. Validate local input, make direct HTTP requests, and preserve API responses for agents and scripts.
