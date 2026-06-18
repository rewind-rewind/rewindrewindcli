#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://rewindrewind.com";
const VERSION = "0.1.0";

const HELP = `rewindrewindcli ${VERSION}

Usage:
  rewindrewind <command> [options]
  rr <command> [options]

Global options:
  --api-key <key>        RewindRewind API key. Also REWINDREWIND_API_KEY.
  --base-url <url>      API origin. Default: ${DEFAULT_BASE_URL}
  --project <id>        Project id. Also REWINDREWIND_PROJECT_ID.
  --format <json|pretty>
  --quiet
  --verbose

Auth and config:
  configure --api-key <key> [--base-url <url>] [--project <id>]
  config get
  config set <name> <value>
  config unset <name>

API:
  health
  openapi
  api <method> <path> [--data <json|@file|->] [--query key=value] [--no-auth]

Projects:
  projects list
  projects create --name <name> [--account-id <id>]
  projects get [--project <id>]
  projects update [--project <id>] [--name <name>] [--retention-days <n>] [--disabled <true|false>]
  projects delete [--project <id>]

Events and exceptions:
  events send --type <type> [--environment <name>] [--properties <json|@file>] [--payload <json|@file|->]
  events batch --file <json|@file|->
  events list [--project <id>] [--limit <n>] [--cursor <cursor>] [--type <type>] [--environment <name>]
  events raw <event-id> [--project <id>]
  exceptions send --message <message> [--environment <name>] [--level <level>] [--payload <json|@file|->]
  sentry envelope --file <path|->

Issues:
  issues list [--project <id>] [--status <status>] [--environment <name>] [--limit <n>]
  issues get <issue-id> [--project <id>]
  issues update <issue-id> [--status <open|resolved|ignored|muted|regressed>] [--assigned-to <id|null>]
  comments list <issue-id> [--project <id>]
  comments create <issue-id> --body <text> [--project <id>]
  comments update <issue-id> <comment-id> --body <text> [--project <id>]
  comments delete <issue-id> <comment-id> [--project <id>]

Operations:
  sourcemaps upload --release <version> --file <path> [--file-name <name>]
  export [--project <id>] [--limit <n>] [--before <iso>] [--include-raw]
  ingestion-health [--project <id>]
  retention run [--project <id>]
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
    const context = {
      config,
      fetch: fetchImpl,
      streams,
      configPath: configPath(io),
      baseUrl: normalizeBaseUrl(stringOption(parsed.options, "base-url") ?? env("REWINDREWIND_BASE_URL", io) ?? config.baseUrl ?? DEFAULT_BASE_URL),
      apiKey: stringOption(parsed.options, "api-key") ?? env("REWINDREWIND_API_KEY", io) ?? config.apiKey,
      projectId: stringOption(parsed.options, "project") ?? env("REWINDREWIND_PROJECT_ID", io) ?? config.projectId,
      format: stringOption(parsed.options, "format") ?? env("REWINDREWIND_FORMAT", io) ?? config.format ?? "json",
      quiet: booleanOption(parsed.options, "quiet"),
      verbose: booleanOption(parsed.options, "verbose"),
      options: parsed.options,
      command: parsed.positionals,
    };

    const result = await dispatch(context);
    if (result !== undefined && !context.quiet) writeOutput(streams.stdout, result, context.format);
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

async function configure(ctx) {
  const apiKey = requiredOption(ctx.options, "api-key");
  const next = {
    ...ctx.config,
    apiKey,
    baseUrl: normalizeBaseUrl(stringOption(ctx.options, "base-url") ?? ctx.baseUrl),
  };
  const project = stringOption(ctx.options, "project");
  if (project) next.projectId = project;
  await saveConfig(next, ctx);
  return { ok: true, config_path: ctx.configPath, configured: visibleConfig(next) };
}

async function configCommand(ctx) {
  const [, action, name, value] = ctx.command;
  if (action === "get" || !action) return { ok: true, config_path: ctx.configPath, config: visibleConfig(ctx.config) };
  if (action === "set") {
    if (!name || value === undefined) throw usage("Expected `config set <name> <value>`.");
    const key = configKey(name);
    const next = { ...ctx.config, [key]: value };
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
  return request(ctx, methodRaw.toUpperCase(), pathRaw, {
    auth: booleanOption(ctx.options, "no-auth") ? false : undefined,
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
    return request(ctx, "POST", "/v1/events/batch", { body: Array.isArray(body) ? { events: body } : body });
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
  return request(ctx, "POST", "/v1/sentry/envelope", { body, contentType: "application/x-sentry-envelope" });
}

async function issues(ctx, action) {
  const issueId = ctx.command[2];
  if (action === "list") {
    return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}/issues`, {
      query: queryFromOptions(ctx.options, ["limit", "cursor", "status", "environment", "fingerprint"]),
    });
  }
  if (action === "get") {
    if (!issueId) throw usage("Expected `issues get <issue-id>`.");
    return request(ctx, "GET", `/api/projects/${encodeURIComponent(projectId(ctx))}/issues/${encodeURIComponent(issueId)}`, {
      query: queryFromOptions(ctx.options, ["limit", "cursor"]),
    });
  }
  if (action === "update") {
    if (!issueId) throw usage("Expected `issues update <issue-id>`.");
    return request(ctx, "PATCH", `/api/projects/${encodeURIComponent(projectId(ctx))}/issues/${encodeURIComponent(issueId)}`, {
      body: bodyFromOptions(ctx.options, [
        ["status", "status", "string"],
        ["assigned-to", "assigned_to", "nullableString"],
      ]),
    });
  }
  throw usage("Expected an issues action: list, get, update.");
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
    body: {
      release: requiredOption(ctx.options, "release"),
      file_name: stringOption(ctx.options, "file-name") ?? file,
      content,
    },
  });
}

async function request(ctx, method, path, options = {}) {
  const url = new URL(path.startsWith("http") ? path : `${ctx.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    url.searchParams.set(key, value === true ? "true" : String(value));
  }

  const headers = { accept: "application/json" };
  if (options.auth !== false) {
    if (!ctx.apiKey) throw new CliError("Missing API key. Set REWINDREWIND_API_KEY or run `rewindrewind configure --api-key <key>`.", 2);
    headers.authorization = `Bearer ${ctx.apiKey}`;
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

function projectId(ctx) {
  const id = stringOption(ctx.options, "project") ?? ctx.projectId;
  if (!id) throw new CliError("Missing project id. Pass --project, set REWINDREWIND_PROJECT_ID, or run `rewindrewind configure --project <id>`.", 2);
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
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      data += chunk;
    });
    stdin.on("end", () => resolve(data));
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
  return {
    ...config,
    apiKey: config.apiKey ? maskSecret(config.apiKey) : undefined,
  };
}

function maskSecret(value) {
  if (value.length <= 12) return "********";
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function configKey(name) {
  const keys = {
    "api-key": "apiKey",
    apiKey: "apiKey",
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

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntrypoint) {
  const status = await main();
  process.exitCode = status;
}
