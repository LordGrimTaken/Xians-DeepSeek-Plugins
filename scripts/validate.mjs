#!/usr/bin/env node
/**
 * Validate this repository's curated plugin set without any dependency.
 *
 * Checks the market index (format 1) against the real curated table, the market
 * icon files, every vendored package, and the disabled rows in cordis.patch.yml.
 * Prints one line per problem and exits 1 when anything is wrong.
 *
 * Usage: node scripts/validate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const INDEX_FILE = path.join(ROOT, "index.json");
const PATCH_FILE = path.join(ROOT, "cordis.patch.yml");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const ICONS_DIR = path.join(ROOT, "icons");

/** The curated table: one row per published plugin this repository advertises. */
const CURATED = [
  { slug: "context-lens", name: "@goodandready/dsh-context-lens", version: "0.1.35", kind: "npm" },
  { slug: "notify", name: "@goodandready/dsh-plugin-notify", version: "0.4.7", kind: "npm" },
  { slug: "git-worktree", name: "@laoyuehanni/dsh-git-worktree", version: "0.4.13", kind: "npm" },
  { slug: "repo-map", name: "@mkaliezz/dsh-repo-map", version: "0.2.2", kind: "npm" },
  { slug: "agent-team-plus", name: "@local/agent-team-plus", version: "0.6.6", kind: "vendored" },
  { slug: "browser-control", name: "@local/browser-control", version: "0.1.0", kind: "vendored" },
  { slug: "game-lab", name: "@local/game-lab", version: "1.4.5", kind: "vendored" },
  { slug: "harness-chrome", name: "@local/harness-chrome", version: "1.0.0", kind: "vendored" },
  { slug: "harness-deck", name: "@local/harness-deck", version: "1.0.0", kind: "vendored" },
  { slug: "harness-rail", name: "@local/harness-rail", version: "1.0.0", kind: "vendored" },
  { slug: "inhouse-browser", name: "@local/inhouse-browser", version: "0.1.0", kind: "vendored" },
  { slug: "mobile-host", name: "dsh-mobile-host", version: "0.3.13", kind: "vendored" },
  { slug: "run-hidden", name: "@local/dsh-plugin-run-hidden", version: "1.0.0", kind: "vendored" },
  { slug: "session-resume", name: "@local/session-resume", version: "0.1.0", kind: "vendored" },
  { slug: "system-monitor", name: "@local/system-monitor", version: "1.0.0", kind: "vendored" },
];

/* The SemVer 2.0.0 grammar for one exact version, and a lowercase 40-hex SHA. */
const NUMERIC = "(?:0|[1-9]\\d*)";
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  "u",
);
const COMMIT = /^[0-9a-f]{40}$/u;
const HTTP_URL = /^https?:\/\/[^\s]+$/u;
const HTTPS_URL = /^https:\/\/[^\s]+$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

function readJsonFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    fail(label, `cannot read ${path.relative(ROOT, file)} (${error.code ?? error.message})`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(label, `invalid JSON in ${path.relative(ROOT, file)}: ${error.message}`);
    return undefined;
  }
}

