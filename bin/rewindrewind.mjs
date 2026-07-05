#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://rewindrewind.com";
const VERSION = "0.3.0";

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
const DOCS_URL = `${DEFAULT_BASE_URL}/docs/exception-capture-sdk`;

const COMMAND_DIRECTORY = [
  { command: "status", summary: "Check admin auth; agents should run this first." },
  { command: "init", summary: "Configure auth, choose a project, fetch the public project key, print setup snippets." },
  { command: "verify", summary: "Send test event and exception data and confirm the setup works." },
  { command: "help [topic]", summary: "Show task help. Topics: agent, auth, sdk, events, exceptions, troubleshooting." },
  { command: "sdk list|show|snippet|env|primitives|doctor|upgrade", summary: "Machine-readable SDK setup pointers, agent hints, doctor checks, and upgrade plans." },
  { command: "configure | config get|set|unset", summary: "Read and write CLI config." },
  { command: "projects list|create|get|update|delete", summary: "Manage projects with an admin key." },
  { command: "events send|batch|list|raw", summary: "Send or inspect product analytics events." },
  { command: "exceptions send", summary: "Send an exception payload with the public project key." },
  { command: "issues list|get|update|resolve|reopen|snooze|archive|lifecycle", summary: "Inspect and manage exception issues." },
  { command: "comments list|create|update|delete", summary: "Work with issue comments." },
  { command: "sourcemaps upload", summary: "Upload JavaScript source maps for a release." },
  { command: "api <method> <path>", summary: "Generic API escape hatch; /v1/* uses project key, /api/* uses admin key." },
  { command: "health | openapi | export | ingestion-health | retention run", summary: "Service and operations commands." },
];

const GLOBAL_OPTIONS = [
  { option: "--api-key <key>", summary: "Admin key (rr_...). Also REWINDREWIND_API_KEY." },
  { option: "--api-key-file <path>", summary: "Read the admin key from a file." },
  { option: "--project-key <key>", summary: "Project ingestion key (rrpub_...). Also REWINDREWIND_PROJECT_KEY." },
  { option: "--project-key-file <path>", summary: "Read the project key from a file." },
  { option: "--project <id>", summary: "Project id. Also REWINDREWIND_PROJECT_ID." },
  { option: "--base-url <url>", summary: `API origin. Default: ${DEFAULT_BASE_URL}` },
  { option: "--json", summary: "Emit compact JSON on stdout for agents and scripts." },
  { option: "--pretty", summary: "Emit pretty-printed JSON on stdout." },
  { option: "--format <human|json|pretty>", summary: "Output format. Default: human." },
  { option: "--quiet | --verbose", summary: "Suppress normal output or print request URLs." },
];

const CORE_CONCEPTS = [
  {
    id: "events",
    label: "App events",
    summary: "Product or application facts such as checkout.completed. They are expected, queryable telemetry and should include type plus properties.",
    ingest: "/v1/events",
    cli: "rewindrewind events send --type checkout.completed --properties '{\"total\":42}'",
    docs_url: `${DOCS_URL}#events`,
  },
  {
    id: "exceptions",
    label: "Exceptions",
    summary: "Failures or error reports. They group into issues and should preserve message, stack, environment, release, and useful context.",
    ingest: "/v1/exceptions",
    cli: "rewindrewind exceptions send --message \"Stripe webhook failed\" --level error",
    docs_url: `${DOCS_URL}#exceptions`,
  },
];

const COMMON_PRIMITIVES = {
  initialize: {
    id: "initialize-client",
    purpose: "Create one client during app boot with project key, environment, release, and service tags.",
    required: true,
  },
  unhandled: {
    id: "capture-unhandled-exceptions",
    purpose: "Report request, job, or process-boundary failures before re-raising or preserving normal framework behavior.",
    required: true,
  },
  handled: {
    id: "capture-handled-exception",
    purpose: "Expose a small call for intentionally rescued errors that should still create or update an issue.",
    required: false,
  },
  event: {
    id: "capture-event",
    purpose: "Expose a small call for app events with a stable type and JSON properties.",
    required: false,
  },
  flush: {
    id: "flush-on-shutdown",
    purpose: "Drain pending telemetry before CLI, worker, serverless, or process shutdown exits.",
    required: "workers_clis_serverless",
  },
};

const JS_SDK_PACKAGES = ["@rewindrewind/sdk", "@rewindrewind/node"];

