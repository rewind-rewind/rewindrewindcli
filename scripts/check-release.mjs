#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "release-manifest.json"), "utf8"));
const tagIndex = process.argv.indexOf("--tag");
const rawTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
const tag = rawTag?.replace(/^v/, "");
const errors = [];

if (packageJson.name !== "@rewindrewind/cli") errors.push("package.json name must be @rewindrewind/cli");
if (manifest.schema_version !== 1) errors.push("release-manifest.json schema_version must be 1");
if (manifest.package !== packageJson.name) errors.push("manifest package must match package.json name");
if (manifest.latest?.version !== packageJson.version) errors.push("manifest latest.version must match package.json version");
if (tag && tag !== packageJson.version) errors.push(`release tag ${rawTag} must match package.json version ${packageJson.version}`);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) errors.push("package version must use semantic versioning");
if (manifest.latest?.release_url && !manifest.latest.release_url.endsWith(`/v${packageJson.version}`)) errors.push("manifest release_url must end with the package version tag");

if (errors.length) {
  for (const error of errors) console.error(`release:check: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`release:check: ${packageJson.name}@${packageJson.version} is internally consistent`);
}