function checkIndexDocument(index) {
  const label = "index.json";
  if (!isObject(index)) {
    fail(label, "must be a JSON object");
    return;
  }
  if (index.format !== 1) fail(`${label}.format`, `must be 1 (found ${JSON.stringify(index.format)})`);
  if (!nonEmptyString(index.title)) fail(`${label}.title`, "must be a non-empty string");
  if (!nonEmptyString(index.description)) fail(`${label}.description`, "must be a non-empty string");

  const metadata = index.metadata;
  if (!isObject(metadata)) {
    fail(`${label}.metadata`, "must be an object with categories, labels and sortKeys");
    return;
  }
  const categories = isObject(metadata.categories) ? metadata.categories : {};
  const labels = isObject(metadata.labels) ? metadata.labels : {};
  const sortKeys = isObject(metadata.sortKeys) ? metadata.sortKeys : {};
  if (!isObject(metadata.categories)) fail(`${label}.metadata.categories`, "must be an object");
  if (!isObject(metadata.labels)) fail(`${label}.metadata.labels`, "must be an object");
  if (!isObject(metadata.sortKeys)) fail(`${label}.metadata.sortKeys`, "must be an object");
  for (const [id, declaration] of Object.entries(categories)) {
    if (!isObject(declaration) || !nonEmptyString(declaration.title)) {
      fail(`${label}.metadata.categories.${id}.title`, "must be a non-empty string");
    }
  }
  for (const [id, declaration] of Object.entries(labels)) {
    if (!isObject(declaration) || !nonEmptyString(declaration.title)) {
      fail(`${label}.metadata.labels.${id}.title`, "must be a non-empty string");
    }
  }
  for (const [id, declaration] of Object.entries(sortKeys)) {
    if (!isObject(declaration) || !nonEmptyString(declaration.title)) {
      fail(`${label}.metadata.sortKeys.${id}.title`, "must be a non-empty string");
    }
    if (declaration?.order !== "asc" && declaration?.order !== "desc") {
      fail(`${label}.metadata.sortKeys.${id}.order`, 'must be "asc" or "desc"');
    }
  }
  index.__declared = { categories, labels, sortKeys };
}

function checkVersion(pluginName, position, version) {
  const at = `index.json plugin ${JSON.stringify(pluginName)} versions[${position}]`;
  if (!isObject(version)) {
    fail(at, "must be an object");
    return;
  }
  if (!nonEmptyString(version.version) || !SEMVER.test(version.version)) {
    fail(`${at}.version`, `must be an exact SemVer version (found ${JSON.stringify(version.version)})`);
  }
  const timestamp = version.publishTimestamp;
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= 100_000_000_000) {
    fail(`${at}.publishTimestamp`, "must be an integer number of Unix seconds in [0, 10^11)");
  }
  const source = version.source;
  if (!isObject(source) || (source.type !== "npm" && source.type !== "git")) {
    fail(`${at}.source.type`, 'must be "npm" or "git"');
    return;
  }
  if (source.type === "npm") {
    if (source.commit !== undefined) fail(`${at}.source.commit`, "an npm source must not carry a commit");
  } else {
    if (!nonEmptyString(source.url) || !HTTPS_URL.test(source.url)) {
      fail(`${at}.source.url`, "must be an absolute https URL");
    } else if (!/^https:\/\/[^/]+\/.+\/.+/u.test(source.url)) {
      fail(`${at}.source.url`, "must name a repository with at least two path segments");
    } else if (/\.(?:tgz|tar\.gz)$/iu.test(source.url)) {
      fail(`${at}.source.url`, "must name a repository, not a tarball");
    }
    if (!nonEmptyString(source.commit) || !COMMIT.test(source.commit)) {
      fail(`${at}.source.commit`, "must be a lowercase 40-hex-digit commit SHA");
    }
    if (source.path !== undefined && (!nonEmptyString(source.path) || source.path.includes(".."))) {
      fail(`${at}.source.path`, "must be a relative package directory without ..");
    }
  }
  const engines = version.engines;
  if (!isObject(engines)) {
    fail(`${at}.engines`, "must be an object with a dsh range, such as { dsh: \">=0.2.0\" }");
  } else if (!nonEmptyString(engines.dsh)) {
    fail(`${at}.engines.dsh`, "must be a non-empty SemVer range string");
  }
}

