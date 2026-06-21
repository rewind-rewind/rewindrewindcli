#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://rewindrewind.com";
const VERSION = "0.2.0";

// RewindRewind uses two kinds of key, and the CLI maps each command to the right
// one automatically:
//   • admin key   (rr_…)    — CLI + system management: projects, issues, events
//                             query, export, retention. A secret. Lives in config
//                             or a file you point at; never put it in client code.
//   • project key (rrpub_…) — how you authenticate INTO a project to send data
//                             (events, exceptions, source maps). Public by design,
//                             like a Sentry DSN: safe to embed in browsers/servers.
const ADMIN_PREFIX = "rr_";
const PROJECT_PREFIX = "rrpub_";

const HELP = `rewindrewind ${VERSION} — RewindRewind CLI for humans and agents

Quick start:
  rewindrewind init --api-key rr_xxx     Configure once, get setup for all 3 surfaces
  rewindrewind verify                    Send test data and confirm it lands

Usage:
  rewindrewind <command> [options]
  rr <command> [options]                 (rr is an alias)

The 3 surfaces:
  Front-end exceptions  browser <script> SDK, auto-captures uncaught errors
  Back-end exceptions   Node/Bun/Ruby/Python SDKs, or 'exceptions send'
  App events            product analytics via 'events send' / captureEvent
  Run 'rewindrewind init' to print copy-paste setup for each, with your key filled in.

Keys (auto-selected per command):
  admin key   (rr_…)     CLI + system management. Secret.
  project key (rrpub_…)  send events/exceptions/source maps. Public, like a Sentry DSN.

Global options:
  --api-key <key>          Admin key (rr_…).  Also REWINDREWIND_API_KEY.
  --api-key-file <path>    Read the admin key from a file (long-term auth pointer).
  --project-key <key>      Project ingestion key (rrpub_…). Also REWINDREWIND_PROJECT_KEY.
  --project-key-file <path> Read the project key from a file.
  --project <id>           Project id. Also REWINDREWIND_PROJECT_ID.
  --base-url <url>         API origin. Default: ${DEFAULT_BASE_URL}
  --format <json|pretty>   Output format. Default: json
  --quiet | --verbose

Setup & config:
  status                          Is an admin key configured and valid? (agent step 1)
  init [--api-key <key>|--api-key-file <path>] [--project <id>] [--base-url <url>]
  verify [--environment <name>]
  configure [--api-key <key>] [--api-key-file <path>] [--project-key <key>]
            [--project-key-file <path>] [--base-url <url>] [--project <id>]
  config get
  config set <name> <value>      names: api-key, api-key-file, project-key,
                                 project-key-file, base-url, project, format
  config unset <name>

Service:
  health
  openapi
  api <method> <path> [--data <json|@file|->] [--query key=value] [--no-auth]

Projects:
  projects list | create --name <name> [--account-id <id>]
  projects get | update [--name <name>] [--retention-days <n>] [--disabled <bool>]
  projects delete                        (all accept --project <id>)

App events  (project key):
  events send --type <type> [--environment <name>] [--distinct-id <id>]
              [--properties <json|@file>] [--payload <json|@file|->]
  events batch --file <json|@file|->
  events list [--limit <n>] [--cursor <c>] [--type <t>] [--environment <name>]
  events raw <event-id>

Exceptions  (project key for send; admin key for issues):
  exceptions send --message <msg> [--environment <name>] [--level <level>]
                  [--payload <json|@file|->]
  sentry envelope --file <path|->
  issues list [--status <status>] [--environment <name>] [--limit <n>]
  issues get <issue-id>
  issues update <issue-id> [--status <open|resolved|ignored|muted|regressed>]
                           [--assigned-to <id|null>]
  issues resolve <issue-id> [--reason <text>]
  issues reopen <issue-id> [--reason <text>]
  issues snooze <issue-id> | issues archive <issue-id>
  issues lifecycle <issue-id>
  comments list <issue-id>
  comments create <issue-id> --body <text>
  comments update <issue-id> <comment-id> --body <text>
  comments delete <issue-id> <comment-id>

Source maps & operations:
  sourcemaps upload --release <version> --file <path> [--file-name <name>]
  export [--limit <n>] [--before <iso>] [--include-raw]
  ingestion-health
  retention run
`;

