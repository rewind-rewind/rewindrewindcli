import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { main, parseArgv } from "../bin/rewindrewind.mjs";

// verify polls for async ingestion; tests should not spend real seconds waiting.
const NO_WAIT = { REWINDREWIND_VERIFY_CONFIRM_DELAYS_MS: "0,0" };

const execFileP = promisify(execFile);
const thisDir = dirname(fileURLToPath(import.meta.url));

test("parseArgv supports long options, booleans, and repeated values", () => {
  const parsed = parseArgv(["api", "get", "/api/health", "--query", "a=1", "--query=b=2", "--quiet"]);
  assert.deepEqual(parsed.positionals, ["api", "get", "/api/health"]);
  assert.deepEqual(parsed.options.query, ["a=1", "b=2"]);
  assert.equal(parsed.options.quiet, true);
});

test("installed bin symlink executes the cli", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-bin-"));
  try {
    const link = join(temp, "rewindrewind");
    await symlink(join(thisDir, "..", "bin", "rewindrewind.mjs"), link);
    const { stdout } = await execFileP(link, ["--version"]);
    assert.equal(stdout.trim(), "0.4.0");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("--help is a clean directory with topics, sdks, and commands", async () => {
  const io = harness();
  const status = await main(["--help"], io);

  assert.equal(status, 0);
  assert.match(io.stdout.text, /Help directory:/);
  assert.match(io.stdout.text, /rewindrewind help sdk node/);
  assert.match(io.stdout.text, /rewindrewind sdk list/);
  assert.match(io.stdout.text, /Machine-readable help:/);
});

test("--help can emit a structured directory for agents", async () => {
  const io = harness();
  const status = await main(["--help", "--json"], io);

  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.kind, "directory");
  assert.equal(out.name, "rewindrewind");
  assert.ok(out.topics.some((topic) => topic.id === "agent"));
  assert.ok(out.sdk_guides.some((sdk) => sdk.id === "python"));
});

test("help sdk node prints copy-paste setup", async () => {
  const io = harness();
  const status = await main(["help", "sdk", "node"], io);

  assert.equal(status, 0);
  assert.match(io.stdout.text, /Node\.js SDK/);
  assert.match(io.stdout.text, /npm install @rewindrewind\/sdk/);
  assert.match(io.stdout.text, /initRewind/);
  assert.match(io.stdout.text, /rewindrewind verify/);
});

test("help sdk node can emit structured JSON", async () => {
  const io = harness();
  const status = await main(["help", "sdk", "node", "--json"], io);

  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.kind, "sdk");
  assert.equal(out.sdk.id, "node");
  assert.ok(out.sdk.install.includes("npm install @rewindrewind/sdk"));
});

test("sdk list and show expose SDK guidance as JSON commands", async () => {
  const listIo = harness();
  assert.equal(await main(["sdk", "list", "--json"], listIo), 0);
  const list = JSON.parse(listIo.stdout.text);
  assert.ok(list.sdks.some((sdk) => sdk.id === "browser"));
  assert.ok(list.sdks.some((sdk) => sdk.id === "go"));
  assert.ok(list.concepts.some((concept) => concept.id === "events"));

  const showIo = harness();
  assert.equal(await main(["sdk", "show", "python", "--json"], showIo), 0);
  const show = JSON.parse(showIo.stdout.text);
  assert.equal(show.sdk.id, "python");
  assert.match(show.sdk.install[0], /pypi\/simple/);
  assert.ok(show.sdk.integration_primitives.some((primitive) => primitive.id === "capture-event"));
});

test("sdk snippet browser hands out the canonical async pre-load loader", async () => {
  const io = harness();
  assert.equal(await main(["sdk", "snippet", "browser", "--json"], io), 0);
  const out = JSON.parse(io.stdout.text);
  const loader = out.snippets.find((snippet) => snippet.language === "html");

  assert.ok(loader, "expected an HTML loader snippet");
  // Order-independent queueing stub, not a bare <script src> + init pair.
  assert.match(loader.code, /w\.RewindRewind = w\.RewindRewind \|\| \{ _q: \[\] \}/);
  assert.match(loader.code, /RewindRewind\.init\(\{ key: "rrpub_xxx"/);
  // All three delivery mechanisms are covered during the async load window,
  // including direct window.onerror reports from frameworks (issue #124).
  assert.match(loader.code, /addEventListener\("error", r\._earlyErrorHandler\)/);
  assert.match(loader.code, /addEventListener\("unhandledrejection", r\._earlyRejectionHandler\)/);
  assert.match(loader.code, /w\.onerror = r\._earlyOnError/);
  assert.match(loader.code, /r\._priorOnError = w\.onerror/);
  // Temporary hooks are installed once, inside the load guard, so a Turbo body
  // swap re-running the inline snippet cannot stack duplicates.
  assert.equal(loader.code.match(/if \(!r\._loading\) \{/g).length, 1);
  assert.ok(loader.code.indexOf("if (!r._loading) {") < loader.code.indexOf("w.onerror = r._earlyOnError"));
});

test("sdk primitives exposes compact agent wiring guidance", async () => {
  const io = harness();
  assert.equal(await main(["sdk", "primitives", "rails", "--json"], io), 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.sdk.id, "rails");
  assert.ok(out.concepts.some((concept) => concept.id === "exceptions"));
  assert.ok(out.integration_primitives.some((primitive) => primitive.id === "capture-unhandled-exceptions"));
  assert.ok(out.hook_hints.some((hint) => hint.shape === "rails"));
  assert.match(out.commands.doctor, /sdk doctor rails/);
});

test("sdk doctor detects a frontend package and reports setup checks", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-doctor-"));
  try {
    await writeFile(join(temp, "package.json"), JSON.stringify({
      dependencies: { vite: "^6.0.0", "@rewindrewind/sdk": "^0.3.0" },
    }));
    const io = harness({ cwd: temp, env: { REWINDREWIND_PROJECT_KEY: "rrpub_pub" } });
    assert.equal(await main(["sdk", "doctor", "--json"], io), 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.target.id, "browser");
    assert.ok(out.detected.some((item) => item.id === "browser"));
    assert.equal(out.checks.find((check) => check.id === "project-key").ok, true);
    assert.equal(out.checks.find((check) => check.id === "sdk-reference").ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("sdk doctor recognizes the existing node package name", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-doctor-node-"));
  try {
    await writeFile(join(temp, "package.json"), JSON.stringify({
      dependencies: { hono: "^4.0.0", "@rewindrewind/node": "^0.2.1" },
    }));
    const io = harness({ cwd: temp, env: { REWINDREWIND_PROJECT_KEY: "rrpub_pub" } });
    assert.equal(await main(["sdk", "doctor", "--json"], io), 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.target.id, "node");
    assert.ok(out.detected[0].evidence.includes("hono dependency"));
    assert.match(out.checks.find((check) => check.id === "sdk-reference").detail, /@rewindrewind\/node/);
    assert.equal(out.checks.find((check) => check.id === "sdk-reference").ok, true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("sdk upgrade prints an agent-readable plan without editing files", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-upgrade-"));
  try {
    await writeFile(join(temp, "Gemfile"), "source \"https://rubygems.org\"\ngem \"rails\"\ngem \"rewind_rewind-rails\"\n");
    const io = harness({ cwd: temp });
    assert.equal(await main(["sdk", "upgrade", "rails", "--mode", "package", "--json"], io), 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.target.id, "rails");
    assert.equal(out.mode, "package");
    assert.ok(out.plan.some((step) => step.step === "review-primitives"));
    assert.ok(out.agent_instructions.some((item) => /framework conventions/.test(item)));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("health does not require an api key", async () => {
  const seen = [];
  const status = await main(["health", "--base-url", "https://example.test"], harness({
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    },
  }));

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://example.test/api/health");
  assert.equal(seen[0].init.headers.authorization, undefined);
});

test("api command sends bearer auth, query params, and json body", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_prefix_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), init, body: JSON.parse(init.body) });
      return jsonResponse({ ok: true, answer: 42 });
    },
  });

  const status = await main(["api", "post", "/api/projects/p1/retention/run", "--query", "dry_run=true", "--data", "{\"x\":1}", "--json"], io);

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/retention/run?dry_run=true");
  assert.equal(seen[0].init.headers.authorization, "Bearer rr_prefix_secret");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.deepEqual(seen[0].body, { x: 1 });
  assert.deepEqual(JSON.parse(io.stdout.text), { ok: true, answer: 42 });
});

test("bodyless writes still declare a json content type", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_prefix_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
      return jsonResponse({ ok: true, archived: true });
    },
  });

  // A request with no Content-Type reads as a cross-origin form post to the
  // collector's CSRF guard, which answers 403 before the handler runs. Every
  // bodyless write — each management DELETE — has to say what it is.
  const status = await main(["metrics", "delete", "mt_1", "--json"], io);

  assert.equal(status, 0);
  assert.equal(seen[0].method, "DELETE");
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/metrics/mt_1");
  assert.equal(seen[0].headers["content-type"], "application/json");
  assert.equal(seen[0].body, undefined);
});

