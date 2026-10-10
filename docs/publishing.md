# Publishing plugnz

Set up npm Trusted Publishing for the `plugnz` package with these exact GitHub Actions fields: repository owner `archeism`, repository name `plugnz`, workflow filename `publish.yml`, and no environment. In **Allowed actions**, enable direct **`npm publish`**; newly created connections default to staging permission only. See [npm Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/).

The workflow uses GitHub's OIDC identity; no npm token or repository secret is needed. GitHub-hosted Actions runners are free for public repositories.

For each release, bump `package.json` to the next `0.0.x` patch version, run the local tests and checks, and inspect `bun run build && npm pack --dry-run --ignore-scripts  # dist/ must exist: files ships [dist] only`. Push the reviewed change to `main`, then manually run **Publish to npm** from GitHub Actions on `main` with that exact version. The workflow checks the version and branch before publishing. Running it is the separate authorization to release; adding this workflow does not publish anything.

The published package ships `dist/plugnz.mjs` — one plain-JavaScript ESM bundle with a `node` shebang — so `npx plugnz` works on any machine with Node >= 22 and `bunx plugnz` keeps working. Bun remains the build and development toolchain only: the workflow installs with Bun, builds with `bun run build` (scripts/build.mjs, `--target=node`), and smoke-checks the bundle under plain Node before publishing. Never commit `dist/`; the artifact exists only inside the publish run.

## Automated releases (merge = publish) — early-stage velocity policy

**This supersedes the manual-dispatch-only release rule (owner decision,
2026-10-10).** Every push to `main` publishes the next `0.0.x` patch
automatically: build -> registry check (loop guard) -> patch bump ->
Trusted Publishing publish -> `v<version>` tag -> bump commit back with
`[skip ci]`. The loop guard is the registry itself — when package.json's
version already exists on npm the run succeeds without publishing, so the
bump commit's own re-trigger is a no-op. Manual dispatch (version must
match `package.json`) remains for exact-version releases. Never hand-edit
`package.json`'s version on main; the release-bot owns it. When the
project outgrows this, move to tag-triggered releases before reinstating
any manual gate.

## Name guard (pluginz)

`guards/pluginz` reserves the alternate spelling. Its release workflow is
`publish-guards.yml`; the actual `plugnz` package is published from the root
through `publish.yml`.

## Rename compatibility

The previous `plgnz` executable remains an alias. Existing `.open-plugin` state,
`.plgnz` ownership markers and host-managed directories retain their names so
installed plugins continue to be recognized. `plugnz` is the public package,
repository and preferred command name.