export async function main(argv = process.argv.slice(2), io = {}) {
  const streams = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    stdin: io.stdin ?? process.stdin,
  };
  const fetchImpl = io.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new CliError("This CLI requires Node.js fetch support.", 1);

  try {
    const parsed = parseArgv(argv);
    if (parsed.options.version) {
      streams.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.options.help || parsed.positionals.length === 0) {
      streams.stdout.write(HELP);
      return 0;
    }

    const config = await loadConfig(io);
    const ctx = {
      io,
      config,
      fetch: fetchImpl,
      streams,
      configPath: configPath(io),
      baseUrl: normalizeBaseUrl(stringOption(parsed.options, "base-url") ?? env("REWINDREWIND_BASE_URL", io) ?? config.baseUrl ?? DEFAULT_BASE_URL),
      projectId: stringOption(parsed.options, "project") ?? env("REWINDREWIND_PROJECT_ID", io) ?? config.projectId,
      format: stringOption(parsed.options, "format") ?? env("REWINDREWIND_FORMAT", io) ?? config.format ?? "json",
      quiet: booleanOption(parsed.options, "quiet"),
      verbose: booleanOption(parsed.options, "verbose"),
      options: parsed.options,
      command: parsed.positionals,
    };

    const result = await dispatch(ctx);
    if (result !== undefined && !ctx.quiet) writeOutput(streams.stdout, result, ctx.format);
    return 0;
  } catch (error) {
    const status = error instanceof CliError ? error.status : 1;
    const message = error instanceof Error ? error.message : String(error);
    streams.stderr.write(`${message}\n`);
    if (!(error instanceof CliError) || error.showHelp) streams.stderr.write("\nRun `rewindrewind --help` for usage.\n");
    return status;
  }
}

export function parseArgv(argv) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    let value = eq >= 0 ? raw.slice(eq + 1) : undefined;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith("--") || next === "-")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }
    if (options[key] === undefined) options[key] = value;
    else if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = [options[key], value];
  }
  return { options, positionals };
}

async function dispatch(ctx) {
  const [group, action, third] = ctx.command;
  switch (group) {
    case "status":
      return statusCommand(ctx);
    case "init":
      return initCommand(ctx);
    case "verify":
      return verifyCommand(ctx);
    case "configure":
      return configure(ctx);
    case "config":
      return configCommand(ctx);
    case "health":
      return request(ctx, "GET", "/api/health", { auth: false });
    case "openapi":
      return request(ctx, "GET", "/openapi.json", { auth: false });
    case "api":
      return rawApi(ctx);
    case "projects":
      return projects(ctx, action);
    case "events":
      return events(ctx, action);
    case "exceptions":
      return exceptions(ctx, action);
    case "sentry":
      return sentry(ctx, action);
    case "issues":
      return issues(ctx, action);
    case "comments":
      return comments(ctx, action);
    case "sourcemaps":
    case "source-maps":
      return sourceMaps(ctx, action);
    case "export":
      return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}/export`, { query: queryFromOptions(ctx.options, ["limit", "before", "include_raw", "include-raw"]) });
    case "ingestion-health":
      return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}/ingestion-health`);
    case "retention":
      if (action !== "run") throw usage("Expected `retention run`.");
      return request(ctx, "POST", `/api/projects/${encodeURIComponent(projectId(ctx))}/retention/run`);
    default:
      throw usage(`Unknown command: ${[group, action, third].filter(Boolean).join(" ")}`);
  }
}

// `status` is the agent's first step: it answers "do we have a working admin
// key?" without throwing, returning JSON an agent can branch on. If no key is
// configured the agent should ask the user for one before doing anything else.
async function statusCommand(ctx) {
  const adminKey = await resolveKey(ctx, "admin", { optional: true });
  const projectKey = await resolveKey(ctx, "project", { optional: true });
  const base = { ok: true, base_url: ctx.baseUrl, config_path: ctx.configPath };
  if (!adminKey) {
    return {
      ...base,
      ready: false,
      needs_api_key: true,
      action: "Ask the user for a RewindRewind admin API key (starts with rr_), then run `rewindrewind init --api-key <key>`. Create one in the dashboard under API keys.",
    };
  }
  const probe = await safe(() => request(ctx, "GET", "/api/projects", { adminKeyOverride: adminKey }));
  if (!probe.ok) {
    return { ...base, ready: false, needs_api_key: true, admin_key: maskSecret(adminKey), error: probe.error, action: "The configured admin key was rejected. Ask the user for a valid rr_ admin key." };
  }
  const projectsList = Array.isArray(probe.value?.projects) ? probe.value.projects : [];
  return {
    ...base,
    ready: true,
    needs_api_key: false,
    admin_key: maskSecret(adminKey),
    account: projectsList[0]?.account_id ?? null,
    projects: projectsList.map((p) => ({ id: p.id, name: p.name })),
    project_id: ctx.projectId ?? (projectsList.length === 1 ? projectsList[0].id : undefined),
    has_project_key: Boolean(projectKey),
    surfaces: ["front-end exceptions", "back-end exceptions", "app events"],
  };
}