test("reads do not declare a request content type", async () => {
  const seen = [];
  const status = await main(["metrics", "list", "--json"], harness({
    env: { REWINDREWIND_API_KEY: "rr_prefix_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ headers: init.headers });
      return jsonResponse({ ok: true, metrics: [] });
    },
  }));

  assert.equal(status, 0);
  assert.equal(seen[0].headers["content-type"], undefined);
});

test("api command can call public endpoints without auth", async () => {
  const seen = [];
  const status = await main(["api", "get", "/openapi.json", "--base-url", "https://rw.test", "--no-auth"], harness({
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse({ openapi: "3.1.0" });
    },
  }));

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/openapi.json");
  assert.equal(seen[0].init.headers.authorization, undefined);
});

test("api command refuses to send auth to a foreign absolute URL", async () => {
  let called = false;
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_prefix_secret" },
    fetch: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });

  const status = await main(["api", "get", "https://evil.example.test/capture"], io);

  assert.equal(status, 2);
  assert.equal(called, false);
  assert.match(io.stderr.text, /Refusing to send an API key/);
});

test("api command allows foreign absolute URLs without auth", async () => {
  const seen = [];
  const status = await main(["api", "get", "https://status.example.test/health", "--no-auth"], harness({
    fetch: async (url, init) => {
      seen.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    },
  }));

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://status.example.test/health");
  assert.equal(seen[0].init.headers.authorization, undefined);
});

test("configure writes masked config output and usable config file", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-"));
  try {
    const io = harness({ env: { XDG_CONFIG_HOME: temp } });
    const status = await main([
      "configure",
      "--api-key",
      "rr_1234567890abcdef_secret",
      "--base-url",
      "https://rw.test/",
      "--project",
      "project_1",
      "--json",
    ], io);

    assert.equal(status, 0);
    const output = JSON.parse(io.stdout.text);
    assert.equal(output.configured.apiKey, "rr_12345...cret");
    assert.equal(output.configured.baseUrl, "https://rw.test");
    assert.equal(output.configured.projectId, "project_1");

    const file = JSON.parse(await readFile(join(temp, "rewindrewind", "config.json"), "utf8"));
    assert.equal(file.apiKey, "rr_1234567890abcdef_secret");
    assert.equal(file.baseUrl, "https://rw.test");
    assert.equal(file.projectId, "project_1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("events send uses the project key and merges flags into payload", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_API_KEY: "rr_key_secret" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return jsonResponse({ ok: true, event_id: "evt_1" }, 202);
    },
  });

  const status = await main([
    "events",
    "send",
    "--base-url",
    "https://rw.test",
    "--type",
    "checkout.completed",
    "--environment",
    "production",
    "--properties",
    "{\"plan\":\"pro\"}",
  ], io);

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/v1/events");
  // Ingestion authenticates with the public project key, not the admin key.
  assert.equal(seen[0].headers.authorization, "Bearer rrpub_pub");
  assert.deepEqual(seen[0].body, {
    type: "checkout.completed",
    environment: "production",
    properties: { plan: "pro" },
  });
});

test("events list forwards canonical received-at time filters", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url) => {
      seen.push(String(url));
      return jsonResponse({ ok: true, events: [] });
    },
  });

  const status = await main([
    "events",
    "list",
    "--from",
    "2026-08-20T00:00:00Z",
    "--to",
    "2026-08-21T00:00:00Z",
    "--environment",
    "production",
    "--limit",
    "3",
  ], io);

  assert.equal(status, 0);
  assert.equal(seen[0], "https://rw.test/api/projects/p1/events?limit=3&from=2026-08-20T00%3A00%3A00Z&to=2026-08-21T00%3A00%3A00Z&environment=production");
});

test("events list maps since and until aliases to the API time filters", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url) => {
      seen.push(String(url));
      return jsonResponse({ ok: true, events: [] });
    },
  });

  const status = await main(["events", "list", "--since", "2026-08-20T00:00:00Z", "--until", "2026-08-21T00:00:00Z"], io);

  assert.equal(status, 0);
  assert.equal(seen[0], "https://rw.test/api/projects/p1/events?from=2026-08-20T00%3A00%3A00Z&to=2026-08-21T00%3A00%3A00Z");
});

test("events list rejects unknown options instead of silently ignoring them", async () => {
  let called = false;
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1" },
    fetch: async () => {
      called = true;
      return jsonResponse({ ok: true, events: [] });
    },
  });

  const status = await main(["events", "list", "--form", "2026-08-20T00:00:00Z"], io);

  assert.notEqual(status, 0);
  assert.equal(called, false);
  assert.match(io.stderr.text, /Unknown option for `events list`: --form/);
});

