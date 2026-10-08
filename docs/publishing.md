# Publishing plugnz

Set up npm Trusted Publishing for the `plugnz` package with these exact GitHub Actions fields: repository owner `archeism`, repository name `plugnz`, workflow filename `publish.yml`, and no environment. In **Allowed actions**, enable direct **`npm publish`**; newly created connections default to staging permission only. See [npm Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/).

The workflow uses GitHub's OIDC identity; no npm token or repository secret is needed. GitHub-hosted Actions runners are free for public repositories.

For each release, bump `package.json` to the next `0.0.x` patch version, run the local tests and checks, and inspect `npm pack --dry-run --ignore-scripts`. Push the reviewed change to `main`, then manually run **Publish to npm** from GitHub Actions on `main` with that exact version. The workflow checks the version and branch before publishing. Running it is the separate authorization to release; adding this workflow does not publish anything.

The published CLI currently requires Bun on the user's PATH. This workflow packages the existing source and does not build a standalone Node executable.

## Name guard (pluginz)

`guards/pluginz` reserves the alternate spelling. Its release workflow is
`publish-guards.yml`; the actual `plugnz` package is published from the root
through `publish.yml`.

## Rename compatibility

The previous `plgnz` executable remains an alias. Existing `.open-plugin` state,
`.plgnz` ownership markers and host-managed directories retain their names so
installed plugins continue to be recognized. `plugnz` is the public package,
repository and preferred command name.
