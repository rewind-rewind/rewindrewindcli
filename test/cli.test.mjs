import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { main, parseArgv } from "../bin/rewindrewind.mjs";

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
    assert.equal(stdout.trim(), "0.2.0");
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

  const status = await main(["api", "post", "/api/projects/p1/retention/run", "--query", "dry_run=true", "--data", "{\"x\":1}"], io);

  assert.equal(status, 0);
  assert.equal(seen[0].url, "https://rw.test/api/projects/p1/retention/run?dry_run=true");
  assert.equal(seen[0].init.headers.authorization, "Bearer rr_prefix_secret");
  assert.equal(seen[0].init.headers["content-type"], "application/json");
  assert.deepEqual(seen[0].body, { x: 1 });
  assert.deepEqual(JSON.parse(io.stdout.text), { ok: true, answer: 42 });
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

    const status = await main(["init", "--api-key", "rr_admin_secret", "--base-url", "https://rw.test"], io);

    assert.equal(status, 0);
    const out = JSON.parse(io.stdout.text);
    assert.equal(out.project_id, "p1");
    assert.equal(out.project_key, "rrpub_realkey");
    assert.match(io.stderr.text, /Front-end exceptions/);

    const file = JSON.parse(await readFile(join(temp, "rewindrewind", "config.json"), "utf8"));
    assert.equal(file.apiKey, "rr_admin_secret");
    assert.equal(file.projectKey, "rrpub_realkey");
    assert.equal(file.projectId, "p1");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
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

  const status = await main(["issues", "update", "i1", "--status", "ignored", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.equal(JSON.parse(io.stdout.text).issue.status, "open");
  assert.match(io.stderr.text, /requested status "ignored" but issue is "open"/);
});

test("issues update is silent when the status sticks", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_key_secret", REWINDREWIND_PROJECT_ID: "p1" },
    fetch: async () => jsonResponse({ ok: true, issue: { id: "i1", status: "ignored" } }),
  });

  const status = await main(["issues", "update", "i1", "--status", "ignored", "--base-url", "https://rw.test"], io);

  assert.equal(status, 0);
  assert.equal(JSON.parse(io.stdout.text).issue.status, "ignored");
  assert.equal(io.stderr.text, "");
});

test("status reports needs_api_key when no admin key is configured", async () => {
  const io = harness({ env: {} });
  const status = await main(["status", "--base-url", "https://rw.test"], io);
  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.ready, false);
  assert.equal(out.needs_api_key, true);
  assert.match(out.action, /admin API key/);
});

test("status reports ready when the admin key validates", async () => {
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_pub" },
    fetch: async () => jsonResponse({ ok: true, projects: [{ id: "p1", name: "Web", account_id: "a1" }] }),
  });
  const status = await main(["status", "--base-url", "https://rw.test"], io);
  assert.equal(status, 0);
  const out = JSON.parse(io.stdout.text);
  assert.equal(out.ready, true);
  assert.equal(out.needs_api_key, false);
  assert.equal(out.has_project_key, true);
  assert.equal(out.project_id, "p1");
  assert.deepEqual(out.projects, [{ id: "p1", name: "Web" }]);
});

function harness(overrides = {}) {
  const stdin = new PassThrough();
  stdin.end();
  return {
    stdin,
    stdout: capture(),
    stderr: capture(),
    env: {},
    fetch: async () => jsonResponse({ ok: true }),
    ...overrides,
  };
}

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