test("events help documents canonical and compatible time filters", async () => {
  const io = harness();

  assert.equal(await main(["help", "events"], io), 0);
  assert.match(io.stdout.text, /events list --from .* --to /);
  assert.match(io.stdout.text, /--since.*--until.*aliases/i);
  assert.match(io.stdout.text, /received_at/);
});

test("visits send fires an aggregate signal with the project key", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_API_KEY: "rr_key_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body), headers: init.headers });
      return new Response(null, { status: 204 });
    },
  });

  const status = await main(["visits", "send", "--environment", "production", "--visitor-id", "user-42"], io);
  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/v1/visit");
  assert.equal(seen[0].method, "POST");
  // Aggregate visits authenticate with the public project key, not the admin key.
  assert.equal(seen[0].headers.authorization, "Bearer rrpub_pub");
  assert.deepEqual(seen[0].body, { environment: "production", visitor_id: "user-42" });
});

test("visits list reads the daily series with the admin key", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, auth: init.headers.authorization });
      return jsonResponse({ ok: true, visits: [{ day: "2026-07-13", total_hits: 3, unique_visitors: 2 }] });
    },
  });

  const status = await main(["visits", "list", "--from", "2026-07-01", "--to", "2026-07-13", "--environment", "production"], io);
  assert.equal(status, 0);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url, "https://rw.test/v1/projects/p1/visits?from=2026-07-01&to=2026-07-13&environment=production");
  assert.equal(seen[0].auth, "Bearer rr_admin_secret");
});

test("ingestion refuses an admin key with a helpful error", async () => {
  let called = false;
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_key_secret" },
    fetch: async () => {
      called = true;
      return jsonResponse({ ok: true });
    },
  });

  const status = await main(["events", "send", "--type", "t", "--base-url", "https://rw.test"], io);

  assert.equal(status, 2);
  assert.equal(called, false);
  assert.match(io.stderr.text, /project ingestion key \(rrpub_/);
});

test("api routes /v1 paths to the project key and /api paths to the admin key", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.authorization });
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(await main(["api", "post", "/v1/events", "--data", "{}"], io), 0);
  assert.equal(await main(["api", "get", "/api/projects"], io), 0);
  assert.equal(seen[0].auth, "Bearer rrpub_pub");
  assert.equal(seen[1].auth, "Bearer rr_admin_secret");
});

test("projects update configures and clears uptime settings", async () => {
  const seen = [];
  const io = harness({
    env: {
      REWINDREWIND_API_KEY: "rr_admin_secret",
      REWINDREWIND_PROJECT_ID: "project_1",
      REWINDREWIND_BASE_URL: "https://rw.test",
    },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
      return jsonResponse({ ok: true, project: { id: "project_1" } });
    },
  });

  assert.equal(await main([
    "projects",
    "update",
    "--uptime-url",
    "https://app.example.com/health",
    "--uptime-enabled",
    "true",
  ], io), 0);
  assert.deepEqual(seen[0], {
    url: "https://rw.test/api/projects/project_1",
    method: "PATCH",
    body: { uptime_enabled: true, uptime_url: "https://app.example.com/health" },
  });

  assert.equal(await main([
    "projects",
    "update",
    "--uptime-enabled",
    "false",
    "--uptime-url",
    "null",
  ], io), 0);
  assert.deepEqual(seen[1].body, { uptime_enabled: false, uptime_url: null });
});

test("health-rules exposes complete CRUD for agents", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, rules: [], rule: { id: "hr_1" }, archived: true });
    },
  });
  const specification = JSON.stringify({ name: "Errors", measure: { kind: "active_exception_issues" } });

  assert.equal(await main(["health-rules", "list"], io), 0);
  assert.equal(await main(["health-rules", "get", "hr_1"], io), 0);
  assert.equal(await main(["health-rules", "create", "--data", specification], io), 0);
  assert.equal(await main(["health-rules", "update", "hr_1", "--data", specification], io), 0);
  assert.equal(await main(["health-rules", "delete", "hr_1"], io), 0);

  assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
    ["GET", "https://rw.test/api/projects/p1/health/rules"],
    ["GET", "https://rw.test/api/projects/p1/health/rules/hr_1"],
    ["POST", "https://rw.test/api/projects/p1/health/rules"],
    ["PATCH", "https://rw.test/api/projects/p1/health/rules/hr_1"],
    ["DELETE", "https://rw.test/api/projects/p1/health/rules/hr_1"],
  ]);
  assert.deepEqual(seen[2].body, JSON.parse(specification));
  assert.deepEqual(seen[3].body, JSON.parse(specification));
});

test("issues resolve posts to the lifecycle endpoint with the admin key", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, issue: { id: "i1", status: "resolved" } });
    },
  });

  const status = await main(["issues", "resolve", "i1", "--reason", "fixed in web@1.2.3"], io);

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/issues/i1/resolve");
  assert.equal(seen[0].auth, "Bearer rr_admin_secret");
  assert.deepEqual(seen[0].body, { reason: "fixed in web@1.2.3" });
});

test("issues ignore posts to the ignore endpoint with no rule fields by default", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, issue: { id: "i1", status: "ignored" } });
    },
  });

  const status = await main(["issues", "ignore", "i1", "--reason", "third-party noise"], io);

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/issues/i1/ignore");
  assert.equal(seen[0].auth, "Bearer rr_admin_secret");
  assert.deepEqual(seen[0].body, { reason: "third-party noise" });
});

test("issues ignore forwards reactivation flags as snooze-rule fields", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, issue: { id: "i1", status: "ignored" } });
    },
  });

  const status = await main(
    ["issues", "ignore", "i1", "--mode", "occurrences_since_snooze", "--threshold-count", "50"],
    io,
  );

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/issues/i1/ignore");
  assert.deepEqual(seen[0].body, { mode: "occurrences_since_snooze", threshold_count: 50 });
});

test("comments create and update post to the comments endpoint with the admin key", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, comment: { id: "c1", body: "Deployed fix." } });
    },
  });

  let status = await main(["comments", "create", "i1", "--body", "Deployed fix."], io);
  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/issues/i1/comments");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].auth, "Bearer rr_admin_secret");
  assert.deepEqual(seen[0].body, { body: "Deployed fix." });

  status = await main(["comments", "update", "i1", "c1", "--body", "Deployed fix in web@1.4.3."], io);
  assert.equal(status, 0);
  assert.equal(seen[1].url, "https://rw.test/api/projects/p1/issues/i1/comments/c1");
  assert.equal(seen[1].method, "PATCH");
  assert.deepEqual(seen[1].body, { body: "Deployed fix in web@1.4.3." });
});