// `init` turns one admin key into a working setup: it finds the project, reads
// its public ingestion key from the API, saves both, and prints copy-paste setup
// for all three surfaces with the real key filled in.
async function initCommand(ctx) {
  const adminKey = await resolveKey(ctx, "admin", { allowPrompt: true, label: "admin key (rr_…)" });
  // Honor a file pointer: if the user pointed at a file, persist the pointer, not
  // the secret, so the key can rotate on disk without re-running init.
  const apiKeyFile = stringOption(ctx.options, "api-key-file") ?? env("REWINDREWIND_API_KEY_FILE", ctx.io) ?? ctx.config.apiKeyFile;

  const list = await request(ctx, "GET", "/api/projects", { adminKeyOverride: adminKey });
  const projectsList = Array.isArray(list?.projects) ? list.projects : [];
  const requested = stringOption(ctx.options, "project") ?? ctx.projectId;
  let chosen;
  if (requested) {
    chosen = projectsList.find((p) => p.id === requested) ?? { id: requested };
  } else if (projectsList.length === 1) {
    chosen = projectsList[0];
  } else if (projectsList.length === 0) {
    throw new CliError("No projects found for this admin key. Create one with `rewindrewind projects create --name <name>` (or in the dashboard), then re-run init.", 2);
  } else {
    const names = projectsList.map((p) => `  ${p.id}  ${p.name ?? ""}`.trimEnd()).join("\n");
    throw new CliError(`Multiple projects found. Re-run with --project <id>:\n${names}`, 2);
  }

  const detail = await request(ctx, "GET", `/api/projects/${encodeURIComponent(chosen.id)}`, { adminKeyOverride: adminKey });
  const project = detail?.project ?? chosen;
  const projectKey = project.public_key ?? chosen.public_key;
  if (!projectKey) {
    throw new CliError(`Could not read the project ingestion key from ${ctx.baseUrl}/api/projects/${chosen.id}. The admin key may lack access to this project.`, 2);
  }

  const next = { ...ctx.config, baseUrl: ctx.baseUrl, projectId: project.id, projectKey };
  if (apiKeyFile) {
    next.apiKeyFile = apiKeyFile;
    delete next.apiKey;
  } else {
    next.apiKey = adminKey;
    delete next.apiKeyFile;
  }
  await saveConfig(next, ctx);

  if (!ctx.quiet) ctx.streams.stderr.write(setupGuide(ctx.baseUrl, project, projectKey));
  if (booleanOption(ctx.options, "print-env")) {
    ctx.streams.stderr.write(`\n# Environment variables\nREWINDREWIND_BASE_URL=${ctx.baseUrl}\nREWINDREWIND_PROJECT_ID=${project.id}\nREWINDREWIND_PROJECT_KEY=${projectKey}\n`);
  }
  return {
    ok: true,
    config_path: ctx.configPath,
    base_url: ctx.baseUrl,
    project_id: project.id,
    project_key: projectKey,
    auth: apiKeyFile ? { admin_key_file: apiKeyFile } : { admin_key: maskSecret(adminKey) },
    next_steps: ["rewindrewind verify", `${ctx.baseUrl}/docs/exception-capture-sdk`],
  };
}

// Human-readable, copy-paste setup for the three surfaces. Written to stderr so
// the JSON result on stdout stays machine-parseable for agents.
function setupGuide(origin, project, projectKey) {
  return `
RewindRewind is set up for project "${project.name ?? project.id}".
Project ingestion key (public, safe to embed): ${projectKey}

1) Front-end exceptions — drop two tags in <head> (no build step):
   <script src="${origin}/sdk/v1/rewind.js"></script>
   <script>
     RewindRewind.init({ key: "${projectKey}", environment: "production" });
   </script>

2) Back-end exceptions — Node/Bun:
   npm i @rewindrewind/sdk
   import { initRewind } from "@rewindrewind/sdk/node";
   const rewind = initRewind({ key: "${projectKey}", autoCapture: true });
   (Ruby: gem "rewind_rewind"  •  Python helper: ${origin}/docs/exception-capture-sdk#python-apps)

3) App events — from code or the CLI:
   rewind.captureEvent("checkout.completed", { total: 42 });
   rewindrewind events send --type checkout.completed --properties '{"total":42}'

Confirm everything works:  rewindrewind verify
Full docs:                 ${origin}/docs/exception-capture-sdk
`;
}