const SDK_GUIDES = {
  browser: {
    id: "browser",
    label: "Browser JavaScript",
    use_when: "Frontend apps that need uncaught error, unhandled rejection, and product event capture.",
    docs_url: `${DOCS_URL}#javascript-browser-apps`,
    install: ["<script src=\"https://rewindrewind.com/sdk/v1/rewind.js\"></script>", "or bundled apps: npm install @rewindrewind/sdk"],
    env: ["VITE_REWINDREWIND_PROJECT_KEY=rrpub_xxx", "VITE_REWINDREWIND_ENDPOINT=https://rewindrewind.com"],
    files: ["src/observability.ts or your app entrypoint"],
    verify: ["rewindrewind verify", "Trigger a handled test capture from the browser and check issues/events."],
    agent_hints: [
      "Prefer the CDN script when there is no bundler or when the app wants live SDK updates.",
      "For bundled apps, initialize before route rendering and reuse the exported client for app events.",
    ],
    integration_primitives: [
      { id: "load-sdk", purpose: "Load the browser SDK from CDN or package before app code reports telemetry.", required: true },
      COMMON_PRIMITIVES.initialize,
      { id: "capture-browser-errors", purpose: "Capture uncaught errors and unhandled promise rejections.", required: true },
      COMMON_PRIMITIVES.event,
    ],
    hook_hints: [
      { shape: "plain-html", likely_hooks: ["<head> script tag", "inline RewindRewind.init call after the script"] },
      { shape: "bundled-spa", likely_hooks: ["src/observability.ts", "main.tsx/main.jsx before rendering", "router or action handlers for app events"] },
    ],
    upgrade: {
      modes: ["cdn", "package"],
      hints: ["CDN mode updates from /sdk/v1/rewind.js automatically.", "Package mode should be checked by the package manager or `rewindrewind sdk upgrade browser`."],
    },
    snippets: [
      {
        title: "Initialize",
        language: "ts",
        code: `import { initRewind } from "@rewindrewind/sdk/browser";

export const rewind = initRewind({
  endpoint: import.meta.env.VITE_REWINDREWIND_ENDPOINT ?? "https://rewindrewind.com",
  apiKey: import.meta.env.VITE_REWINDREWIND_PROJECT_KEY,
  environment: import.meta.env.MODE === "production" ? "production" : "preview",
  release: import.meta.env.VITE_REWINDREWIND_RELEASE,
  tags: { service: "web" },
});`,
      },
      {
        title: "Capture an event",
        language: "ts",
        code: `await rewind.captureEvent("checkout.button_clicked", {
  path: window.location.pathname,
});`,
      },
    ],
  },
  node: {
    id: "node",
    label: "Node.js",
    use_when: "Node servers, workers, scripts, queues, and CLIs.",
    docs_url: `${DOCS_URL}#nodejs-apps`,
    install: ["npm install @rewindrewind/sdk", "or existing Node package: npm install @rewindrewind/node"],
    env: ["REWINDREWIND_PROJECT_KEY=rrpub_xxx", "REWINDREWIND_ENDPOINT=https://rewindrewind.com", "REWINDREWIND_RELEASE=<git-sha-or-version>"],
    files: ["src/observability.ts", "server entrypoint before routes/jobs start"],
    verify: ["rewindrewind verify", "Run one code path that calls captureEvent or captureException."],
    agent_hints: [
      "Initialize once near process startup before routes, jobs, or scripts run.",
      "For frameworks, wire unhandled exceptions at the request or job boundary and preserve normal error propagation.",
    ],
    integration_primitives: [
      COMMON_PRIMITIVES.initialize,
      COMMON_PRIMITIVES.unhandled,
      COMMON_PRIMITIVES.handled,
      COMMON_PRIMITIVES.event,
      COMMON_PRIMITIVES.flush,
    ],
    hook_hints: [
      { shape: "express/fastify/hono", likely_hooks: ["observability module", "request error middleware or onError hook", "process unhandledRejection/uncaughtException only as a last boundary"] },
      { shape: "nextjs/remix/server", likely_hooks: ["server entrypoint or instrumentation file", "route/action error boundary", "server-side event helper"] },
      { shape: "worker/cli", likely_hooks: ["script startup", "job wrapper try/catch", "finally/defer-style flush before exit"] },
    ],
    upgrade: {
      modes: ["package", "vendor"],
      hints: ["Package mode updates @rewindrewind/sdk or @rewindrewind/node through npm/pnpm/yarn/bun.", "Vendor mode should refresh the generated observability helper and rerun tests."],
    },
    snippets: [
      {
        title: "Initialize",
        language: "ts",
        code: `import { initRewind } from "@rewindrewind/sdk/node";

export const rewind = initRewind({
  endpoint: process.env.REWINDREWIND_ENDPOINT ?? "https://rewindrewind.com",
  apiKey: process.env.REWINDREWIND_PROJECT_KEY,
  environment: process.env.NODE_ENV === "production" ? "production" : "development",
  release: process.env.REWINDREWIND_RELEASE,
  tags: { service: "api", runtime: "node" },
  autoCapture: true,
});`,
      },
      {
        title: "Capture handled work",
        language: "ts",
        code: `try {
  await runJob(jobId);
  await rewind.captureEvent("job.completed", { job_id: jobId });
} catch (error) {
  await rewind.captureException(error, { job: { id: jobId } });
  throw error;
} finally {
  await rewind.flush();
}`,
      },
    ],
  },
  bun: {
    id: "bun",
    label: "Bun",
    use_when: "Bun servers and workers.",
    docs_url: `${DOCS_URL}#bun-apps`,
    install: ["bun add @rewindrewind/sdk", "or existing Node package: bun add @rewindrewind/node"],
    env: ["REWINDREWIND_PROJECT_KEY=rrpub_xxx", "REWINDREWIND_ENDPOINT=https://rewindrewind.com"],
    files: ["Bun entrypoint before Bun.serve"],
    verify: ["rewindrewind verify"],
    agent_hints: [
      "Initialize before Bun.serve or worker startup.",
      "Wire request errors at the framework boundary and call flush for short-lived scripts.",
    ],
    integration_primitives: [
      COMMON_PRIMITIVES.initialize,
      COMMON_PRIMITIVES.unhandled,
      COMMON_PRIMITIVES.handled,
      COMMON_PRIMITIVES.event,
      COMMON_PRIMITIVES.flush,
    ],
    hook_hints: [
      { shape: "bun-server", likely_hooks: ["entrypoint before Bun.serve", "fetch handler try/catch or framework onError", "process shutdown flush"] },
      { shape: "bun-worker", likely_hooks: ["worker startup", "job wrapper", "finally block flush"] },
    ],
    upgrade: {
      modes: ["package", "vendor"],
      hints: ["Package mode updates @rewindrewind/sdk or @rewindrewind/node through bun.", "Vendor mode should refresh the generated helper and rerun the app's tests."],
    },
    snippets: [
      {
        title: "Initialize",
        language: "ts",
        code: `import { initRewind } from "@rewindrewind/sdk/bun";

const rewind = initRewind({
  endpoint: Bun.env.REWINDREWIND_ENDPOINT ?? "https://rewindrewind.com",
  apiKey: Bun.env.REWINDREWIND_PROJECT_KEY,
  environment: Bun.env.REWINDREWIND_ENVIRONMENT ?? "production",
  release: Bun.env.REWINDREWIND_RELEASE,
  tags: { service: "edge-api", runtime: "bun" },
});`,
      },
    ],
  },
  ruby: {
    id: "ruby",
    label: "Ruby",
    use_when: "Rack apps, background jobs, and plain Ruby services.",
    docs_url: `${DOCS_URL}#ruby-apps`,
    install: ["gem install rewind_rewind", "or add `gem \"rewind_rewind\"` to your Gemfile"],
    env: ["REWINDREWIND_PROJECT_KEY=rrpub_xxx", "REWINDREWIND_ENDPOINT=https://rewindrewind.com"],
    files: ["config/observability.rb or app boot file"],
    verify: ["rewindrewind verify"],
    agent_hints: [
      "Initialize once during app boot and keep a reusable client/helper available.",
      "For unknown Ruby apps, look for Rack config, worker boot files, or top-level job wrappers before adding global rescue behavior.",
    ],
    integration_primitives: [
      COMMON_PRIMITIVES.initialize,
      COMMON_PRIMITIVES.unhandled,
      COMMON_PRIMITIVES.handled,
      COMMON_PRIMITIVES.event,
      COMMON_PRIMITIVES.flush,
    ],
    hook_hints: [
      { shape: "rack", likely_hooks: ["config.ru", "Rack middleware", "app boot file"] },
      { shape: "plain-ruby-worker", likely_hooks: ["worker boot file", "job execution wrapper", "at_exit flush"] },
      { shape: "script", likely_hooks: ["top-level begin/rescue", "at_exit flush", "explicit capture_event/capture_exception helper"] },
    ],
    upgrade: {
      modes: ["package", "vendor"],
      hints: ["Package mode updates rewind_rewind through bundler/rubygems.", "Vendor mode should refresh the generated Ruby helper and rerun tests/jobs."],
    },
    snippets: [
      {
        title: "Initialize",
        language: "ruby",
        code: `require "rewind_rewind"

REWIND = RewindRewind::Client.new(
  api_key: ENV.fetch("REWINDREWIND_PROJECT_KEY"),
  endpoint: ENV.fetch("REWINDREWIND_ENDPOINT", "https://rewindrewind.com"),
  environment: ENV.fetch("RACK_ENV", "production"),
  release: ENV["REWINDREWIND_RELEASE"],
  tags: { service: "web", runtime: "ruby" }
)`,
      },
    ],
  },
  rails: {
    id: "rails",
    label: "Rails",
    use_when: "Rails apps that want framework wiring plus the core Ruby SDK.",
    docs_url: `${DOCS_URL}#ruby-apps`,
    install: ["gem \"rewind_rewind-rails\""],
    env: ["REWINDREWIND_PROJECT_KEY=rrpub_xxx", "REWINDREWIND_RELEASE=<git-sha-or-version>"],
    files: ["Gemfile", "config/initializers/rewind_rewind.rb"],
    verify: ["rewindrewind verify"],
    agent_hints: [
      "Rails ergonomics come from using framework boundaries: initializer, middleware, ActiveJob, and optional job adapters.",
      "Preserve Rails error handling and re-raise after capture unless the app already intentionally swallows the error.",
    ],
    integration_primitives: [
      COMMON_PRIMITIVES.initialize,
      COMMON_PRIMITIVES.unhandled,
      COMMON_PRIMITIVES.handled,
      COMMON_PRIMITIVES.event,
      COMMON_PRIMITIVES.flush,
    ],
    hook_hints: [
      { shape: "rails", likely_hooks: ["config/initializers/rewind_rewind.rb", "Rack middleware", "ActiveJob around_perform/rescue_from", "Sidekiq server middleware if sidekiq is present"] },
      { shape: "rails-api", likely_hooks: ["initializer", "ActionController rescue/report hook", "middleware before request completion"] },
    ],
    upgrade: {
      modes: ["package", "vendor"],
      hints: ["Package mode updates rewind_rewind-rails with bundler.", "After upgrade, boot Rails and run request/job tests that exercise error paths."],
    },
    snippets: [
      {
        title: "Initializer",
        language: "ruby",
        code: `# config/initializers/rewind_rewind.rb
RewindRewind.configure do |config|
  config.api_key = ENV.fetch("REWINDREWIND_PROJECT_KEY")
  config.environment = Rails.env
  config.release = ENV["REWINDREWIND_RELEASE"]
  config.tags = { service: "rails" }
end`,
      },
    ],
  },
  python: {
    id: "python",
    label: "Python",
    use_when: "Plain Python, Flask, Bottle, WSGI apps, scripts, and workers.",
    docs_url: `${DOCS_URL}#python-apps`,
    install: ["pip install --index-url https://rewindrewind.com/pypi/simple/ rewind-rewind"],
    env: ["REWINDREWIND_PROJECT_KEY=rrpub_xxx", "REWINDREWIND_ENDPOINT=https://rewindrewind.com"],
    files: ["app startup module", "requirements.txt"],
    verify: ["rewindrewind verify"],
    agent_hints: [
      "Initialize once during app startup and wire framework middleware when available.",
      "For scripts and workers, capture at the job boundary and flush before process exit.",
    ],
    integration_primitives: [
      COMMON_PRIMITIVES.initialize,
      COMMON_PRIMITIVES.unhandled,
      COMMON_PRIMITIVES.handled,
      COMMON_PRIMITIVES.event,
      COMMON_PRIMITIVES.flush,
    ],
    hook_hints: [
      { shape: "wsgi", likely_hooks: ["app startup module", "WSGI middleware", "request error handler"] },
      { shape: "asgi", likely_hooks: ["ASGI middleware", "lifespan startup/shutdown", "exception handler"] },
      { shape: "worker/cli", likely_hooks: ["job wrapper", "top-level main", "finally flush"] },
    ],
    upgrade: {
      modes: ["package", "vendor"],
      hints: ["Package mode updates rewind-rewind through pip/uv/poetry.", "Vendor mode should refresh the generated Python helper and run tests."],
    },
    snippets: [
      {
        title: "Initialize",
        language: "py",
        code: `import os
import rewind_rewind

rewind_rewind.init(
    project_key=os.environ["REWINDREWIND_PROJECT_KEY"],
    endpoint=os.getenv("REWINDREWIND_ENDPOINT", "https://rewindrewind.com"),
    environment=os.getenv("ENVIRONMENT", "production"),
    release=os.getenv("GIT_SHA"),
    tags={"service": os.getenv("SERVICE_NAME", "python-app")},
)`,
      },
      {
        title: "WSGI middleware",
        language: "py",
        code: `from rewind_rewind.wsgi import RewindMiddleware

app.wsgi_app = RewindMiddleware(app.wsgi_app)`,
      },
    ],
  },
  go: {
    id: "go",
    label: "Go",
    use_when: "Go services and net/http servers.",
    docs_url: `${DOCS_URL}#go-apps`,
    install: ["go get rewindrewind.com/go"],
    env: ["REWINDREWIND_PROJECT_KEY=rrpub_xxx", "REWINDREWIND_ENDPOINT=https://rewindrewind.com"],
    files: ["main.go or observability package"],
    verify: ["rewindrewind verify"],
    agent_hints: [
      "Initialize in main or the service constructor, then pass/use the client at request and job boundaries.",
      "Go apps are usually explicit: prefer middleware or wrappers over hidden global behavior.",
    ],
    integration_primitives: [
      COMMON_PRIMITIVES.initialize,
      COMMON_PRIMITIVES.unhandled,
      COMMON_PRIMITIVES.handled,
      COMMON_PRIMITIVES.event,
      COMMON_PRIMITIVES.flush,
    ],
    hook_hints: [
      { shape: "net/http", likely_hooks: ["main.go before ListenAndServe", "middleware wrapping http.Handler", "panic recovery middleware"] },
      { shape: "gin/chi/echo/fiber", likely_hooks: ["framework middleware chain", "panic/recovery middleware", "request context enrichment"] },
      { shape: "worker/cli", likely_hooks: ["main startup", "job execution wrapper", "defer Flush()"] },
    ],
    upgrade: {
      modes: ["module", "vendor"],
      hints: ["Module mode updates rewindrewind.com/go through go get.", "Vendor mode should refresh source and run go test ./... ."],
    },
    snippets: [
      {
        title: "Initialize",
        language: "go",
        code: `import (
  "os"

  rewindrewind "rewindrewind.com/go"
)

rewindrewind.Init(rewindrewind.Config{
  Key:         os.Getenv("REWINDREWIND_PROJECT_KEY"),
  Environment: "production",
  Release:     os.Getenv("REWINDREWIND_RELEASE"),
})`,
      },
    ],
  },
};