test("init configures from an admin key and stores the project key", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-init-"));
  try {
    const io = harness({
      env: { XDG_CONFIG_HOME: temp },
      fetch: async (url) => {
        const u = String(url);
        if (u.endsWith("/api/projects")) return jsonResponse({ ok: true, projects: [{ id: "p1", name: "Web" }] });
        if (u.endsWith("/api/projects/p1")) return jsonResponse({ ok: true, project: { id: "p1", name: "Web", public_key: "rrpub_realkey" } });
        return jsonResponse({ ok: true });
      },
    });

    const status = await main(["init", "--api-key", "rr_admin_secret", "--base-url", "https://rw.test", "--json"], io);

    assert.equal(status, 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.project_id, "p1");
    assert.equal(out.project_key, "rrpub_realkey");
    assert.equal(io.stderr.text, "");

    const file = JSON.parse(await readFile(join(temp, "rewindrewind", "config.json"), "utf8"));
    assert.equal(file.apiKey, "rr_admin_secret");
    assert.equal(file.projectKey, "rrpub_realkey");
    assert.equal(file.projectId, "p1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("verify treats async event confirmation misses as a soft warning", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_PROJECT_ID: "p1", ...NO_WAIT },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/api/health")) return jsonResponse({ ok: true });
      if (u.endsWith("/v1/events")) return jsonResponse({ ok: true, event_id: "evt_1" }, 202);
      if (u.endsWith("/v1/exceptions")) return jsonResponse({ ok: true }, 202);
      if (u.includes("/api/projects/p1/events")) return jsonResponse({ ok: true, events: [] });
      return jsonResponse({ ok: true });
    },
  });

  const status = await main(["verify", "--base-url", "https://rw.test", "--json"], io);

  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.ok, true);
  assert.equal(out.failed, 0);
  assert.equal(out.checks.find((check) => check.check === "event confirmed in project").ok, null);
  assert.equal(io.stderr.text, "");
});

test("configure can set an admin key file pointer instead of an inline key", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-ptr-"));
  try {
    const io = harness({ env: { XDG_CONFIG_HOME: temp } });
    const status = await main(["configure", "--api-key-file", "/secrets/rr.key", "--base-url", "https://rw.test"], io);

    assert.equal(status, 0);
    const file = JSON.parse(await readFile(join(temp, "rewindrewind", "config.json"), "utf8"));
    assert.equal(file.apiKeyFile, "/secrets/rr.key");
    assert.equal(file.apiKey, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("an admin key file pointer is read at request time", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-keyfile-"));
  try {
    const keyPath = join(temp, "rr.key");
    await writeFile(keyPath, "rr_admin_fromfile\n");
    const seen = [];
    const io = harness({
      env: { REWINDREWIND_API_KEY_FILE: keyPath, REWINDREWIND_BASE_URL: "https://rw.test" },
      fetch: async (url, init) => {
        seen.push({ auth: init.headers.authorization });
        return jsonResponse({ ok: true, projects: [] });
      },
    });

    const status = await main(["projects", "list"], io);

    assert.equal(status, 0);
    assert.equal(seen[0].auth, "Bearer rr_admin_fromfile");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("issues update warns when the status did not take effect", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_key_secret", REWINDREWIND_PROJECT_ID: "p1" },
    // Server echoes the issue still "open" despite the request to ignore it.
    fetch: async () => jsonResponse({ ok: true, issue: { id: "i1", status: "open" } }),
  });

  const status = await main(["issues", "update", "i1", "--status", "ignored", "--base-url", "https://rw.test", "--json"], io);

  assert.equal(status, 0);
  assert.equal(JSON.parse(io.stdout.text).issue.status, "open");
  assert.match(io.stderr.text, /requested status "ignored" but issue is "open"/);
});

test("issues update is silent when the status sticks", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_key_secret", REWINDREWIND_PROJECT_ID: "p1" },
    fetch: async () => jsonResponse({ ok: true, issue: { id: "i1", status: "ignored" } }),
  });

  const status = await main(["issues", "update", "i1", "--status", "ignored", "--base-url", "https://rw.test", "--json"], io);

  assert.equal(status, 0);
  assert.equal(JSON.parse(io.stdout.text).issue.status, "ignored");
  assert.equal(io.stderr.text, "");
});

test("status reports needs_api_key when no admin key is configured", async () => {
  const io = harness({ env: {} });
  const status = await main(["status", "--base-url", "https://rw.test", "--json"], io);
  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.ready, false);
  assert.equal(out.needs_api_key, true);
  assert.match(out.action, /admin API key/);
});

test("status defaults to human-readable output", async () => {
  const io = harness({ env: {} });
  const status = await main(["status", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.match(io.stdout.text, /RewindRewind status: not ready/);
  assert.match(io.stdout.text, /Base URL: https:\/\/rw\.test/);
  assert.match(io.stdout.text, /admin API key/);
  assert.throws(() => JSON.parse(io.stdout.text));
});

test("status is not blocked by a stale project key file when admin key is missing", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-status-"));
  try {
    await mkdir(join(temp, "rewindrewind"));
    await writeFile(join(temp, "rewindrewind", "config.json"), JSON.stringify({
      projectKeyFile: join(temp, "missing-project.key"),
    }));
    const io = harness({ env: { XDG_CONFIG_HOME: temp } });
    const status = await main(["status", "--base-url", "https://rw.test", "--json"], io);

    assert.equal(status, 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.ready, false);
    assert.equal(out.needs_api_key, true);
    assert.equal(out.project_key_warning, undefined);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("status reports ready when the admin key validates", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_pub" },
    fetch: async () => jsonResponse({ ok: true, projects: [{ id: "p1", name: "Web", account_id: "a1" }] }),
  });
  const status = await main(["status", "--base-url", "https://rw.test", "--json"], io);
  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.ready, true);
  assert.equal(out.needs_api_key, false);
  assert.equal(out.has_project_key, true);
  assert.equal(out.project_id, "p1");
  assert.deepEqual(out.projects, [{ id: "p1", name: "Web" }]);
});

test("status stays ready and warns when an optional project key is malformed", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "not-a-project-key" },
    fetch: async () => jsonResponse({ ok: true, projects: [{ id: "p1", name: "Web", account_id: "a1" }] }),
  });
  const status = await main(["status", "--base-url", "https://rw.test", "--json"], io);
  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.ready, true);
  assert.equal(out.needs_api_key, false);
  assert.equal(out.has_project_key, false);
  assert.match(out.project_key_warning, /project ingestion key/);
});

test("verify defaults to human-readable output", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_PROJECT_ID: "p1", ...NO_WAIT },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/api/health")) return jsonResponse({ ok: true });
      if (u.endsWith("/v1/events")) return jsonResponse({ ok: true, event_id: "evt_1" }, 202);
      if (u.endsWith("/v1/exceptions")) return jsonResponse({ ok: true }, 202);
      if (u.includes("/api/projects/p1/events")) return jsonResponse({ ok: true, events: [] });
      return jsonResponse({ ok: true });
    },
  });

  const status = await main(["verify", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.match(io.stdout.text, /RewindRewind verify: passed/);
  assert.match(io.stdout.text, /\[ok\] service health/);
  assert.match(io.stdout.text, /\[skip\] event confirmed in project - not found after/);
  assert.equal(io.stderr.text, "");
});

