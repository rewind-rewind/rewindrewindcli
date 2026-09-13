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

The `Release` workflow checks that the tag, repository, and manifest match. It
stamps the manifest with the release time and creates a GitHub release that
contains the manifest. Re-running the workflow replaces the manifest asset on
an existing release.

The CLI is not published to the npm registry. npm is only the installer for the
tagged GitHub source. The updater derives and installs this exact source from the
validated repository and semantic version:

```sh
npm install --global github:rewind-rewind/rewindrewindcli#vX.Y.Z
```