function checkPlugin(plugin, position, declared) {
  const at = `index.json plugins[${position}]`;
  if (!isObject(plugin)) {
    fail(at, "must be an object");
    return;
  }
  if (!nonEmptyString(plugin.name)) fail(`${at}.name`, "must be a non-empty package name");
  if (!nonEmptyString(plugin.title)) fail(`${at}.title`, "must be a non-empty string");
  if (!nonEmptyString(plugin.description)) fail(`${at}.description`, "must be a non-empty string");
  if (!nonEmptyString(plugin.icon)) {
    fail(`${at}.icon`, "must be a relative icon reference such as icons/<slug>.svg");
  } else if (!/^icons\/[a-z0-9-]+\.svg$/u.test(plugin.icon)) {
    fail(`${at}.icon`, `must look like icons/<slug>.svg (found ${JSON.stringify(plugin.icon)})`);
  }
  if (!nonEmptyString(plugin.author)) fail(`${at}.author`, "must be a non-empty string");
  if (!nonEmptyString(plugin.homepage) || !HTTP_URL.test(plugin.homepage)) {
    fail(`${at}.homepage`, "must be an absolute http(s) URL");
  }
  if (!isObject(plugin.repository)) {
    fail(`${at}.repository`, "must be an object with type and url");
  } else {
    if (!nonEmptyString(plugin.repository.url) || !HTTP_URL.test(plugin.repository.url)) {
      fail(`${at}.repository.url`, "must be an absolute http(s) URL");
    }
  }

  const metadata = plugin.metadata;
  if (!isObject(metadata)) {
    fail(`${at}.metadata`, "must be an object with category, keywords and labels");
  } else {
    if (!nonEmptyString(metadata.category)) {
      fail(`${at}.metadata.category`, "must be a non-empty category id");
    } else if (!Object.hasOwn(declared.categories, metadata.category)) {
      fail(`${at}.metadata.category`, `references undeclared category ${JSON.stringify(metadata.category)}`);
    }
    if (!Array.isArray(metadata.keywords)) {
      fail(`${at}.metadata.keywords`, "must be an array of strings");
    } else {
      metadata.keywords.forEach((keyword, index) => {
        if (typeof keyword !== "string") fail(`${at}.metadata.keywords[${index}]`, "must be a string");
      });
    }
    if (!Array.isArray(metadata.labels)) {
      fail(`${at}.metadata.labels`, "must be an array of label ids");
    } else {
      metadata.labels.forEach((label, index) => {
        if (typeof label !== "string" || !Object.hasOwn(declared.labels, label)) {
          fail(`${at}.metadata.labels[${index}]`, `references undeclared label ${JSON.stringify(label)}`);
        }
      });
      if (new Set(metadata.labels).size !== metadata.labels.length) {
        fail(`${at}.metadata.labels`, "must not repeat a label");
      }
    }
    if (metadata.sortKeys !== undefined && !isObject(metadata.sortKeys)) {
      fail(`${at}.metadata.sortKeys`, "must be an object");
    }
  }

  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    fail(`${at}.versions`, "must be a non-empty array");
    return;
  }
  plugin.versions.forEach((version, index) => checkVersion(plugin.name, index, version));
}