// `verify` exercises each surface end to end: health, an app event, an
// exception, then confirms the event was stored via the management API.
async function verifyCommand(ctx) {
  const environment = stringOption(ctx.options, "environment") ?? "development";
  const marker = `cli-verify-${shortToken()}`;
  const checks = [];

  const health = await safe(() => request(ctx, "GET", "/api/health", { auth: false }));
  checks.push({ check: "service health", surface: "service", ...outcome(health, (d) => d?.ok === true) });

  const event = await safe(() => request(ctx, "POST", "/v1/events", {
    keyKind: "project",
    body: { type: "rewindrewind.cli.verify", environment, properties: { marker, source: "cli" } },
  }));
  checks.push({ check: "app event send", surface: "app events", ...outcome(event, (d) => d?.ok === true) });

  const exception = await safe(() => request(ctx, "POST", "/v1/exceptions", {
    keyKind: "project",
    body: {
      timestamp: new Date().toISOString(),
      environment,
      platform: "node",
      level: "info",
      message: `RewindRewind CLI verify ${marker}`,
      exception: { type: "RewindRewindCliVerify", value: marker, stacktrace: [] },
      tags: { source: "cli" },
    },
  }));
  checks.push({ check: "exception send", surface: "exceptions", ...outcome(exception, (d) => d?.ok === true) });

  // Confirm the event landed (best-effort — needs an admin key and may lag behind
  // async ingestion, so a miss here is a soft warning, not a hard failure).
  let confirmed;
  const pid = stringOption(ctx.options, "project") ?? ctx.projectId;
  if (pid && (await resolveKey(ctx, "admin", { optional: true }))) {
    const found = await safe(() => request(ctx, "GET", `/api/projects/${encodeURIComponent(pid)}/events`, { query: { type: "rewindrewind.cli.verify", limit: 20 } }));
    const events = found.ok ? (found.value?.events ?? []) : [];
    confirmed = events.some((e) => JSON.stringify(e).includes(marker));
    checks.push({ check: "event confirmed in project", surface: "app events", ok: found.ok && confirmed, detail: !found.ok ? found.error : confirmed ? "found" : "not found yet (ingestion may be async)" });
  } else {
    checks.push({ check: "event confirmed in project", surface: "app events", ok: null, detail: "skipped (set an admin key and --project to confirm)" });
  }

  const passed = checks.filter((c) => c.ok === true).length;
  const failed = checks.filter((c) => c.ok === false);
  if (!ctx.quiet) {
    for (const c of checks) {
      const mark = c.ok === true ? "ok  " : c.ok === false ? "FAIL" : "skip";
      ctx.streams.stderr.write(`[${mark}] ${c.check}${c.detail ? ` — ${c.detail}` : ""}\n`);
    }
    if (pid) ctx.streams.stderr.write(`\nDashboard: ${ctx.baseUrl}/projects/${pid}\n`);
  }
  const result = { ok: failed.length === 0, passed, failed: failed.length, checks };
  if (failed.length > 0) {
    // Surface a non-zero exit for scripts/agents without throwing away the JSON.
    if (!ctx.quiet) writeOutput(ctx.streams.stdout, result, ctx.format);
    throw new CliError(`verify failed: ${failed.map((c) => c.check).join(", ")}`, 1);
  }
  return result;
}

async function configure(ctx) {
  const next = { ...ctx.config, baseUrl: normalizeBaseUrl(stringOption(ctx.options, "base-url") ?? ctx.baseUrl) };
  applyKeyOptions(ctx.options, next);
  const project = stringOption(ctx.options, "project");
  if (project) next.projectId = project;
  if (!next.apiKey && !next.apiKeyFile && !next.projectKey && !next.projectKeyFile) {
    throw usage("Provide at least one of --api-key, --api-key-file, --project-key, --project-key-file.");
  }
  await saveConfig(next, ctx);
  return { ok: true, config_path: ctx.configPath, configured: visibleConfig(next) };
}

// Mutually-exclusive within a kind: setting an inline key clears its file
// pointer and vice-versa, so resolution is never ambiguous.
function applyKeyOptions(options, target) {
  const apiKey = stringOption(options, "api-key");
  const apiKeyFile = stringOption(options, "api-key-file");
  if (apiKey) {
    target.apiKey = apiKey;
    delete target.apiKeyFile;
  }
  if (apiKeyFile) {
    target.apiKeyFile = apiKeyFile;
    delete target.apiKey;
  }
  const projectKey = stringOption(options, "project-key");
  const projectKeyFile = stringOption(options, "project-key-file");
  if (projectKey) {
    target.projectKey = projectKey;
    delete target.projectKeyFile;
  }
  if (projectKeyFile) {
    target.projectKeyFile = projectKeyFile;
    delete target.projectKey;
  }
}

async function configCommand(ctx) {
  const [, action, name, value] = ctx.command;
  if (action === "get" || !action) return { ok: true, config_path: ctx.configPath, config: visibleConfig(ctx.config) };
  if (action === "set") {
    if (!name || value === undefined) throw usage("Expected `config set <name> <value>`.");
    const key = configKey(name);
    const next = { ...ctx.config, [key]: value };
    // Keep inline/file pointers mutually exclusive per key kind.
    if (key === "apiKey") delete next.apiKeyFile;
    if (key === "apiKeyFile") delete next.apiKey;
    if (key === "projectKey") delete next.projectKeyFile;
    if (key === "projectKeyFile") delete next.projectKey;
    await saveConfig(next, ctx);
    return { ok: true, config_path: ctx.configPath, config: visibleConfig(next) };
  }
  if (action === "unset") {
    if (!name) throw usage("Expected `config unset <name>`.");
    const key = configKey(name);
    const next = { ...ctx.config };
    delete next[key];
    await saveConfig(next, ctx);
    return { ok: true, config_path: ctx.configPath, config: visibleConfig(next) };
  }
  throw usage(`Unknown config action: ${action}`);
}

