#!/usr/bin/env node
/**
 * Pin index.json's git sources to the commit that actually contains the
 * vendored plugin content.
 *
 * Index format 1 requires an exact 40-hex commit for every git source. While a
 * plugin is being curated the index can keep the documented placeholder
 * (`0000000000000000000000000000000000000000`); at release time this script
 * rewrites every git source in index.json to the repository commit that last
 * touched plugins/, so the market installs the exact vendored files this index
 * advertises.
 *
 * Usage:
 *   node scripts/pin-index.mjs            pin git sources, then write index.json
 *   node scripts/pin-index.mjs --dry-run  print what would change, write nothing
 *   node scripts/pin-index.mjs --head     pin to HEAD instead of the last plugins/ commit
 *
 * Exit codes: 0 pinned (or already pinned), 1 failure (no commit, bad index, git error).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const INDEX_FILE = path.join(ROOT, "index.json");
const COMMIT = /^[0-9a-f]{40}$/u;

function usage() {
  process.stdout.write(
    "Usage: node scripts/pin-index.mjs [--dry-run] [--head]\n\n" +
      "  --dry-run  report the commit and affected entries without writing index.json\n" +
      "  --head     pin to git rev-parse HEAD instead of the last commit touching plugins/\n",
  );
}

function parseArgs(argv) {
  const options = { dryRun: false, head: false, help: false };
  for (const argument of argv) {
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--head") options.head = true;
    else if (argument === "-h" || argument === "--help") options.help = true;
    else {
      process.stderr.write(`error: unknown argument ${JSON.stringify(argument)}\n`);
      usage();
      process.exitCode = 2;
      return undefined;
    }
  }
  return options;
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveCommit(options) {
  if (options.head) {
    try {
      return { commit: git("rev-parse", "HEAD"), basis: "HEAD" };
    } catch (error) {
      throw new Error(`git rev-parse HEAD failed: ${error.stderr?.toString().trim() || error.message}`);
    }
  }
  // The commit that owns the vendored plugin files is the one a market install
  // must check out; fall back to HEAD when plugins/ has never been committed.
  try {
    const lastPluginsCommit = git("log", "-1", "--format=%H", "--", "plugins");
    if (lastPluginsCommit !== "") return { commit: lastPluginsCommit, basis: "last commit touching plugins/" };
  } catch (error) {
    throw new Error(`git log for plugins/ failed: ${error.stderr?.toString().trim() || error.message}`);
  }
  try {
    return { commit: git("rev-parse", "HEAD"), basis: "HEAD (plugins/ has no commit yet)" };
  } catch (error) {
    throw new Error(`git rev-parse HEAD failed: ${error.stderr?.toString().trim() || error.message}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) return;
  if (options.help) {
    usage();
    return;
  }

  let raw;
  try {
    raw = fs.readFileSync(INDEX_FILE, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${path.relative(ROOT, INDEX_FILE)}: ${error.code ?? error.message}`);
  }
  let index;
  try {
    index = JSON.parse(raw);
  } catch (error) {
    throw new Error(`index.json is not valid JSON: ${error.message}`);
  }
  if (typeof index !== "object" || index === null || !Array.isArray(index.plugins)) {
    throw new Error("index.json does not look like a format-1 market index (plugins must be an array)");
  }

  const { commit, basis } = resolveCommit(options);
  if (!COMMIT.test(commit)) throw new Error(`resolved commit is not 40 lowercase hex digits: ${JSON.stringify(commit)}`);

  const changed = [];
  let gitSources = 0;
  for (const plugin of index.plugins) {
    if (typeof plugin !== "object" || plugin === null || !Array.isArray(plugin.versions)) continue;
    for (const version of plugin.versions) {
      if (version?.source?.type !== "git") continue;
      gitSources += 1;
      if (version.source.commit === commit) continue;
      changed.push({ name: plugin.name, version: version.version, from: version.source.commit });
      version.source.commit = commit;
    }
  }

  if (!options.dryRun && changed.length > 0) {
    fs.writeFileSync(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);
  }

  const verb = options.dryRun ? "would pin" : "pinned";
  process.stdout.write(
    `${verb} ${changed.length} of ${gitSources} git source${gitSources === 1 ? "" : "s"} ` +
      `in index.json to ${commit}\n`,
  );
  process.stdout.write(`commit basis: ${basis}\n`);
  if (changed.length === 0) {
    process.stdout.write("all git sources already carry that commit\n");
    return;
  }
  for (const entry of changed) {
    process.stdout.write(`  ${entry.name}@${entry.version}: ${entry.from ?? "(missing)"} -> ${commit}\n`);
  }
  if (options.dryRun) {
    process.stdout.write("dry run: index.json was not written\n");
  } else {
    process.stdout.write(`wrote ${path.relative(ROOT, INDEX_FILE)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
