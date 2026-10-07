# Publishing plgnz

Set up npm Trusted Publishing for the `plgnz` package with these exact GitHub Actions fields: repository owner `archeism`, repository name `plgnz`, workflow filename `publish.yml`, and no environment. In **Allowed actions**, enable direct **`npm publish`**; newly created connections default to staging permission only. See [npm Trusted Publishing setup](https://docs.npmjs.com/trusted-publishers/).

The workflow uses GitHub's OIDC identity; no npm token or repository secret is needed. GitHub-hosted Actions runners are free for public repositories.

For each release, bump `package.json` to the next `0.0.x` patch version, run the local tests and checks, and inspect `npm pack --dry-run --ignore-scripts`. Push the reviewed change to `main`, then manually run **Publish to npm** from GitHub Actions on `main` with that exact version. The workflow checks the version and branch before publishing. Running it is the separate authorization to release; adding this workflow does not publish anything.

The published CLI currently requires Bun on the user's PATH. This workflow packages the existing source and does not build a standalone Node executable.

## Name guards (plugnz, pluginz)

`guards/plugnz` and `guards/pluginz` are placeholder packages that only exist
to hold the near-miss spellings of `plgnz` on npm; their READMEs redirect to
the real package. Before the first run of **Publish name guards**
(`.github/workflows/publish-guards.yml`), add a Trusted Publishing entry on
npmjs.com for each name — repository owner `archeism`, repository name
`plgnz`, workflow filename `publish-guards.yml`, no environment. Running the
workflow is the release authorization, exactly like the main package: it
publishes both guards from `main` and nothing else.
