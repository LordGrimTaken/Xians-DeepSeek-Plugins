# Contributing

This is a small, curated pack: every entry is a plugin the maintainer runs
daily. Contributions are welcome for docs, icons, packaging, and bug fixes;
proposals to add or replace a plugin are judged against "does this belong in an
everyday set?", not against "is this a good plugin?".

## Scope

- **In scope:** corrections to [docs/](docs), fixes to the installer and
  validation scripts, icon or brand improvements that follow
  [brand/palette.md](brand/palette.md), version bumps, and vendored-package
  updates.
- **Out of scope:** new plugins without a working upstream and a real daily use
  case, themes, and personal tooling.
- **Never:** edit `icons/`, `brand/`, `plugins/`, `scripts/`, `index.json`, or
  `cordis.patch.yml` in a docs-only change, and never commit `node_modules/`,
  build output, logs, scratch files, or secrets.

## Adding a plugin

A plugin is six things, all of which must agree:

1. **Icon** — `icons/<slug>.svg`, following the rules in
   [brand/palette.md](brand/palette.md): 64×64 viewBox, rounded-square
   container, mint glyph, no text, no external references, at most 4 KB.
2. **Package** — if it is not published on npm, vendor the package under
   `plugins/<slug>/`, preserving its `package.json` name and version and its
   top-level `icon: "./icon.svg"`. Remove `.git`, `node_modules`, `.bak-*`
   copies, and logs.
3. **Index entry** — add it to `index.json` (format 1) with a title,
   description, `icons/<slug>.svg`, authors, repository, category/label/keyword
   metadata, and a source: `npm` for published packages or `git` (URL,
   40-character commit, `path: plugins/<slug>`) for vendored ones. Run
   `node scripts/pin-index.mjs` so the commit points at the vendored content.
4. **Loader row** — one entry in `cordis.patch.yml` with id `xdp-<slug>`, the
   package name, and `disabled: true`. Everything installs off.
5. **Docs** — a row in the README catalog and a full card in
   [docs/PLUGINS.md](docs/PLUGINS.md): tagline, what it does, why you'd want it,
   package/version/source, requirements, only-verified config, upstream link.
6. **Validation** — `node scripts/validate.mjs` must pass, and a scratch-profile
   install (`./scripts/install.sh --profile <scratch>`) must mount the row.

## Style rules

- **Icons** are SVG only, follow [brand/palette.md](brand/palette.md), and stay
  legible at 24 px. No text, no embedded raster images, no `@import`, no
  external references.
- **Docs** use relative links only, one H1 per file, H2 for sections. Never
  invent a config key, flag, environment variable, route, or endpoint — quote
  the package and link the upstream source. Every command must be
  copy-pasteable, and code-fence lines stay at or under 120 characters.
- **Claims** are testable. Say what you verified and how; if a detail is not in
  the package, say so and link upstream instead of guessing.
- **Versions** are exact. The index, the docs, and the vendored manifests must
  agree on every version string.

## Validation

```bash
node scripts/validate.mjs
```

The dependency-free validator checks the index format version, unique package
names, exact semver, 40-hex commits, icon existence for every entry, a
`package.json` plus `icon.svg` in every vendored package, and that all 15 slugs
appear across the index, icons, catalog, and docs.

## Commits

Use a short imperative subject with a scope prefix that matches the area:

```text
docs: add the Android SDK note to install
icons: sharpen the game-lab glyph at 24 px
index: pin the vendored game-lab source
cordis: keep xdp-session-resume disabled
scripts: reject duplicate index names
chore: bump repo tooling
```

One concern per commit. Stage explicit paths (`git add README.md docs`), never
`git add -A`, and do not push — the maintainer publishes.

## License

By contributing you agree that your contribution is licensed under the
repository's [MIT license](LICENSE).