function checkIndexAgainstCurated(index) {
  const declared = index.__declared ?? { categories: {}, labels: {}, sortKeys: {} };
  if (!Array.isArray(index.plugins)) {
    fail("index.json.plugins", "must be an array");
    return;
  }
  if (index.plugins.length !== CURATED.length) {
    fail("index.json.plugins", `must list exactly ${CURATED.length} plugins (found ${index.plugins.length})`);
  }
  const names = new Map();
  index.plugins.forEach((plugin, position) => {
    if (!isObject(plugin)) return;
    checkPlugin(plugin, position, declared);
    if (nonEmptyString(plugin.name)) {
      if (names.has(plugin.name)) {
        fail(`index.json.plugins[${position}].name`, `duplicates ${JSON.stringify(plugin.name)}`);
      } else {
        names.set(plugin.name, plugin);
      }
    }
  });

  const curatedNames = new Set(CURATED.map((entry) => entry.name));
  for (const name of names.keys()) {
    if (!curatedNames.has(name)) fail("index.json.plugins", `lists unexpected plugin ${JSON.stringify(name)}`);
  }

  for (const expected of CURATED) {
    const plugin = names.get(expected.name);
    if (plugin === undefined) {
      fail("index.json.plugins", `is missing ${expected.name} (${expected.slug})`);
      continue;
    }
    if (plugin.icon !== `icons/${expected.slug}.svg`) {
      fail(`index.json plugin ${JSON.stringify(expected.name)}.icon`, `must be icons/${expected.slug}.svg`);
    }
    if (!Array.isArray(plugin.versions)) continue;
    const version = plugin.versions.find((entry) => entry?.version === expected.version);
    if (version === undefined) {
      fail(
        `index.json plugin ${JSON.stringify(expected.name)}.versions`,
        `is missing version ${expected.version}`,
      );
      continue;
    }
    const wantGit = expected.kind === "vendored";
    const sourceType = version.source?.type;
    if (wantGit && sourceType !== "git") {
      fail(`index.json plugin ${JSON.stringify(expected.name)}.versions`, "a vendored plugin must use a git source");
    }
    if (!wantGit && sourceType !== "npm") {
      fail(`index.json plugin ${JSON.stringify(expected.name)}.versions`, "a published plugin must use an npm source");
    }
    if (wantGit && version.source?.path !== `plugins/${expected.slug}`) {
      fail(
        `index.json plugin ${JSON.stringify(expected.name)}.versions.source.path`,
        `must be plugins/${expected.slug}`,
      );
    }
  }
}

function checkIcons() {
  if (!fs.existsSync(ICONS_DIR)) {
    fail("icons/", `directory is missing; expected ${CURATED.length} SVG icons at icons/<slug>.svg`);
    return;
  }
  let ok = 0;
  for (const entry of CURATED) {
    const file = path.join(ICONS_DIR, `${entry.slug}.svg`);
    if (!fs.existsSync(file)) {
      fail("icons/", `missing ${path.relative(ROOT, file)} for plugin ${entry.slug}`);
      continue;
    }
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8");
    if (stat.size === 0) fail("icons/", `${path.relative(ROOT, file)} is empty`);
    else if (!text.includes("<svg")) fail("icons/", `${path.relative(ROOT, file)} is not an SVG document`);
    else ok += 1;
  }
  return ok;
}

function checkVendoredPackages() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fail("plugins/", "directory is missing; the vendored packages it holds are required");
    return;
  }
  const expectedDirs = new Set(CURATED.filter((entry) => entry.kind === "vendored").map((entry) => entry.slug));
  let ok = 0;

  for (const name of fs.readdirSync(PLUGINS_DIR)) {
    const file = path.join(PLUGINS_DIR, name);
    if (!fs.statSync(file).isDirectory()) continue;
    if (!expectedDirs.has(name)) {
      fail("plugins/", `unexpected directory plugins/${name}; update the curated table in scripts/validate.mjs`);
    }
  }

  for (const entry of CURATED) {
    if (entry.kind !== "vendored") continue;
    const dir = path.join(PLUGINS_DIR, entry.slug);
    if (!fs.existsSync(dir)) {
      fail("plugins/", `missing vendored package directory plugins/${entry.slug}`);
      continue;
    }
    const manifestFile = path.join(dir, "package.json");
    const manifest = readJsonFile(manifestFile, `plugins/${entry.slug}/package.json`);
    if (!isObject(manifest)) continue;
    if (manifest.name !== entry.name) {
      fail(`plugins/${entry.slug}/package.json.name`, `must stay ${JSON.stringify(entry.name)}`);
    }
    if (manifest.version !== entry.version) {
      fail(`plugins/${entry.slug}/package.json.version`, `must stay ${JSON.stringify(entry.version)}`);
    }
    if (manifest.icon !== "./icon.svg") {
      fail(`plugins/${entry.slug}/package.json.icon`, 'must be "./icon.svg"');
    }
    if (Array.isArray(manifest.files) && !manifest.files.includes("icon.svg")) {
      fail(`plugins/${entry.slug}/package.json.files`, 'must include "icon.svg"');
    }
    const iconFile = path.join(dir, "icon.svg");
    if (!fs.existsSync(iconFile)) {
      fail(`plugins/${entry.slug}/`, "icon file icon.svg is missing");
    } else if (fs.statSync(iconFile).size === 0) {
      fail(`plugins/${entry.slug}/icon.svg`, "is empty");
    } else if (!fs.readFileSync(iconFile, "utf8").includes("<svg")) {
      fail(`plugins/${entry.slug}/icon.svg`, "is not an SVG document");
    } else {
      ok += 1;
    }
  }
  return ok;
}