async function rawApi(ctx) {
  const [, methodRaw, pathRaw] = ctx.command;
  if (!methodRaw || !pathRaw) throw usage("Expected `api <method> <path>`.");
  const data = ctx.options.data === undefined ? undefined : await jsonInput(ctx.options.data, ctx.streams.stdin);
  // DSN-aware default: /v1/* paths are ingestion (project key); everything else
  // is management (admin key). Override with --no-auth for public endpoints.
  const keyKind = pathRaw.startsWith("/v1/") ? "project" : "admin";
  return request(ctx, methodRaw.toUpperCase(), pathRaw, {
    auth: booleanOption(ctx.options, "no-auth") ? false : undefined,
    keyKind,
    body: data,
    query: queryOptions(ctx.options.query),
  });
}

async function projects(ctx, action) {
  if (action === "list") return request(ctx, "GET", "/api/projects");
  if (action === "create") {
    return request(ctx, "POST", "/api/projects", { body: compact({ name: requiredOption(ctx.options, "name"), account_id: stringOption(ctx.options, "account-id") }) });
  }
  if (action === "get") return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}`);
  if (action === "update") {
    const body = bodyFromOptions(ctx.options, [
      ["name", "name", "string"],
      ["slug", "slug", "string"],
      ["retention-days", "retention_days", "number"],
      ["events-per-minute", "events_per_minute", "number"],
      ["events-per-day", "events_per_day", "number"],
      ["max-payload-bytes", "max_payload_bytes", "number"],
      ["max-batch-size", "max_batch_size", "number"],
      ["max-indexed-properties", "max_indexed_properties", "number"],
      ["exception-burst-per-minute", "exception_burst_per_minute", "number"],
      ["source-map-bytes-limit", "source_map_bytes_limit", "number"],
      ["disabled", "disabled", "boolean"],
      ["blocked-property-names", "blocked_property_names", "json"],
      ["indexing-policy", "indexing_policy", "json"],
    ]);
    return request(ctx, "PATCH", `/api/projects/${encodeURIComponent(projectId(ctx))}`, { body });
  }
  if (action === "delete") return request(ctx, "DELETE", `/api/projects/${encodeURIComponent(projectId(ctx))}`);
  throw usage("Expected a projects action: list, create, get, update, delete.");
}

async function events(ctx, action) {
  if (action === "send") {
    const payload = ctx.options.payload === undefined ? {} : await jsonInput(ctx.options.payload, ctx.streams.stdin);
    const properties = ctx.options.properties === undefined ? undefined : await jsonInput(ctx.options.properties, ctx.streams.stdin);
    return request(ctx, "POST", "/v1/events", {
      keyKind: "project",
      body: compact({
        ...payload,
        type: stringOption(ctx.options, "type") ?? payload.type,
        timestamp: stringOption(ctx.options, "timestamp") ?? payload.timestamp,
        distinct_id: stringOption(ctx.options, "distinct-id") ?? payload.distinct_id,
        anonymous_id: stringOption(ctx.options, "anonymous-id") ?? payload.anonymous_id,
        environment: stringOption(ctx.options, "environment") ?? payload.environment,
        release: stringOption(ctx.options, "release") ?? payload.release,
        source: stringOption(ctx.options, "source") ?? payload.source,
        properties: properties ?? payload.properties,
      }),
    });
  }
  if (action === "batch") {
    const body = await jsonInput(requiredOption(ctx.options, "file"), ctx.streams.stdin);
    return request(ctx, "POST", "/v1/events/batch", { keyKind: "project", body: Array.isArray(body) ? { events: body } : body });
  }
  if (action === "list") {
    return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}/events`, {
      query: queryFromOptions(ctx.options, ["limit", "cursor", "type", "environment", "release", "source", "distinct_id", "distinct-id"]),
    });
  }
  if (action === "raw") {
    const eventId = ctx.command[2];
    if (!eventId) throw usage("Expected `events raw <event-id>`.");
    return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}/events/${encodeURIComponent(eventId)}/raw`);
  }
  throw usage("Expected an events action: send, batch, list, raw.");
}

async function exceptions(ctx, action) {
  if (action !== "send") throw usage("Expected `exceptions send`.");
  const payload = ctx.options.payload === undefined ? {} : await jsonInput(ctx.options.payload, ctx.streams.stdin);
  return request(ctx, "POST", "/v1/exceptions", {
    keyKind: "project",
    body: compact({
      ...payload,
      timestamp: stringOption(ctx.options, "timestamp") ?? payload.timestamp,
      environment: stringOption(ctx.options, "environment") ?? payload.environment,
      release: stringOption(ctx.options, "release") ?? payload.release,
      platform: stringOption(ctx.options, "platform") ?? payload.platform,
      level: stringOption(ctx.options, "level") ?? payload.level,
      message: stringOption(ctx.options, "message") ?? payload.message,
      fingerprint: stringOption(ctx.options, "fingerprint") ?? payload.fingerprint,
    }),
  });
}

async function sentry(ctx, action) {
  if (action !== "envelope") throw usage("Expected `sentry envelope --file <path|->`.");
  const file = requiredOption(ctx.options, "file");
  const body = file === "-" ? await readStdinText(ctx.streams.stdin) : createReadStream(file);
  return request(ctx, "POST", "/v1/sentry/envelope", { keyKind: "project", body, contentType: "application/x-sentry-envelope" });
}

async function issues(ctx, action) {
  const issueId = ctx.command[2];
  const base = () => `/api/projects/${encodeURIComponent(projectId(ctx))}/issues`;
  if (action === "list") {
    return request(ctx, "GET", base(), { query: queryFromOptions(ctx.options, ["limit", "cursor", "status", "environment", "fingerprint"]) });
  }
  if (action === "get") {
    if (!issueId) throw usage("Expected `issues get <issue-id>`.");
    return request(ctx, "GET", `${base()}/${encodeURIComponent(issueId)}`, { query: queryFromOptions(ctx.options, ["limit", "cursor"]) });
  }
  if (action === "lifecycle") {
    if (!issueId) throw usage("Expected `issues lifecycle <issue-id>`.");
    return request(ctx, "GET", `${base()}/${encodeURIComponent(issueId)}/lifecycle`);
  }
  if (action === "resolve" || action === "reopen" || action === "snooze" || action === "archive") {
    if (!issueId) throw usage(`Expected \`issues ${action} <issue-id>\`.`);
    const reason = stringOption(ctx.options, "reason");
    return request(ctx, "POST", `${base()}/${encodeURIComponent(issueId)}/${action}`, { body: compact({ reason }) });
  }
  if (action === "update") {
    if (!issueId) throw usage("Expected `issues update <issue-id>`.");
    const requestedStatus = stringOption(ctx.options, "status");
    const result = await request(ctx, "PATCH", `${base()}/${encodeURIComponent(issueId)}`, {
      body: bodyFromOptions(ctx.options, [
        ["status", "status", "string"],
        ["assigned-to", "assigned_to", "nullableString"],
      ]),
    });
    // Defense-in-depth: the API returns ok:true even when nothing changed, so a
    // dropped update (e.g. a status that didn't stick) would otherwise pass
    // silently. Surface the mismatch on stderr without disturbing stdout JSON.
    const returnedStatus = result?.issue?.status;
    if (requestedStatus && returnedStatus !== undefined && returnedStatus !== requestedStatus) {
      ctx.streams.stderr.write(`warning: requested status "${requestedStatus}" but issue is "${returnedStatus}" after update\n`);
    }
    return result;
  }
  throw usage("Expected an issues action: list, get, update, resolve, reopen, snooze, archive, lifecycle.");
}