test("verify confirms the event once ingestion catches up", async () => {
  let reads = 0;
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_PROJECT_ID: "p1", ...NO_WAIT },
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/health")) return jsonResponse({ ok: true });
      if (u.endsWith("/v1/events")) {
        const body = JSON.parse(init.body);
        marker = body.properties.marker;
        return jsonResponse({ ok: true, event_id: "evt_1" }, 202);
      }
      if (u.endsWith("/v1/exceptions")) return jsonResponse({ ok: true }, 202);
      if (u.includes("/api/projects/p1/events")) {
        reads += 1;
        // First read loses the race with async ingestion; the second finds it.
        return jsonResponse({ ok: true, events: reads < 2 ? [] : [{ id: "e1", properties: { marker } }] });
      }
      return jsonResponse({ ok: true });
    },
  });
  let marker;

  const status = await main(["verify", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.ok(reads >= 2, `expected a retry, got ${reads} read(s)`);
  assert.match(io.stdout.text, /\[ok\] event confirmed in project - found/);
});

test("verify resolves the project id from the project key when none is configured", async () => {
  let confirmUrl;
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_pub", ...NO_WAIT },
    fetch: async (url, init) => {
      const u = String(url);
      if (u.endsWith("/api/health")) return jsonResponse({ ok: true });
      if (u.endsWith("/v1/events")) {
        marker = JSON.parse(init.body).properties.marker;
        return jsonResponse({ ok: true, event_id: "evt_1" }, 202);
      }
      if (u.endsWith("/v1/exceptions")) return jsonResponse({ ok: true }, 202);
      if (u.endsWith("/api/projects")) {
        return jsonResponse({ ok: true, projects: [{ id: "other", public_key: "rrpub_nope" }, { id: "p9", public_key: "rrpub_pub" }] });
      }
      if (u.includes("/events")) {
        confirmUrl = u;
        return jsonResponse({ ok: true, events: [{ id: "e1", properties: { marker } }] });
      }
      return jsonResponse({ ok: true });
    },
  });
  let marker;

  const status = await main(["verify", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.ok(confirmUrl?.includes("/api/projects/p9/events"), `resolved wrong project: ${confirmUrl}`);
  assert.match(io.stdout.text, /\[ok\] event confirmed in project - found/);
});

test("verify names the missing piece when there is no admin key", async () => {
  const io = harness({
    env: { REWINDREWIND_PROJECT_KEY: "rrpub_pub", REWINDREWIND_PROJECT_ID: "p1", ...NO_WAIT },
    fetch: async (url) => {
      const u = String(url);
      if (u.endsWith("/api/health")) return jsonResponse({ ok: true });
      if (u.endsWith("/v1/events")) return jsonResponse({ ok: true, event_id: "evt_1" }, 202);
      if (u.endsWith("/v1/exceptions")) return jsonResponse({ ok: true }, 202);
      return jsonResponse({ ok: true });
    },
  });

  const status = await main(["verify", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.match(io.stdout.text, /\[skip\] event confirmed in project - skipped \(no admin key/);
  assert.doesNotMatch(io.stdout.text, /--project to confirm/);
});

test("projects list marks a soft-deleted project as disabled", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret" },
    fetch: async () => jsonResponse({
      ok: true,
      projects: [
        { id: "p1", name: "Live" },
        { id: "p2", name: "Gone", disabled_at: "2026-08-25T19:44:50.362Z" },
      ],
    }),
  });

  const status = await main(["projects", "list", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.match(io.stdout.text, /id=p2  name=Gone  disabled/);
  // A live project must not pick up the marker.
  assert.match(io.stdout.text, /id=p1  name=Live\n/);
});

test("verify help documents --project and how the read-back resolves it", async () => {
  const io = harness({});
  const status = await main(["verify", "--help"], io);
  assert.equal(status, 0);
  assert.match(io.stdout.text, /rewindrewind verify --project <project-id>/);
  assert.match(io.stdout.text, /Details:/);
  assert.match(io.stdout.text, /read-back needs an admin key/);
});

function harness(overrides = {}) {
  const stdin = new PassThrough();
  stdin.end();
  const env = {
    XDG_CONFIG_HOME: join(tmpdir(), `rewindrewindcli-test-${process.pid}-${Math.random().toString(36).slice(2)}`),
    REWINDREWIND_NO_UPDATE_CHECK: "1",
    ...(overrides.env ?? {}),
  };
  return {
    stdin,
    stdout: capture(),
    stderr: capture(),
    env,
    disableUpdateCache: true,
    fetch: async () => jsonResponse({ ok: true }),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "env")),
  };
}

function releaseManifest(version = "0.4.0") {
  return {
    schema_version: 1,
    package: "@rewindrewind/cli",
    channel: "stable",
    latest: {
      version,
      registry: "https://registry.npmjs.org",
      published_at: "2026-09-13T00:00:00Z",
      release_url: `https://github.com/rewind-rewind/rewindrewindcli/releases/tag/v${version}`,
    },
  };
}

test("update --check reports a newer semantic version without installing it", async () => {
  let installs = 0;
  const io = harness({
    fetch: async () => jsonResponse(releaseManifest("0.5.0")),
    runCommand: async () => { installs += 1; return { code: 0 }; },
  });

  assert.equal(await main(["update", "--check", "--json"], io), 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.current_version, "0.4.0");
  assert.equal(out.latest_version, "0.5.0");
  assert.equal(out.update_available, true);
  assert.equal(out.updated, false);
  assert.equal(installs, 0);
});

test("update --yes installs the exact manifest release through npm", async () => {
  const calls = [];
  const io = harness({
    fetch: async () => jsonResponse(releaseManifest("0.5.0")),
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return command === "rewindrewind" ? { code: 0, stdout: "0.5.0\n" } : { code: 0 };
    },
  });

  assert.equal(await main(["update", "--yes", "--json"], io), 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.updated, true);
  assert.deepEqual(calls, [
    {
      command: "npm",
      args: ["install", "--global", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", "@rewindrewind/cli@0.5.0"],
    },
    { command: "rewindrewind", args: ["--version"] },
  ]);
});