const HELP_TOPICS = {
  agent: {
    id: "agent",
    title: "Agent Setup",
    summary: "Deterministic setup order for coding agents.",
    steps: [
      "Run `rewindrewind status --json` first.",
      "If `needs_api_key` is true, stop and ask the user for an admin API key that starts with rr_.",
      "Run `rewindrewind init --json` to fetch and save the public project key.",
      "Run `rewindrewind sdk doctor --json` and `rewindrewind sdk primitives <name> --json` to inspect the app and map hooks.",
      "Wire events and exceptions into the idiomatic framework boundaries.",
      "Run `rewindrewind verify --json` and report pass/fail.",
    ],
    see_also: ["help auth", "help sdk", "sdk doctor", "sdk upgrade", `${DEFAULT_BASE_URL}/llms.txt`],
  },
  auth: {
    id: "auth",
    title: "Auth And Keys",
    summary: "The CLI auto-selects admin vs project keys by command.",
    details: [
      "Admin key (rr_...): secret. Used for project management, issues, exports, and API reads.",
      "Project key (rrpub_...): public ingestion key. Used by SDKs, events send, exceptions send, source maps, and /v1/* API calls.",
      "Prefer `rewindrewind init --api-key-file <path>` or `config set api-key-file <path>` for long-lived agents.",
    ],
    see_also: ["status", "init", "configure", "config get"],
  },
  sdk: {
    id: "sdk",
    title: "SDK Setup",
    summary: "Use SDK guides as agent-readable primitives, not exhaustive framework installers.",
    details: [
      "Events are expected app facts; exceptions are failures that group into issues.",
      "Agents should inspect the project, then map primitives into existing boot, request, job, and shutdown boundaries.",
      "Humans can use hook hints to understand why an agent edits initializers, middleware, job wrappers, or app entrypoints.",
    ],
    commands: [
      "rewindrewind sdk list",
      "rewindrewind sdk show <name>",
      "rewindrewind sdk primitives <name>",
      "rewindrewind sdk doctor [name]",
      "rewindrewind sdk upgrade [name]",
      "rewindrewind sdk snippet <name>",
    ],
    sdks: Object.keys(SDK_GUIDES),
    see_also: ["sdk list", "sdk primitives node", "sdk doctor", "sdk upgrade rails", DOCS_URL],
  },
  events: {
    id: "events",
    title: "App Events",
    summary: "Product analytics events use the public project key.",
    details: [
      CORE_CONCEPTS[0].summary,
      "Use stable event names and put variable details in JSON properties.",
    ],
    commands: [
      "rewindrewind events send --type checkout.completed --properties '{\"total\":42}'",
      "rewindrewind events batch --file @events.json",
      "rewindrewind events list --environment production --limit 50",
      "rewindrewind events raw <event-id>",
    ],
    see_also: ["help sdk", `${DOCS_URL}#events`],
  },
  exceptions: {
    id: "exceptions",
    title: "Exceptions And Issues",
    summary: "SDKs and `exceptions send` ingest exceptions; issue commands manage grouped failures.",
    details: [
      CORE_CONCEPTS[1].summary,
      "Capture at framework boundaries and preserve normal error propagation unless the app already handles the error.",
    ],
    commands: [
      "rewindrewind exceptions send --message \"Stripe webhook failed\" --level error",
      "rewindrewind issues list --status open",
      "rewindrewind issues get <issue-id>",
      "rewindrewind issues resolve <issue-id> --reason \"fixed in web@1.4.3\"",
      "rewindrewind sourcemaps upload --release web@1.4.3 --file dist/app.js.map",
    ],
    see_also: ["help sdk browser", "help sdk node", `${DOCS_URL}#exceptions`],
  },
  troubleshooting: {
    id: "troubleshooting",
    title: "Troubleshooting",
    summary: "Fast checks when setup or ingestion fails.",
    steps: [
      "Run `rewindrewind status` for a human-readable check, or `rewindrewind status --json` for automation.",
      "Run `rewindrewind config get` and confirm baseUrl, projectId, and projectKey.",
      "Run `rewindrewind verify --environment development` to exercise service, event, and exception ingestion.",
      "If ingestion commands complain about rr_ vs rrpub_, re-run `rewindrewind init` to fetch the public project key.",
      "Use `rewindrewind --verbose <command>` to print request URLs.",
    ],
    see_also: ["ingestion-health", "health", "openapi", "api get /api/projects"],
  },
};

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
      writeHelp(streams.stdout, parsed.positionals, parsed.options);
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
      format: outputFormat(parsed.options, io, config),
      quiet: booleanOption(parsed.options, "quiet"),
      verbose: booleanOption(parsed.options, "verbose"),
      options: parsed.options,
      command: parsed.positionals,
      cwd: io.cwd ?? process.cwd(),
    };

    const result = await dispatch(ctx);
    if (result !== undefined && !ctx.quiet) writeOutput(streams.stdout, result, ctx.format, ctx.command);
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
    case "help":
      return helpCommand(ctx);
    case "sdk":
      return sdkCommand(ctx, action);
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

