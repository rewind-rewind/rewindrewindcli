# Releasing the RewindRewind CLI

The CLI follows Semantic Versioning. User-visible backward-compatible features
increment the minor version, fixes increment the patch version, and breaking
changes increment the major version. Before 1.0, incompatible command changes
increment the minor version and must be called out in the release notes.

For each release:

1. Update `version` in `package.json` and `package-lock.json`.
2. Update `latest.version` and `latest.release_url` in
   `release-manifest.json`.
3. Run `bin/test` and `npm run release:check -- --tag vX.Y.Z`.
4. Merge the release commit to `main`.
5. Create and push the matching annotated tag: `vX.Y.Z`.

The `Release` workflow checks that the tag, package, and manifest match. For
normal releases, it publishes the public `@rewindrewind/cli` npm package with
OIDC provenance, stamps the manifest with the publish time, and creates a GitHub
release containing the manifest. Re-running the workflow is safe when the npm
version or GitHub release already exists.

The first package version is the one exception: publish it with an authenticated
owner because npm trusted publishing can only be configured after the package
exists. From a clean release commit, run
`npm publish --access public --provenance=false` once. After that bootstrap
publish, configure this trusted publisher on npm:

- Provider: GitHub Actions
- Organization: `rewind-rewind`
- Repository: `rewindrewindcli`
- Workflow: `release.yml`
- Allowed action: `npm publish`

Do not add a long-lived npm token to GitHub. The workflow uses a GitHub-hosted
runner, Node 24, npm 11, and `id-token: write` as required by npm trusted
publishing.
