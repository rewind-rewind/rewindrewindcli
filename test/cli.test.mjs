import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main, parseArgv } from "../bin/rewindrewind.mjs";

test("parseArgv supports long options, booleans, and repeated values", () => {
  const parsed = parseArgv(["api", "get", "/api/health", "--query", "a=1", "--query=b=2", "--quiet"]);
  assert.deepEqual(parsed.positionals, ["api", "get", "/api/health"]);
  assert.deepEqual(parsed.options.query, ["a=1", "b=2"]);
  assert.equal(parsed.options.quiet, true);
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

test("events send merges flags into payload", async () => {
  const seen = [];
  const io = harness({
    env: { REWINDREWIND_API_KEY: "rr_key_secret" },
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
  assert.equal(seen[0].headers.authorization, "Bearer rr_key_secret");
  assert.deepEqual(seen[0].body, {
    type: "checkout.completed",
    environment: "production",
    properties: { plan: "pro" },
  });
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