function checkPatchFile() {
  if (!fs.existsSync(PATCH_FILE)) {
    fail("cordis.patch.yml", "file is missing");
    return;
  }
  const text = fs.readFileSync(PATCH_FILE, "utf8");
  if (text.includes("\t")) fail("cordis.patch.yml", "must not use tab characters (invalid YAML indentation)");
  const rows = new Map();
  const rowPattern = /^[ \t]*-[ \t]+id:[ \t]*(xdp-[A-Za-z0-9._-]+)[ \t]*$/gmu;
  let match;
  const blocks = [];
  while ((match = rowPattern.exec(text)) !== null) {
    blocks.push({ id: match[1], start: match.index });
  }
  blocks.forEach((block, index) => {
    const end = index + 1 < blocks.length ? blocks[index + 1].start : text.length;
    rows.set(block.id, text.slice(block.start, end));
  });
  let ok = 0;
  for (const entry of CURATED) {
    const id = `xdp-${entry.slug}`;
    const block = rows.get(id);
    if (block === undefined) {
      fail("cordis.patch.yml", `missing disabled row id ${id} for ${entry.name}`);
      continue;
    }
    if (!new RegExp(`name:[ \\t]*['"]?${escapeRegExp(entry.name)}['"]?[ \\t]*$`, "mu").test(block)) {
      fail("cordis.patch.yml", `row ${id} does not name ${entry.name}`);
    }
    if (!/disabled:[ \t]*true[ \t]*$/mu.test(block)) {
      fail("cordis.patch.yml", `row ${id} must be added disabled: true`);
    }
    ok += 1;
  }
  const curatedIds = new Set(CURATED.map((entry) => `xdp-${entry.slug}`));
  for (const id of rows.keys()) {
    if (!curatedIds.has(id)) fail("cordis.patch.yml", `unexpected row id ${id}; update the curated table`);
  }
  return ok;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function main() {
  const index = readJsonFile(INDEX_FILE, "index.json");
  if (index !== undefined) {
    checkIndexDocument(index);
    checkIndexAgainstCurated(index);
  }
  const icons = checkIcons() ?? 0;
  const vendored = checkVendoredPackages() ?? 0;
  const rows = checkPatchFile() ?? 0;
  const npmCount = CURATED.filter((entry) => entry.kind === "npm").length;
  const vendoredCount = CURATED.length - npmCount;

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`FAIL ${error}\n`);
    process.stderr.write(`\n${errors.length} problem${errors.length === 1 ? "" : "s"} found — validation failed\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write("Xian's DeepSeek Plugins — validation OK\n");
  process.stdout.write(
    `  index.json        format 1, ${CURATED.length} plugins (${npmCount} npm, ${vendoredCount} vendored), exact semver, pinned-shape git sources\n`,
  );
  process.stdout.write(`  icons/            ${icons} SVG files at icons/<slug>.svg\n`);
  process.stdout.write(`  plugins/          ${vendored} vendored packages with icon field and icon.svg\n`);
  process.stdout.write(`  cordis.patch.yml  ${rows} disabled xdp-<slug> rows\n`);
  process.stdout.write("  icon fields, package names and versions match the curated table\n");
}

main();