async function comments(ctx, action) {
  const issueId = ctx.command[2];
  const commentId = ctx.command[3];
  if (!issueId) throw usage("Expected an issue id.");
  const base = `/api/projects/${encodeURIComponent(projectId(ctx))}/issues/${encodeURIComponent(issueId)}/comments`;
  if (action === "list") return request(ctx, "GET", base, { query: queryFromOptions(ctx.options, ["limit", "cursor"]) });
  if (action === "create") return request(ctx, "POST", base, { body: { body: requiredOption(ctx.options, "body") } });
  if (action === "update") {
    if (!commentId) throw usage("Expected `comments update <issue-id> <comment-id>`.");
    return request(ctx, "PATCH", `${base}/${encodeURIComponent(commentId)}`, { body: { body: requiredOption(ctx.options, "body") } });
  }
  if (action === "delete") {
    if (!commentId) throw usage("Expected `comments delete <issue-id> <comment-id>`.");
    return request(ctx, "DELETE", `${base}/${encodeURIComponent(commentId)}`);
  }
  throw usage("Expected a comments action: list, create, update, delete.");
}

async function sourceMaps(ctx, action) {
  if (action !== "upload") throw usage("Expected `sourcemaps upload`.");
  const file = requiredOption(ctx.options, "file");
  const content = file === "-" ? await readStdinText(ctx.streams.stdin) : await readFile(file, "utf8");
  return request(ctx, "POST", "/v1/source-maps", {
    keyKind: "project",
    body: {
      release: requiredOption(ctx.options, "release"),
      file_name: stringOption(ctx.options, "file-name") ?? file,
      content,
    },
  });
}

