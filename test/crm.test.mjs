import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { main } from "../bin/rewindrewind.mjs";

function harness(seen) {
  const sink = () => ({ text: "", write(value) { this.text += value; } });
  const stdin = new PassThrough(); stdin.end();
  return { stdin, stdout: sink(), stderr: sink(), env: { REWINDREWIND_API_KEY: "rr_admin_secret", REWINDREWIND_PROJECT_KEY: "rrpub_public", REWINDREWIND_PROJECT_ID: "p1", REWINDREWIND_BASE_URL: "https://rw.test", REWINDREWIND_NO_UPDATE_CHECK: "1" }, disableUpdateCache: true,
    fetch: async (url, init) => { seen.push({ url: new URL(url), method: init.method, authorization: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined }); return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }); },
  };
}
test("CRM commands use admin credentials and preserve typed filters and input", async () => {
  const seen = []; const io = harness(seen);
  for (const args of [
    ["contacts", "add", "--email", "A@x.com", "--name", "Alice", "--fields", '{"score":9}'],
    ["contacts", "find", "--phone", "+16045550100"],
    ["contacts", "show", "c1"],
    ["contacts", "list", "--stage", "qualified", "--filters", '[{"key":"score","op":"gte","value":9}]'],
    ["contacts", "log", "c1", "--body", "Hello", "--channel", "email", "--direction", "outbound", "--occurred-at", "2026-10-01T00:00:00Z"],
    ["contacts", "stage", "c1", "--stage", "qualified"],
    ["contacts", "link", "c1", "--identity-id", "u1", "--org-id", "o1"],
    ["contacts", "merge", "c1", "--source", "c2"],
    ["orgs", "add", "--name", "Acme", "--domain", "example.com"],
    ["orgs", "import", "--data", '{"rows":[{"record":{"domain":"example.com"}}]}'],
    ["contacts", "reserve-first-touch", "c1"],
    ["contacts", "finish-first-touch", "c1", "--attempt-id", "a1", "--status", "uncertain"],
    ["contacts", "fields", "--data", '{"fields":[{"key":"score","type":"number","label":"Score","required":false}]}'],
  ]) assert.equal(await main([...args, "--json"], io), 0, io.stderr.text);
  assert.ok(seen.every((r) => r.authorization === "Bearer rr_admin_secret" && r.url.searchParams.get("project_id") === "p1"));
  assert.deepEqual(seen[0].body, { name: "Alice", emails: ["A@x.com"], custom_fields: { score: 9 } });
  assert.equal(seen[4].body.occurred_at, Date.parse("2026-10-01T00:00:00Z"));
  assert.deepEqual(seen[6].body, { identity_id: "u1", external_org_id: "o1" });
  assert.equal(seen[8].url.pathname, "/v1/organizations");
  assert.equal(seen[10].url.pathname, "/v1/contacts/c1/first-touch");
});
test("raw CRM requests select an admin key; identify keeps the public key", async () => {
  const seen = []; const io = harness(seen);
  assert.equal(await main(["api", "get", "/v1/contacts"], io), 0);
  assert.equal(await main(["api", "post", "/v1/identify", "--data", '{"email":"a@x.com","identityId":"u1"}'], io), 0);
  assert.equal(seen[0].authorization, "Bearer rr_admin_secret");
  assert.equal(seen[1].authorization, "Bearer rrpub_public");
});