function writeHelp(stream, args = [], options = {}) {
  const payload = helpPayload(args);
  const format = helpFormat(options);
  if (format === "json" || format === "pretty") {
    writeOutput(stream, payload, format);
    return;
  }
  stream.write(renderHelp(payload));
}

function helpCommand(ctx) {
  writeHelp(ctx.streams.stdout, ctx.command.slice(1), ctx.options);
}

async function sdkCommand(ctx, action) {
  const sdkId = normalizeSdkId(ctx.command[2]);
  if (!action || action === "list") {
    return {
      ok: true,
      docs_url: DOCS_URL,
      concepts: CORE_CONCEPTS,
      sdks: Object.values(SDK_GUIDES).map((sdk) => ({
        id: sdk.id,
        label: sdk.label,
        use_when: sdk.use_when,
        help: `rewindrewind help sdk ${sdk.id}`,
        json: `rewindrewind sdk show ${sdk.id}`,
        primitives: `rewindrewind sdk primitives ${sdk.id}`,
      })),
    };
  }
  if (action === "show") {
    const sdk = sdkGuide(sdkId);
    return { ok: true, sdk };
  }
  if (action === "primitives" || action === "primitive") {
    const sdk = sdkGuide(sdkId);
    return sdkPrimitivePayload(sdk);
  }
  if (action === "doctor" || action === "status") {
    return sdkDoctor(ctx, sdkId || undefined);
  }
  if (action === "upgrade" || action === "update") {
    return sdkUpgradePlan(ctx, sdkId || undefined);
  }
  if (action === "snippet" || action === "snippets") {
    const sdk = sdkGuide(sdkId);
    return { ok: true, sdk: sdk.id, snippets: sdk.snippets, docs_url: sdk.docs_url };
  }
  if (action === "env") {
    return {
      ok: true,
      env: {
        admin: {
          REWINDREWIND_API_KEY: "rr_xxx (secret admin key; CLI management only)",
          REWINDREWIND_API_KEY_FILE: "path to a file containing the admin key",
        },
        project: {
          REWINDREWIND_PROJECT_KEY: "rrpub_xxx (public ingestion key for SDKs)",
          REWINDREWIND_PROJECT_KEY_FILE: "path to a file containing the project key",
          REWINDREWIND_PROJECT_ID: "project id for admin read/update commands",
          REWINDREWIND_BASE_URL: DEFAULT_BASE_URL,
        },
      },
      note: "Run `rewindrewind init` to fetch and save the project key after configuring an admin key.",
    };
  }
  throw usage("Expected an sdk action: list, show <name>, primitives <name>, doctor [name], upgrade [name], snippet <name>, env.");
}

function sdkPrimitivePayload(sdk) {
  return {
    ok: true,
    sdk: { id: sdk.id, label: sdk.label, use_when: sdk.use_when, docs_url: sdk.docs_url },
    concepts: CORE_CONCEPTS,
    integration_primitives: sdk.integration_primitives ?? [],
    hook_hints: sdk.hook_hints ?? [],
    agent_hints: sdk.agent_hints ?? [],
    commands: {
      doctor: `rewindrewind sdk doctor ${sdk.id}`,
      upgrade_plan: `rewindrewind sdk upgrade ${sdk.id}`,
      snippets: `rewindrewind sdk snippet ${sdk.id}`,
      docs: sdk.docs_url,
    },
  };
}