async function request(ctx, method, path, options = {}) {
  const base = new URL(ctx.baseUrl);
  const url = new URL(path, `${ctx.baseUrl}/`);
  const isConfiguredOrigin = url.origin === base.origin;
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    url.searchParams.set(key, value === true ? "true" : String(value));
  }

  const headers = { accept: "application/json" };
  if (options.auth !== false) {
    if (!isConfiguredOrigin) {
      throw new CliError("Refusing to send an API key to a URL outside --base-url. Use --no-auth for public external URLs.", 2);
    }
    const keyKind = options.keyKind ?? "admin";
    const key = options.adminKeyOverride ?? (await resolveKey(ctx, keyKind));
    headers.authorization = `Bearer ${key}`;
  }
  const init = { method, headers };
  if (options.body !== undefined) {
    init.body = typeof options.body?.pipe === "function" ? options.body : JSON.stringify(options.body);
    headers["content-type"] = options.contentType ?? "application/json";
    if (typeof options.body?.pipe === "function") init.duplex = "half";
  }

  if (ctx.verbose) ctx.streams.stderr.write(`${method} ${url}\n`);
  const res = await ctx.fetch(url, init);
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  const data = text && contentType.includes("application/json") ? parseJson(text, `Response from ${url}`) : text;
  if (!res.ok) {
    const message = data && typeof data === "object" && data.error?.message ? data.error.message : `${res.status} ${res.statusText}`;
    const error = new CliError(`RewindRewind API error: ${message}`, res.status >= 400 && res.status < 500 ? 2 : 1);
    error.response = data;
    throw error;
  }
  return data;
}

// Resolve a key of the requested kind from flags, env, or config — supporting
// both inline values and file pointers — and validate its prefix so a wrong key
// fails locally with a clear message instead of a confusing 401 from the server.
async function resolveKey(ctx, kind, opts = {}) {
  const isProject = kind === "project";
  const flag = isProject
    ? (stringOption(ctx.options, "project-key") ?? stringOption(ctx.options, "key"))
    : stringOption(ctx.options, "api-key");
  const flagFile = stringOption(ctx.options, isProject ? "project-key-file" : "api-key-file");
  const envKey = env(isProject ? "REWINDREWIND_PROJECT_KEY" : "REWINDREWIND_API_KEY", ctx.io);
  const envFile = env(isProject ? "REWINDREWIND_PROJECT_KEY_FILE" : "REWINDREWIND_API_KEY_FILE", ctx.io);
  const cfgKey = isProject ? ctx.config.projectKey : ctx.config.apiKey;
  const cfgFile = isProject ? ctx.config.projectKeyFile : ctx.config.apiKeyFile;

  let key = flag ?? (flagFile && (await readKeyFile(flagFile))) ?? envKey ?? (envFile && (await readKeyFile(envFile))) ?? cfgKey ?? (cfgFile && (await readKeyFile(cfgFile)));
  // Tolerance: a project key pasted into the admin slot (or vice-versa) is still
  // usable — route by prefix rather than by which slot it sat in.
  if (!key) {
    const other = isProject ? ctx.config.apiKey : ctx.config.projectKey;
    if (other?.startsWith(isProject ? PROJECT_PREFIX : ADMIN_PREFIX) && !other?.startsWith(isProject ? "" : PROJECT_PREFIX)) key = other;
  }

  if (!key) {
    if (opts.optional) return undefined;
    if (opts.allowPrompt && ctx.streams.stdin?.isTTY) {
      key = await promptHidden(ctx, `Paste your ${opts.label ?? (isProject ? "project key (rrpub_…)" : "admin key (rr_…)")}: `);
    }
  }
  if (!key) {
    if (opts.optional) return undefined;
    throw isProject
      ? new CliError("Missing project ingestion key (rrpub_…). Run `rewindrewind init`, set REWINDREWIND_PROJECT_KEY, or pass --project-key / --project-key-file.", 2)
      : new CliError("Missing admin key (rr_…). Run `rewindrewind init`, set REWINDREWIND_API_KEY, or pass --api-key / --api-key-file.", 2);
  }
  key = key.trim();
  if (isProject && !key.startsWith(PROJECT_PREFIX)) {
    throw new CliError(`This command sends data into a project and needs a project ingestion key (${PROJECT_PREFIX}…), but got "${maskSecret(key)}". That looks like an admin key — run \`rewindrewind init\` to fetch the project key, or pass --project-key.`, 2);
  }
  if (!isProject && key.startsWith(PROJECT_PREFIX)) {
    throw new CliError(`This command manages your account and needs an admin key (${ADMIN_PREFIX}…), but got a project key (${PROJECT_PREFIX}…). Pass --api-key with an admin key.`, 2);
  }
  return key;
}

async function readKeyFile(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    throw new CliError(`Could not read key file ${path}: ${error.message}`, 2);
  }
}