test("ordinary human commands show a fresh cached update notice", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-update-cache-"));
  try {
    const cacheDirectory = join(temp, "rewindrewind");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, "update-check.json"), JSON.stringify({
      schema_version: 1,
      checked_at: "2026-09-13T12:00:00.000Z",
      manifest: releaseManifest("0.5.0"),
    }));
    const io = harness({
      now: () => Date.parse("2026-09-13T13:00:00.000Z"),
      updateCachePath: join(cacheDirectory, "update-check.json"),
      env: { XDG_CACHE_HOME: temp, REWINDREWIND_NO_UPDATE_CHECK: "false" },
      fetch: async () => jsonResponse({ ok: true }),
    });

    assert.equal(await main(["health"], io), 0);
    assert.match(io.stderr.text, /Update available.*0\.4\.0.*0\.5\.0/);
    assert.match(io.stderr.text, /rewindrewind update --yes/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("status JSON includes cached update metadata without corrupting output", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-status-cache-"));
  try {
    const cacheDirectory = join(temp, "rewindrewind");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(join(cacheDirectory, "update-check.json"), JSON.stringify({
      schema_version: 1,
      checked_at: "2026-09-13T12:00:00.000Z",
      manifest: releaseManifest("0.5.0"),
    }));
    const io = harness({
      now: () => Date.parse("2026-09-13T13:00:00.000Z"),
      updateCachePath: join(cacheDirectory, "update-check.json"),
      env: { XDG_CACHE_HOME: temp, REWINDREWIND_NO_UPDATE_CHECK: "false" },
    });

    assert.equal(await main(["status", "--json"], io), 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.cli_update.latest_version, "0.5.0");
    assert.equal(out.cli_update.update_available, true);
    assert.equal(io.stderr.text, "");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("doctor --fix secures local state and checks service and releases", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-doctor-fix-"));
  try {
    const configDirectory = join(temp, "config", "rewindrewind");
    const configFile = join(configDirectory, "config.json");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configFile, JSON.stringify({ baseUrl: "https://rw.test/" }), { mode: 0o644 });
    await chmod(configFile, 0o644);
    const io = harness({
      updateCachePath: join(temp, "cache", "rewindrewind", "update-check.json"),
      env: { XDG_CONFIG_HOME: join(temp, "config"), XDG_CACHE_HOME: join(temp, "cache") },
      fetch: async (url) => String(url).endsWith("/cli/releases.json") ? jsonResponse(releaseManifest()) : jsonResponse({ ok: true }),
    });

    assert.equal(await main(["doctor", "--fix", "--json"], io), 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.ok, true);
    assert.equal(out.fixed, true);
    assert.ok(out.checks.some((check) => check.id === "release-manifest" && check.ok));
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(configFile, "utf8")).baseUrl, "https://rw.test");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("doctor --fix preserves an invalid config before resetting it", async () => {
  const temp = await mkdtemp(join(tmpdir(), "rewindrewindcli-doctor-invalid-"));
  try {
    const configDirectory = join(temp, "config", "rewindrewind");
    const configFile = join(configDirectory, "config.json");
    await mkdir(configDirectory, { recursive: true });
    await writeFile(configFile, "{not json\n");
    const io = harness({
      updateCachePath: join(temp, "cache", "rewindrewind", "update-check.json"),
      env: { XDG_CONFIG_HOME: join(temp, "config") },
      fetch: async (url) => String(url).endsWith("/cli/releases.json") ? jsonResponse(releaseManifest()) : jsonResponse({ ok: true }),
    });

    assert.equal(await main(["doctor", "--fix", "--json"], io), 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.checks.find((check) => check.id === "config-json").ok, true);
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), {});
    const backupPath = out.fixes.find((fix) => fix.includes("invalid configuration")).replace("moved the invalid configuration to ", "");
    assert.equal(await readFile(backupPath, "utf8"), "{not json\n");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

function capture() {
  return {
    text: "",
    write(chunk) {
      this.text += String(chunk);
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("members and invites cover the whole membership lifecycle", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, account: { id: "acct_1", name: "Acme" }, members: [], invites: [], invite: { id: "inv_1" }, member: { id: "mem_1" } });
    },
  });

  assert.equal(await main(["members", "list"], io), 0);
  assert.equal(await main(["members", "invite", "--email", "teammate@example.com", "--role", "admin"], io), 0);
  assert.equal(await main(["members", "role", "mem_1", "--role", "member"], io), 0);
  assert.equal(await main(["members", "remove", "mem_1"], io), 0);
  assert.equal(await main(["invites", "list", "--status", "pending"], io), 0);
  assert.equal(await main(["invites", "get", "inv_1"], io), 0);
  assert.equal(await main(["invites", "resend", "inv_1"], io), 0);
  assert.equal(await main(["invites", "revoke", "inv_1"], io), 0);

  assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
    ["GET", "https://rw.test/api/organization/members"],
    ["POST", "https://rw.test/api/organization/members"],
    ["PATCH", "https://rw.test/api/organization/members/mem_1"],
    ["DELETE", "https://rw.test/api/organization/members/mem_1"],
    ["GET", "https://rw.test/api/organization/invites?status=pending"],
    ["GET", "https://rw.test/api/organization/invites/inv_1"],
    ["POST", "https://rw.test/api/organization/invites/inv_1/resend"],
    ["DELETE", "https://rw.test/api/organization/invites/inv_1"],
  ]);
  assert.deepEqual(seen[1].body, { email: "teammate@example.com", role: "admin" });
  assert.deepEqual(seen[2].body, { role: "member" });
});

test("members commands need an admin key, not a project key", async () => {
  const io = harness({ env: { REWINDREWIND_PROJECT_KEY: "rrpub_public" } });
  assert.notEqual(await main(["members", "list", "--base-url", "https://rw.test"], io), 0);
  assert.match(io.stderr.text, /Missing admin key/);
});

test("members list reads as a roster with each invite's status", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async () => jsonResponse({
      ok: true,
      account: { id: "acct_1", name: "Acme" },
      members: [{ id: "mem_1", user_id: "u1", email: "owner@example.com", name: "Owner", role: "admin" }],
      invites: [
        { id: "inv_1", email: "new@example.com", role: "member", status: "pending", expires_at: "2026-09-04T00:00:00.000Z" },
        { id: "inv_2", email: "old@example.com", role: "admin", status: "expired", expires_at: "2026-08-01T00:00:00.000Z" },
        { id: "inv_3", email: "in@example.com", role: "member", status: "accepted", accepted_at: "2026-08-30T00:00:00.000Z" },
      ],
    }),
  });

  assert.equal(await main(["members", "list"], io), 0);
  assert.match(io.stdout.text, /Organization: Acme \(acct_1\)/);
  assert.match(io.stdout.text, /admin\s+owner@example\.com\s+Owner\s+mem_1/);
  assert.match(io.stdout.text, /pending\s+new@example\.com\s+member\s+expires 2026-09-04/);
  assert.match(io.stdout.text, /expired\s+old@example\.com\s+admin\s+expired 2026-08-01/);
  assert.match(io.stdout.text, /accepted\s+in@example\.com\s+member\s+accepted 2026-08-30/);
});