async function sdkDoctor(ctx, targetRaw) {
  const detections = await detectProjectSdks(ctx);
  const target = targetRaw ? sdkGuide(targetRaw) : sdkGuide((detections[0]?.id ?? "node"));
  const projectKey = await resolveKey(ctx, "project", { optional: true });
  const adminKey = await resolveKey(ctx, "admin", { optional: true });
  const installState = await sdkInstallState(ctx, target.id);
  const checks = [
    {
      id: "project-key",
      ok: Boolean(projectKey),
      detail: projectKey ? "project ingestion key is configured" : "missing rrpub_ project key; run `rewindrewind init` or set REWINDREWIND_PROJECT_KEY",
    },
    {
      id: "admin-key",
      ok: Boolean(adminKey),
      detail: adminKey ? "admin key is configured for management checks" : "missing rr_ admin key; ingestion can still work with only a project key",
    },
    {
      id: "runtime-detected",
      ok: detections.some((item) => item.id === target.id) || targetRaw === undefined ? true : null,
      detail: detections.length ? detections.map((item) => `${item.id}:${item.confidence}`).join(", ") : "no obvious runtime files found",
    },
    {
      id: "sdk-reference",
      ok: installState.found ? true : null,
      detail: installState.detail,
    },
  ];
  return {
    ok: checks.every((check) => check.ok !== false),
    cwd: ctx.cwd,
    target: { id: target.id, label: target.label, docs_url: target.docs_url },
    detected: detections,
    concepts: CORE_CONCEPTS,
    checks,
    hook_hints: target.hook_hints ?? [],
    agent_hints: target.agent_hints ?? [],
    next_steps: [
      `rewindrewind sdk primitives ${target.id}`,
      `rewindrewind sdk upgrade ${target.id}`,
      "rewindrewind verify",
      target.docs_url,
    ],
  };
}

async function sdkUpgradePlan(ctx, targetRaw) {
  const detections = await detectProjectSdks(ctx);
  const target = targetRaw ? sdkGuide(targetRaw) : sdkGuide((detections[0]?.id ?? "node"));
  const installState = await sdkInstallState(ctx, target.id);
  const mode = stringOption(ctx.options, "mode") ?? installState.mode ?? target.upgrade?.modes?.[0] ?? "package";
  return {
    ok: true,
    cwd: ctx.cwd,
    target: { id: target.id, label: target.label, docs_url: target.docs_url },
    mode,
    detected: detections,
    current: installState,
    plan: [
      {
        step: "doctor",
        command: `rewindrewind sdk doctor ${target.id}`,
        purpose: "Confirm keys, detected stack, and existing SDK references.",
      },
      {
        step: "review-primitives",
        command: `rewindrewind sdk primitives ${target.id}`,
        purpose: "Map events and exceptions into the app's boot, request, job, and shutdown boundaries.",
      },
      {
        step: "update-sdk",
        purpose: sdkUpdatePurpose(target, mode),
        hints: target.upgrade?.hints ?? [],
      },
      {
        step: "verify",
        command: "rewindrewind verify",
        purpose: "Send a test event and exception and confirm ingestion.",
      },
      {
        step: "run-app-tests",
        purpose: "Run the project's normal tests or smoke checks around request/job error paths.",
      },
    ],
    agent_instructions: [
      "Inspect the project before editing; use framework conventions already present in the app.",
      "Preserve normal error propagation after capture unless the existing app intentionally handles the error.",
      "Keep event names stable and put variable details in properties.",
      "Prefer a small local observability helper so application code does not spread SDK setup everywhere.",
    ],
  };
}

function sdkUpdatePurpose(sdk, mode) {
  const packageCommands = {
    browser: "If using package mode, update @rewindrewind/sdk; CDN mode updates from /sdk/v1/rewind.js automatically.",
    node: "Update @rewindrewind/sdk or @rewindrewind/node with the project's package manager, or refresh the vendored helper in vendor mode.",
    bun: "Update @rewindrewind/sdk or @rewindrewind/node with bun, or refresh the vendored helper in vendor mode.",
    ruby: "Update rewind_rewind with bundler/rubygems, or refresh the vendored helper in vendor mode.",
    rails: "Update rewind_rewind-rails with bundler, then boot Rails and exercise request/job error paths.",
    python: "Update rewind-rewind with pip/uv/poetry, or refresh the vendored helper in vendor mode.",
    go: "Update rewindrewind.com/go with go get, or refresh vendored source in vendor mode.",
  };
  return `${packageCommands[sdk.id] ?? "Update the SDK using the selected mode."} Selected mode: ${mode}.`;
}