function promptHidden(ctx, label) {
  return new Promise((resolveP) => {
    ctx.streams.stderr.write(label);
    const stdin = ctx.streams.stdin;
    let data = "";
    const onData = (chunk) => {
      const s = String(chunk);
      if (s.includes("\n") || s.includes("\r")) {
        data += s.split(/[\r\n]/)[0];
        stdin.removeListener("data", onData);
        if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
        stdin.pause();
        ctx.streams.stderr.write("\n");
        resolveP(data);
      } else {
        data += s;
      }
    };
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function safe(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function outcome(result, predicate) {
  if (!result.ok) return { ok: false, detail: result.error };
  return { ok: predicate(result.value), detail: result.value?.event_id ? `event_id ${result.value.event_id}` : undefined };
}

function projectId(ctx) {
  const id = stringOption(ctx.options, "project") ?? ctx.projectId;
  if (!id) throw new CliError("Missing project id. Pass --project, set REWINDREWIND_PROJECT_ID, or run `rewindrewind init`.", 2);
  return id;
}

function queryFromOptions(options, names) {
  const query = {};
  for (const name of names) {
    if (options[name] === undefined) continue;
    const apiName = name.replaceAll("-", "_");
    query[apiName] = last(options[name]);
  }
  return query;
}

function queryOptions(value) {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const query = {};
  for (const item of values) {
    const [key, ...rest] = String(item).split("=");
    if (!key || rest.length === 0) throw usage(`Bad --query value: ${item}`);
    query[key] = rest.join("=");
  }
  return query;
}

function bodyFromOptions(options, specs) {
  const body = {};
  for (const [cliName, apiName, type] of specs) {
    if (options[cliName] === undefined) continue;
    const value = last(options[cliName]);
    if (type === "number") body[apiName] = Number(value);
    else if (type === "boolean") body[apiName] = parseBoolean(value);
    else if (type === "json") body[apiName] = parseJsonOrCsv(value);
    else if (type === "nullableString") body[apiName] = value === "null" ? null : String(value);
    else body[apiName] = String(value);
  }
  return body;
}

async function jsonInput(value, stdin) {
  const raw = await readInputText(value, stdin);
  return parseJson(raw, typeof value === "string" ? value : "input");
}

async function readInputText(value, stdin) {
  const input = last(value);
  if (input === "-") return readStdinText(stdin);
  if (typeof input === "string" && input.startsWith("@")) return readFile(input.slice(1), "utf8");
  return String(input);
}

function readStdinText(stdin) {
  return new Promise((resolveP, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolveP(data));
    stdin.on("error", reject);
  });
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliError(`Invalid JSON in ${label}: ${error.message}`, 2);
  }
}

function parseJsonOrCsv(value) {
  const text = String(value).trim();
  if (text.startsWith("[") || text.startsWith("{")) return parseJson(text, "option");
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value) {
  if (value === true) return true;
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw usage(`Expected a boolean, got ${value}.`);
}

async function loadConfig(io = {}) {
  try {
    return JSON.parse(await readFile(configPath(io), "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function saveConfig(config, ctx) {
  await mkdir(dirname(ctx.configPath), { recursive: true, mode: 0o700 });
  await writeFile(ctx.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function configPath(io = {}) {
  const envHome = env("XDG_CONFIG_HOME", io);
  return join(envHome || join(env("HOME", io) || homedir(), ".config"), "rewindrewind", "config.json");
}

function visibleConfig(config) {
  const visible = { ...config };
  // The admin key is a secret — mask it. The project key is public (DSN-like),
  // and file pointers are paths, so both are shown verbatim.
  if (config.apiKey) visible.apiKey = maskSecret(config.apiKey);
  return visible;
}

function maskSecret(value) {
  if (value.length <= 12) return "********";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function configKey(name) {
  const keys = {
    "api-key": "apiKey",
    apiKey: "apiKey",
    "api-key-file": "apiKeyFile",
    apiKeyFile: "apiKeyFile",
    "project-key": "projectKey",
    projectKey: "projectKey",
    "project-key-file": "projectKeyFile",
    projectKeyFile: "projectKeyFile",
    "base-url": "baseUrl",
    baseUrl: "baseUrl",
    project: "projectId",
    "project-id": "projectId",
    projectId: "projectId",
    format: "format",
  };
  const key = keys[name];
  if (!key) throw usage(`Unknown config key: ${name}`);
  return key;
}

function normalizeBaseUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function writeOutput(stream, value, format) {
  if (format === "pretty") {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  stream.write(`${JSON.stringify(value)}\n`);
}

function requiredOption(options, name) {
  const value = stringOption(options, name);
  if (value === undefined || value === "") throw usage(`Missing required option --${name}.`);
  return value;
}

function stringOption(options, name) {
  const value = options[name];
  if (value === undefined || value === true) return undefined;
  return String(last(value));
}

function booleanOption(options, name) {
  return options[name] !== undefined && parseBoolean(options[name]);
}

function last(value) {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

function shortToken() {
  return Math.random().toString(36).slice(2, 10);
}

function env(name, io = {}) {
  return (io.env ?? process.env)[name];
}

function usage(message) {
  const error = new CliError(message, 2);
  error.showHelp = true;
  return error;
}

export class CliError extends Error {
  constructor(message, status = 1) {
    super(message);
    this.name = "CliError";
    this.status = status;
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}

if (isEntrypoint()) {
  process.exitCode = await main();
}