test("members invite says whether the teammate is in yet", async () => {
  const pending = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async () => jsonResponse({
      ok: true,
      invite: { id: "inv_1", email: "new@example.com", role: "member", status: "pending", expires_at: "2026-09-04T00:00:00.000Z", invited_by: null },
      member: null,
    }),
  });
  assert.equal(await main(["members", "invite", "--email", "new@example.com"], pending), 0);
  assert.match(pending.stdout.text, /Status: pending/);
  assert.match(pending.stdout.text, /Invited by: admin API key/);
  assert.match(pending.stdout.text, /joins when they use the emailed link/);

  const immediate = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async () => jsonResponse({
      ok: true,
      invite: { id: "inv_2", email: "known@example.com", role: "admin", status: "accepted", expires_at: "2026-09-04T00:00:00.000Z", accepted_at: null, invited_by: { user_id: "u1", email: "owner@example.com" } },
      member: { id: "mem_9", email: "known@example.com", role: "admin" },
    }),
  });
  assert.equal(await main(["members", "invite", "--email", "known@example.com", "--role", "admin"], immediate), 0);
  assert.match(immediate.stdout.text, /Invited by: owner@example\.com/);
  assert.match(immediate.stdout.text, /Membership granted now: known@example\.com is admin \(member id mem_9\)/);
});

test("members and invites reject unknown actions and missing ids", async () => {
  const io = harness({ env: { REWINDREWIND_API_KEY: "rr_admin_secret" } });
  assert.notEqual(await main(["members", "frobnicate"], io), 0);
  assert.match(io.stderr.text, /list, invite, role, remove/);

  const missingMember = harness({ env: { REWINDREWIND_API_KEY: "rr_admin_secret" } });
  assert.notEqual(await main(["members", "role", "--role", "admin"], missingMember), 0);
  assert.match(missingMember.stderr.text, /members role <member-id>/);

  const missingInvite = harness({ env: { REWINDREWIND_API_KEY: "rr_admin_secret" } });
  assert.notEqual(await main(["invites", "resend"], missingInvite), 0);
  assert.match(missingInvite.stderr.text, /invites resend <invitation-id>/);

  const missingEmail = harness({ env: { REWINDREWIND_API_KEY: "rr_admin_secret" } });
  assert.notEqual(await main(["members", "invite"], missingEmail), 0);
  assert.match(missingEmail.stderr.text, /--email/);
});

test("help lists members and invites for agents", async () => {
  const io = harness();
  assert.equal(await main(["--help", "--json"], io), 0);
  const out = JSON.parse(io.stdout.text);
  assert.ok(out.commands.some((item) => item.command.startsWith("members ")));
  assert.ok(out.commands.some((item) => item.command.startsWith("invites ")));

  const detail = harness();
  assert.equal(await main(["help", "invites"], detail), 0);
  assert.match(detail.stdout.text, /pending, accepted, or expired/);
});

test("metrics exposes complete CRUD for agents", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, metrics: [], metric: { id: "mt_1" } });
    },
  });
  const specification = JSON.stringify({
    name: "Monthly ad spend",
    measure: { kind: "event_latest", event_type: "ads.metrics.snapshot", property: "spend_cents_trailing_30d" },
    property_filters: { audience_id: "__aggregate__", channel: "__all__" },
  });

  assert.equal(await main(["metrics", "list"], io), 0);
  assert.equal(await main(["metrics", "get", "mt_1"], io), 0);
  assert.equal(await main(["metrics", "create", "--data", specification], io), 0);
  assert.equal(await main(["metrics", "update", "mt_1", "--data", specification], io), 0);
  assert.equal(await main(["metrics", "delete", "mt_1"], io), 0);
  assert.equal(await main(["metrics", "evaluate"], io), 0);

  assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
    ["GET", "https://rw.test/api/projects/p1/metrics"],
    ["GET", "https://rw.test/api/projects/p1/metrics/mt_1"],
    ["POST", "https://rw.test/api/projects/p1/metrics"],
    ["PATCH", "https://rw.test/api/projects/p1/metrics/mt_1"],
    ["DELETE", "https://rw.test/api/projects/p1/metrics/mt_1"],
    ["POST", "https://rw.test/api/projects/p1/metrics/evaluate"],
  ]);
  assert.deepEqual(seen[2].body, JSON.parse(specification));
  assert.deepEqual(seen[3].body, JSON.parse(specification));
});

test("metrics accepts a specification on stdin like health-rules", async () => {
  const seen = [];
  const stdin = new PassThrough();
  stdin.end(JSON.stringify({ name: "Piped" }));
  const io = harness({
    stdin,
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true, metric: { id: "mt_1" } });
    },
  });

  assert.equal(await main(["metrics", "update", "mt_1", "--data", "-"], io), 0);
  assert.deepEqual(seen[0].body, { name: "Piped" });
});

test("metrics rejects an unknown action and a missing id", async () => {
  const io = harness({ env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1" } });
  assert.notEqual(await main(["metrics", "frobnicate"], io), 0);
  assert.match(io.stderr.text, /list, get, create, update, delete, evaluate/);

  const missing = harness({ env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1" } });
  assert.notEqual(await main(["metrics", "get"], missing), 0);
  assert.match(missing.stderr.text, /metrics get <metric-id>/);
});

test("definition lists identify each rule and metric, not just its id", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async () => jsonResponse({
      ok: true,
      metrics: [{
        id: "mt_1",
        specification: {
          name: "Monthly ad spend",
          measure: { kind: "event_latest", event_type: "ads.metrics.snapshot", property: "spend_cents_trailing_30d" },
          property_filters: { audience_id: "__aggregate__", channel: "__all__" },
        },
        evaluation: { value: 80974 },
      }],
    }),
  });

  assert.equal(await main(["metrics", "list"], io), 0);
  assert.match(io.stdout.text, /Monthly ad spend/);
  assert.match(io.stdout.text, /id=mt_1/);
  assert.match(io.stdout.text, /measure=event_latest\(ads\.metrics\.snapshot\.spend_cents_trailing_30d\)/);
  assert.match(io.stdout.text, /where=audience_id=__aggregate__,channel=__all__/);
  assert.match(io.stdout.text, /value=80974/);
});

test("help directory exposes every first-class feature topic concisely", async () => {
  const io = harness();
  assert.equal(await main(["--help", "--json"], io), 0);
  const out = JSON.parse(io.stdout.text);
  for (const id of ["visits", "support", "health", "metrics", "noise", "notifications", "members", "sourcemaps"]) {
    assert.ok(out.topics.some((topic) => topic.id === id), `missing help topic ${id}`);
  }

  const support = harness();
  assert.equal(await main(["help", "support"], support), 0);
  assert.match(support.stdout.text, /support submit/);
  assert.match(support.stdout.text, /support list/);
  assert.match(support.stdout.text, /does not deliver/i);
});

test("verify probes support auth without creating a conversation", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_PROJECT_KEY: "rrpub_public", ...NO_WAIT },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      seen.push({ path, body: init.body && JSON.parse(init.body), auth: init.headers.authorization });
      if (path === "/v1/support") return jsonResponse({ ok: false, error: { code: "bad_request", message: "subject is required" } }, 400);
      if (path === "/api/health") return jsonResponse({ ok: true });
      return jsonResponse({ ok: true }, 202);
    },
  });

  assert.equal(await main(["verify", "--base-url", "https://rw.test", "--json"], io), 0);
  const probe = seen.find((request) => request.path === "/v1/support");
  assert.deepEqual(probe.body, {});
  assert.equal(probe.auth, "Bearer rrpub_public");
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.checks.find((check) => check.check === "support endpoint").ok, true);
});