async function detectProjectSdks(ctx) {
  const detections = [];
  const packageJson = await readProjectJson(ctx, "package.json");
  if (packageJson) {
    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    const evidence = ["package.json"];
    let id = "node";
    let confidence = "medium";
    if (deps.next || deps["@remix-run/node"] || deps.hono || deps.express || deps.fastify) {
      id = "node";
      confidence = "high";
      evidence.push(deps.next ? "next dependency" : deps["@remix-run/node"] ? "remix dependency" : deps.hono ? "hono dependency" : deps.express ? "express dependency" : "fastify dependency");
    } else if (deps.vite || deps.react || deps.vue || deps.svelte || deps["@angular/core"]) {
      id = "browser";
      confidence = "high";
      evidence.push("frontend dependency");
    }
    const jsSdkPackage = JS_SDK_PACKAGES.find((name) => deps[name]);
    if (jsSdkPackage) evidence.push(`${jsSdkPackage} dependency`);
    detections.push({ id, confidence, evidence });
    if (id !== "browser" && (deps.vite || deps.react || deps.vue || deps.svelte)) {
      detections.push({ id: "browser", confidence: "medium", evidence: ["package.json", "frontend dependency"] });
    }
  }

  const gemfile = await readProjectFile(ctx, "Gemfile");
  if (gemfile) {
    const id = /\bgem\s+["']rails["']/.test(gemfile) ? "rails" : "ruby";
    const evidence = ["Gemfile"];
    if (/rewind_rewind/.test(gemfile)) evidence.push("rewind_rewind gem reference");
    detections.push({ id, confidence: "high", evidence });
  } else if (await readProjectFile(ctx, "config.ru")) {
    detections.push({ id: "ruby", confidence: "medium", evidence: ["config.ru"] });
  }

  const goMod = await readProjectFile(ctx, "go.mod");
  if (goMod) {
    const evidence = ["go.mod"];
    if (/rewindrewind\.com\/go/.test(goMod)) evidence.push("rewindrewind.com/go module reference");
    detections.push({ id: "go", confidence: "high", evidence });
  }

  const pyproject = await readProjectFile(ctx, "pyproject.toml");
  const requirements = await readProjectFile(ctx, "requirements.txt");
  if (pyproject || requirements) {
    const evidence = [pyproject ? "pyproject.toml" : null, requirements ? "requirements.txt" : null].filter(Boolean);
    if (/rewind[-_]rewind/.test(`${pyproject ?? ""}\n${requirements ?? ""}`)) evidence.push("rewind-rewind dependency reference");
    detections.push({ id: "python", confidence: "high", evidence });
  }

  const indexHtml = await readProjectFile(ctx, "index.html") ?? await readProjectFile(ctx, "public/index.html");
  if (indexHtml && !detections.some((item) => item.id === "browser")) {
    const evidence = [/rewindrewind\.com\/sdk\/v1\/rewind\.js/.test(indexHtml) ? "browser SDK script tag" : "index.html"];
    detections.push({ id: "browser", confidence: "medium", evidence });
  }

  return dedupeDetections(detections);
}

async function sdkInstallState(ctx, sdkId) {
  const packageJson = await readProjectJson(ctx, "package.json");
  if ((sdkId === "node" || sdkId === "browser" || sdkId === "bun") && packageJson) {
    const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
    const packageName = JS_SDK_PACKAGES.find((name) => deps[name]);
    if (packageName) return { found: true, mode: "package", detail: `${packageName} ${deps[packageName]}` };
  }
  const gemfile = await readProjectFile(ctx, "Gemfile");
  if ((sdkId === "ruby" || sdkId === "rails") && gemfile && /rewind_rewind/.test(gemfile)) {
    return { found: true, mode: "package", detail: "Gemfile references rewind_rewind" };
  }
  const goMod = await readProjectFile(ctx, "go.mod");
  if (sdkId === "go" && goMod && /rewindrewind\.com\/go/.test(goMod)) {
    return { found: true, mode: "module", detail: "go.mod references rewindrewind.com/go" };
  }
  const pythonDeps = `${await readProjectFile(ctx, "pyproject.toml") ?? ""}\n${await readProjectFile(ctx, "requirements.txt") ?? ""}`;
  if (sdkId === "python" && /rewind[-_]rewind/.test(pythonDeps)) {
    return { found: true, mode: "package", detail: "Python dependency file references rewind-rewind" };
  }
  const browserEntry = `${await readProjectFile(ctx, "index.html") ?? ""}\n${await readProjectFile(ctx, "public/index.html") ?? ""}`;
  if (sdkId === "browser" && /rewindrewind\.com\/sdk\/v1\/rewind\.js/.test(browserEntry)) {
    return { found: true, mode: "cdn", detail: "HTML references /sdk/v1/rewind.js" };
  }
  return { found: false, mode: undefined, detail: `No obvious ${sdkId} SDK reference found; inspect app-specific observability helpers too.` };
}

async function readProjectJson(ctx, relativePath) {
  const text = await readProjectFile(ctx, relativePath);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readProjectFile(ctx, relativePath) {
  try {
    return await readFile(resolve(ctx.cwd, relativePath), "utf8");
  } catch {
    return undefined;
  }
}

function dedupeDetections(detections) {
  const byId = new Map();
  for (const item of detections) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    const confidence = confidenceRank(item.confidence) > confidenceRank(existing.confidence) ? item.confidence : existing.confidence;
    byId.set(item.id, { id: item.id, confidence, evidence: [...new Set([...existing.evidence, ...item.evidence])] });
  }
  return [...byId.values()].sort((a, b) => confidenceRank(b.confidence) - confidenceRank(a.confidence));
}

function confidenceRank(value) {
  return { high: 3, medium: 2, low: 1 }[value] ?? 0;
}

function helpPayload(args = []) {
  const normalized = args.filter(Boolean).map((arg) => String(arg).toLowerCase());
  if (normalized.length === 0) return helpDirectoryPayload();
  if (normalized[0] === "help") return helpDirectoryPayload();
  if (normalized[0] === "sdk" && normalized[1]) return { kind: "sdk", sdk: sdkGuide(normalizeSdkId(normalized[1])) };
  if (normalized[0] === "sdk") return { kind: "topic", topic: HELP_TOPICS.sdk };
  const topic = HELP_TOPICS[normalized[0]];
  if (topic) return { kind: "topic", topic };
  const command = COMMAND_DIRECTORY.find((item) => item.command.split(/\s|\|/)[0] === normalized[0]);
  if (command) return { kind: "command", command, related: commandHelp(normalized[0]) };
  throw usage(`Unknown help topic: ${args.join(" ")}`);
}

function helpDirectoryPayload() {
  return {
    kind: "directory",
    name: "rewindrewind",
    version: VERSION,
    summary: "RewindRewind CLI for humans and agents.",
    quick_start: [
      "rewindrewind status",
      "rewindrewind init --api-key rr_xxx",
      "rewindrewind verify",
    ],
    topics: Object.values(HELP_TOPICS).map((topic) => ({
      id: topic.id,
      title: topic.title,
      command: `rewindrewind help ${topic.id}`,
      summary: topic.summary,
    })),
    sdk_guides: Object.values(SDK_GUIDES).map((sdk) => ({
      id: sdk.id,
      label: sdk.label,
      command: `rewindrewind help sdk ${sdk.id}`,
      summary: sdk.use_when,
    })),
    commands: COMMAND_DIRECTORY,
    global_options: GLOBAL_OPTIONS,
  };
}

function renderHelp(payload) {
  if (payload.kind === "directory") return renderDirectoryHelp(payload);
  if (payload.kind === "topic") return renderTopicHelp(payload.topic);
  if (payload.kind === "sdk") return renderSdkHelp(payload.sdk);
  if (payload.kind === "command") return renderCommandHelp(payload.command, payload.related);
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderDirectoryHelp(payload) {
  return `rewindrewind ${payload.version} - ${payload.summary}

Usage:
  rewindrewind <command> [options]
  rr <command> [options]

First run:
  rewindrewind status                  Check whether an admin key is configured
  rewindrewind init --api-key rr_xxx   Configure, choose a project, fetch the public key
  rewindrewind verify                  Send test data and confirm it lands

Help directory:
${formatRows(payload.topics.map((topic) => [topic.command, topic.summary]), 38)}

SDK setup:
${formatRows(payload.sdk_guides.map((sdk) => [sdk.command, sdk.label]), 38)}

Commands:
${formatRows(payload.commands.map((item) => [item.command, item.summary]), 46)}

Global options:
${formatRows(payload.global_options.map((item) => [item.option, item.summary]), 28)}

Machine-readable help:
  rewindrewind --help --json
  rewindrewind help sdk node --json
  rewindrewind sdk list --json
  rewindrewind sdk primitives node --json
  rewindrewind sdk doctor --json
`;
}

function renderTopicHelp(topic) {
  const lines = [`${topic.title}`, "", topic.summary, ""];
  if (topic.steps) lines.push("Steps:", ...topic.steps.map((step) => `  ${step}`), "");
  if (topic.details) lines.push("Details:", ...topic.details.map((detail) => `  ${detail}`), "");
  if (topic.commands) lines.push("Commands:", ...topic.commands.map((cmd) => `  ${cmd}`), "");
  if (topic.sdks) lines.push("SDK guides:", ...topic.sdks.map((id) => `  rewindrewind help sdk ${id}`), "");
  if (topic.see_also) lines.push("See also:", ...topic.see_also.map((item) => `  ${item}`), "");
  return `${lines.join("\n")}\n`;
}

function formatRows(rows, width) {
  return rows.map(([left, right]) => {
    if (left.length > width) return `  ${left}\n  ${"".padEnd(width)} ${right}`;
    return `  ${left.padEnd(width)} ${right}`;
  }).join("\n");
}

function renderSdkHelp(sdk) {
  const lines = [
    `${sdk.label} SDK`,
    "",
    sdk.use_when,
    "",
    "Install:",
    ...sdk.install.map((cmd) => `  ${cmd}`),
    "",
    "Environment:",
    ...sdk.env.map((entry) => `  ${entry}`),
    "",
    "Where to wire it:",
    ...sdk.files.map((file) => `  ${file}`),
    "",
    "Core concepts:",
    "  App events are expected app facts with stable names and JSON properties.",
    "  Exceptions are failures that group into issues and should preserve stack/context.",
    "",
    "Agent wiring:",
    `  ${sdk.integration_primitives?.map((primitive) => primitive.id).join(", ")}`,
    "",
    "Hook hints:",
    ...(sdk.hook_hints ?? []).map((hint) => `  ${hint.shape}: ${hint.likely_hooks.join("; ")}`),
    "",
  ];
  for (const snippet of sdk.snippets) {
    lines.push(`${snippet.title}:`, fence(snippet.language, snippet.code), "");
  }
  if (sdk.agent_hints?.length) lines.push("Agent hints:", ...sdk.agent_hints.map((hint) => `  ${hint}`), "");
  lines.push("Verify:", ...sdk.verify.map((cmd) => `  ${cmd}`), "", `Full docs: ${sdk.docs_url}`, `Agent JSON: rewindrewind sdk primitives ${sdk.id}`, "");
  return `${lines.join("\n")}\n`;
}

function renderCommandHelp(command, related) {
  const lines = [command.command, "", command.summary, ""];
  if (related?.usage) lines.push("Usage:", ...related.usage.map((item) => `  ${item}`), "");
  if (related?.see_also) lines.push("See also:", ...related.see_also.map((item) => `  ${item}`), "");
  return `${lines.join("\n")}\n`;
}

function commandHelp(name) {
  const map = {
    status: { usage: ["rewindrewind status"], see_also: ["help agent", "help auth"] },
    init: { usage: ["rewindrewind init --api-key rr_xxx", "rewindrewind init --api-key-file /run/secrets/rr.key"], see_also: ["help sdk", "verify"] },
    verify: { usage: ["rewindrewind verify", "rewindrewind verify --environment production"], see_also: ["help troubleshooting"] },
    sdk: { usage: HELP_TOPICS.sdk.commands, see_also: ["help sdk", "sdk primitives node", "sdk doctor", "sdk upgrade"] },
    events: { usage: HELP_TOPICS.events.commands, see_also: ["help events", "help sdk"] },
    exceptions: { usage: HELP_TOPICS.exceptions.commands, see_also: ["help exceptions", "help sdk"] },
    issues: { usage: ["rewindrewind issues list --status open", "rewindrewind issues get <issue-id>", "rewindrewind issues resolve <issue-id> --reason <text>"], see_also: ["help exceptions"] },
    api: { usage: ["rewindrewind api get /api/projects", "rewindrewind api post /v1/events --data @event.json", "rewindrewind api get /openapi.json --no-auth"], see_also: ["openapi"] },
  };
  return map[name];
}

function sdkGuide(id) {
  const sdk = SDK_GUIDES[id];
  if (!sdk) throw usage(`Unknown SDK: ${id}. Run \`rewindrewind help sdk\` or \`rewindrewind sdk list\`.`);
  return sdk;
}

function normalizeSdkId(value) {
  const id = String(value ?? "").toLowerCase();
  const aliases = {
    js: "browser",
    javascript: "browser",
    frontend: "browser",
    "front-end": "browser",
    web: "browser",
    nodejs: "node",
    "node.js": "node",
    py: "python",
    rb: "ruby",
    golang: "go",
  };
  return aliases[id] ?? id;
}

function fence(language, code) {
  return `\`\`\`${language}\n${code}\n\`\`\``;
}

// `status` is the agent's first step: it answers "do we have a working admin
// key?" without throwing. If no key is configured the agent should ask the user
// for one before doing anything else.
async function statusCommand(ctx) {
  const adminKey = await resolveKey(ctx, "admin", { optional: true });
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
  const projectKeyProbe = await safe(() => resolveKey(ctx, "project", { optional: true }));
  const projectsList = Array.isArray(probe.value?.projects) ? probe.value.projects : [];
  return compact({
    ...base,
    ready: true,
    needs_api_key: false,
    admin_key: maskSecret(adminKey),
    account: projectsList[0]?.account_id ?? null,
    projects: projectsList.map((p) => ({ id: p.id, name: p.name })),
    project_id: ctx.projectId ?? (projectsList.length === 1 ? projectsList[0].id : undefined),
    has_project_key: projectKeyProbe.ok && Boolean(projectKeyProbe.value),
    project_key_warning: projectKeyProbe.ok ? undefined : projectKeyProbe.error,
    surfaces: ["front-end exceptions", "back-end exceptions", "app events"],
  });
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

  const printEnv = booleanOption(ctx.options, "print-env");
  return {
    ok: true,
    config_path: ctx.configPath,
    base_url: ctx.baseUrl,
    project_id: project.id,
    project_name: project.name,
    project_key: projectKey,
    auth: apiKeyFile ? { admin_key_file: apiKeyFile } : { admin_key: maskSecret(adminKey) },
    environment: printEnv ? {
      REWINDREWIND_BASE_URL: ctx.baseUrl,
      REWINDREWIND_PROJECT_ID: project.id,
      REWINDREWIND_PROJECT_KEY: projectKey,
    } : undefined,
    next_steps: ["rewindrewind verify", "rewindrewind help sdk", `${ctx.baseUrl}/docs/exception-capture-sdk`],
    sdk_guides: Object.keys(SDK_GUIDES).map((id) => ({ id, command: `rewindrewind help sdk ${id}` })),
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
SDK guides:                 rewindrewind help sdk
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
    checks.push({ check: "event confirmed in project", surface: "app events", ok: !found.ok ? false : confirmed ? true : null, detail: !found.ok ? found.error : confirmed ? "found" : "not found yet (ingestion may be async)" });
  } else {
    checks.push({ check: "event confirmed in project", surface: "app events", ok: null, detail: "skipped (set an admin key and --project to confirm)" });
  }

  const passed = checks.filter((c) => c.ok === true).length;
  const failed = checks.filter((c) => c.ok === false);
  const result = { ok: failed.length === 0, passed, failed: failed.length, checks, dashboard: pid ? `${ctx.baseUrl}/projects/${pid}` : undefined };
  if (failed.length > 0) {
    // Surface a non-zero exit for scripts/agents without throwing away the JSON.
    if (!ctx.quiet) writeOutput(ctx.streams.stdout, result, ctx.format, ctx.command);
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

function outputFormat(options, io = {}, config = {}) {
  if (booleanOption(options, "json")) return "json";
  if (booleanOption(options, "pretty")) return "pretty";
  const requested = stringOption(options, "format") ?? env("REWINDREWIND_FORMAT", io) ?? config.format ?? "human";
  if (!["human", "json", "pretty"].includes(requested)) throw usage(`Unknown output format: ${requested}. Expected human, json, or pretty.`);
  return requested;
}

function helpFormat(options) {
  if (booleanOption(options, "json")) return "json";
  if (booleanOption(options, "pretty")) return "pretty";
  const requested = stringOption(options, "format") ?? "human";
  if (!["human", "json", "pretty"].includes(requested)) throw usage(`Unknown output format: ${requested}. Expected human, json, or pretty.`);
  return requested;
}

function writeOutput(stream, value, format, command = []) {
  if (format === "pretty") {
    stream.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (format === "json") {
    stream.write(`${JSON.stringify(value)}\n`);
    return;
  }
  stream.write(renderHumanOutput(value, command));
}

function renderHumanOutput(value, command = []) {
  const group = command[0];
  if (group === "status") return renderStatusOutput(value);
  if (group === "init") return renderInitOutput(value);
  if (group === "verify") return renderVerifyOutput(value);
  if (group === "configure") return renderConfigureOutput(value);
  if (group === "config") return renderConfigOutput(value);
  if (group === "sdk") return renderSdkCommandOutput(value, command[1]);
  return renderGenericOutput(value, titleFromCommand(command));
}

function renderStatusOutput(value) {
  const lines = [`RewindRewind status: ${value.ready ? "ready" : "not ready"}`, ""];
  lines.push(`Base URL: ${value.base_url}`);
  lines.push(`Config: ${value.config_path}`);
  if (value.admin_key) lines.push(`Admin key: ${value.admin_key}`);
  if (value.needs_api_key) {
    lines.push("", value.action);
    return `${lines.join("\n")}\n`;
  }
  if (value.account) lines.push(`Account: ${value.account}`);
  const selectedProject = Array.isArray(value.projects) ? value.projects.find((project) => project.id === value.project_id) : undefined;
  if (value.project_id) {
    lines.push(`Selected project: ${selectedProject?.name ? `${selectedProject.name} (${value.project_id})` : value.project_id}`);
  }
  lines.push(`Project key: ${value.has_project_key ? "configured" : "missing"}`);
  if (value.project_key_warning) lines.push(`Project key warning: ${value.project_key_warning}`);
  if (Array.isArray(value.projects)) {
    lines.push(`Projects: ${value.projects.length} available (run \`rewindrewind projects list\` for details)`);
  }
  if (Array.isArray(value.surfaces)) lines.push("", "Surfaces:", ...value.surfaces.map((surface) => `  ${surface}`));
  return `${lines.join("\n")}\n`;
}

function renderInitOutput(value) {
  const lines = [setupGuide(value.base_url, { id: value.project_id, name: value.project_name }, value.project_key).trimEnd()];
  lines.push("", `Config: ${value.config_path}`);
  if (value.auth?.admin_key_file) lines.push(`Admin key file: ${value.auth.admin_key_file}`);
  if (value.auth?.admin_key) lines.push(`Admin key: ${value.auth.admin_key}`);
  if (value.environment) {
    lines.push("", "Environment variables:");
    for (const [key, envValue] of Object.entries(value.environment)) lines.push(`${key}=${envValue}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderVerifyOutput(value) {
  const lines = [`RewindRewind verify: ${value.ok ? "passed" : "failed"}`, ""];
  for (const check of value.checks ?? []) {
    const mark = check.ok === true ? "ok" : check.ok === false ? "FAIL" : "skip";
    lines.push(`[${mark}] ${check.check}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  lines.push("", `Passed: ${value.passed ?? 0}`);
  lines.push(`Failed: ${value.failed ?? 0}`);
  if (value.dashboard) lines.push(`Dashboard: ${value.dashboard}`);
  return `${lines.join("\n")}\n`;
}

function renderConfigureOutput(value) {
  const lines = ["Configuration updated", "", `Config: ${value.config_path}`];
  return `${lines.concat(renderObjectLines(value.configured ?? {}, 0)).join("\n")}\n`;
}

function renderConfigOutput(value) {
  const lines = ["RewindRewind config", "", `Config: ${value.config_path}`];
  return `${lines.concat(renderObjectLines(value.config ?? {}, 0)).join("\n")}\n`;
}

function renderSdkCommandOutput(value, action) {
  if (action === "list" || !action) {
    const lines = ["SDK guides", ""];
    for (const sdk of value.sdks ?? []) lines.push(`${sdk.id.padEnd(8)} ${sdk.label} - ${sdk.use_when}`);
    lines.push("", "Use --json for machine-readable concepts and command metadata.");
    return `${lines.join("\n")}\n`;
  }
  if (action === "doctor" || action === "status") {
    const lines = [`SDK doctor: ${value.target?.label ?? value.target?.id ?? "unknown"}`, "", `Directory: ${value.cwd}`];
    lines.push("", "Checks:");
    for (const check of value.checks ?? []) lines.push(`  [${check.ok === true ? "ok" : check.ok === false ? "FAIL" : "skip"}] ${check.id}: ${check.detail}`);
    if (value.detected?.length) {
      lines.push("", "Detected:");
      for (const item of value.detected) lines.push(`  ${item.id} (${item.confidence}): ${item.evidence.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (action === "upgrade" || action === "update") {
    const lines = [`SDK upgrade plan: ${value.target?.label ?? value.target?.id ?? "unknown"}`, "", `Mode: ${value.mode}`];
    for (const item of value.plan ?? []) lines.push("", `${item.step}:`, `  ${item.command ?? item.purpose}`, item.command ? `  ${item.purpose}` : undefined);
    return `${lines.filter(Boolean).join("\n")}\n`;
  }
  return renderGenericOutput(value, `sdk ${action}`);
}

function renderGenericOutput(value, title) {
  if (typeof value !== "object" || value === null) return `${String(value)}\n`;
  const lines = [title, ""];
  if (value.ok !== undefined) lines[0] = `${title}: ${value.ok ? "ok" : "failed"}`;
  for (const [key, item] of Object.entries(value)) {
    if (key === "ok") continue;
    lines.push(...renderValueLines(labelize(key), item, 0));
  }
  return `${lines.join("\n")}\n`;
}

function renderValueLines(label, value, indent) {
  const prefix = " ".repeat(indent);
  if (value === undefined) return [];
  if (value === null || typeof value !== "object") return [`${prefix}${label}: ${String(value)}`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}${label}: none`];
    if (value.every((item) => item === null || typeof item !== "object")) return [`${prefix}${label}:`, ...value.map((item) => `${prefix}  ${String(item)}`)];
    return [`${prefix}${label}:`, ...value.flatMap((item) => renderObjectSummary(item, indent + 2))];
  }
  return [`${prefix}${label}:`, ...renderObjectLines(value, indent + 2)];
}

function renderObjectLines(value, indent) {
  return Object.entries(value).flatMap(([key, item]) => renderValueLines(labelize(key), item, indent));
}

function renderObjectSummary(value, indent) {
  const prefix = " ".repeat(indent);
  if (value === null || typeof value !== "object") return [`${prefix}${String(value)}`];
  const summaryKeys = ["id", "name", "title", "type", "status", "message", "event_id", "issue_id"];
  const summary = summaryKeys.filter((key) => value[key] !== undefined).map((key) => `${key}=${value[key]}`).join("  ");
  if (summary) return [`${prefix}${summary}`];
  return renderObjectLines(value, indent);
}

function labelize(value) {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function titleFromCommand(command) {
  return command.filter(Boolean).join(" ") || "Result";
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