test("support exposes intake and the complete management workflow", async () => {
  const seen = [];
  const io = harness({
    env: {
      REWINDREWIND_PROJECT_KEY: "rrpub_public",
      REWINDREWIND_API_KEY: "rr_admin_secret",
      REWINDREWIND_PROJECT_ID: "p1",
      REWINDREWIND_BASE_URL: "https://rw.test",
    },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(await main(["support", "submit", "--subject", "Help", "--message", "It broke", "--email", "me@example.com", "--identity-id", "u1"], io), 0);
  assert.equal(await main(["support", "list", "--status", "resolved"], io), 0);
  assert.equal(await main(["support", "get", "sc1"], io), 0);
  assert.equal(await main(["support", "reply", "sc1", "--body", "Fixed", "--channel", "email"], io), 0);
  assert.equal(await main(["support", "note", "sc1", "--body", "Internal"], io), 0);
  assert.equal(await main(["support", "edit-note", "sc1", "sn1", "--body", "Updated"], io), 0);
  assert.equal(await main(["support", "status", "sc1", "--status", "resolved"], io), 0);
  assert.equal(await main(["support", "assign", "sc1", "--user", "u2"], io), 0);
  assert.equal(await main(["support", "settings"], io), 0);
  assert.equal(await main(["support", "settings", "update", "--data", '{"notify_new":false}'], io), 0);
  assert.equal(await main(["support", "erase", "--identity-id", "u1"], io), 0);

  assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
    ["POST", "https://rw.test/v1/support"],
    ["GET", "https://rw.test/api/projects/p1/support?status=resolved"],
    ["GET", "https://rw.test/api/projects/p1/support/sc1"],
    ["POST", "https://rw.test/api/projects/p1/support/sc1/messages"],
    ["POST", "https://rw.test/api/projects/p1/support/sc1/notes"],
    ["PATCH", "https://rw.test/api/projects/p1/support/sc1/notes/sn1"],
    ["PATCH", "https://rw.test/api/projects/p1/support/sc1"],
    ["PATCH", "https://rw.test/api/projects/p1/support/sc1"],
    ["GET", "https://rw.test/api/projects/p1/support/settings"],
    ["PATCH", "https://rw.test/api/projects/p1/support/settings"],
    ["POST", "https://rw.test/api/projects/p1/support/erase"],
  ]);
  assert.equal(seen[0].auth, "Bearer rrpub_public");
  assert.deepEqual(seen[0].body, { subject: "Help", message: "It broke", contact: { email: "me@example.com" }, identity_id: "u1" });
  assert.deepEqual(seen[3].body, { body: "Fixed", channel: "email" });
  assert.deepEqual(seen[6].body, { status: "resolved" });
  assert.deepEqual(seen[7].body, { assignee_user_id: "u2" });
});

test("noise commands cover catalog, safe preview, rules, and match counts", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true });
    },
  });
  const rule = '{"platform":"javascript","exception_type":"TypeError","message":"ResizeObserver loop","reason":"Browser observer noise"}';

  assert.equal(await main(["noise", "catalog"], io), 0);
  assert.equal(await main(["noise", "catalog-set", "resize-observer", "--enabled", "false"], io), 0);
  assert.equal(await main(["noise", "list"], io), 0);
  assert.equal(await main(["noise", "get", "nr1"], io), 0);
  assert.equal(await main(["noise", "preview", "--data", rule], io), 0);
  assert.equal(await main(["noise", "create", "--data", rule], io), 0);
  assert.equal(await main(["noise", "update", "nr1", "--data", rule], io), 0);
  assert.equal(await main(["noise", "disable", "nr1"], io), 0);
  assert.equal(await main(["noise", "enable", "nr1"], io), 0);
  assert.equal(await main(["noise", "matches", "--days", "30"], io), 0);

  assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
    ["GET", "https://rw.test/api/projects/p1/noise/catalog"],
    ["POST", "https://rw.test/api/projects/p1/noise/catalog/resize-observer"],
    ["GET", "https://rw.test/api/projects/p1/noise/rules"],
    ["GET", "https://rw.test/api/projects/p1/noise/rules/nr1"],
    ["POST", "https://rw.test/api/projects/p1/noise/rules/preview"],
    ["POST", "https://rw.test/api/projects/p1/noise/rules"],
    ["PATCH", "https://rw.test/api/projects/p1/noise/rules/nr1"],
    ["DELETE", "https://rw.test/api/projects/p1/noise/rules/nr1"],
    ["POST", "https://rw.test/api/projects/p1/noise/rules/nr1/enable"],
    ["GET", "https://rw.test/api/projects/p1/noise/matches?days=30"],
  ]);
  assert.deepEqual(seen[1].body, { enabled: false });
});

test("notifications, project health, event types, and usage have discoverable commands", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test" },
    fetch: async (url, init) => {
      seen.push({ url: String(url), method: init.method, body: init.body && JSON.parse(init.body) });
      return jsonResponse({ ok: true });
    },
  });

  assert.equal(await main(["notifications", "get"], io), 0);
  assert.equal(await main(["notifications", "update", "--new-issue-email", "false", "--repeat-threshold", "50", "--repeat-window-minutes", "120"], io), 0);
  assert.equal(await main(["notifications", "environment", "development", "--enabled", "false"], io), 0);
  assert.equal(await main(["project-health", "get", "--history-limit", "10", "--history-cursor", "next"], io), 0);
  assert.equal(await main(["project-health", "evaluate"], io), 0);
  assert.equal(await main(["event-types", "list", "--query", "checkout", "--limit", "5"], io), 0);
  assert.equal(await main(["usage", "get", "--account", "acct1"], io), 0);

  assert.deepEqual(seen.map(({ method, url }) => [method, url]), [
    ["GET", "https://rw.test/api/projects/p1/notifications"],
    ["PATCH", "https://rw.test/api/projects/p1/notifications"],
    ["PATCH", "https://rw.test/api/projects/p1/notifications/environments"],
    ["GET", "https://rw.test/api/projects/p1/health?history_limit=10&history_cursor=next"],
    ["POST", "https://rw.test/api/projects/p1/health/evaluate"],
    ["GET", "https://rw.test/api/projects/p1/event-types?q=checkout&limit=5"],
    ["GET", "https://rw.test/api/usage?account=acct1"],
  ]);
  assert.deepEqual(seen[1].body, { new_issue_email_enabled: false, repeat_issue_threshold: 50, repeat_issue_window_minutes: 120 });
  assert.deepEqual(seen[2].body, { environment: "development", enabled: false });
});
