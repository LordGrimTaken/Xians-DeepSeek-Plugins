#!/bin/sh
# Install Xian's DeepSeek Plugins into a DSH profile — every plugin OFF by default.
#
# For each plugin the script:
#   1. adds the package to the profile with `dsh plugin --profile <p> add`
#      (`link:` to the vendored copy, or `package@version` from npm);
#   2. switches the just-added bundle back OFF. `dsh plugin add` selects a new
#      bundle, which would enable the plugin; removing it from
#      `dsh.profile.bundles` leaves the package installed but not loaded;
#   3. appends a disabled `xdp-<slug>` row to the profile's own
#      cordis.patch.yml when that row id is missing.
# Nothing is switched on: you choose what runs in Settings -> Plugins, then
# reload. Packages that were already installed are left exactly as they are,
# including an enabled bundle.
#
# POSIX sh only (no bashisms). Idempotent: an installed package is skipped and
# an existing row id is never rewritten, so user edits survive re-runs.
#
# Usage: scripts/install.sh [--profile <name>] [--only <slugs>] [--dry-run] [--list] [-h]
set -eu

DEFAULT_PROFILE=web
PROFILE=$DEFAULT_PROFILE
ONLY=""
DRY_RUN=0
LIST=0

usage() {
  cat <<'EOF'
Install Xian's DeepSeek Plugins into a DSH profile.

Everything this script installs is added switched OFF: the profile gets the
package dependency plus a disabled `xdp-<slug>` row, and you turn on what you
want in Settings -> Plugins.

Usage: scripts/install.sh [options]

Options:
  --profile <name>   DSH profile to install into (default: web)
  --only <slugs>     comma-separated slugs to install (default: all 15)
  --dry-run          print what would be installed and appended, change nothing
  --list             list the curated plugins and exit
  -h, --help         show this help

Examples:
  scripts/install.sh --list
  scripts/install.sh --dry-run
  scripts/install.sh --profile web --only context-lens,notify
  DSH_HOME=/tmp/dsh-home scripts/install.sh --profile scratch

The profile is ${DSH_HOME:-$HOME/.dsh}/profiles/<name>. This script is
idempotent: already-recorded packages are skipped and rows are appended only
when the profile's cordis.patch.yml does not already carry that row id.
EOF
}

need_value() {
  # need_value <flag> <remaining-arg-count>
  if [ "$2" -lt 2 ]; then
    printf 'error: %s needs a value\n' "$1" >&2
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      need_value --profile $#
      PROFILE=$2
      shift 2
      ;;
    --profile=*)
      PROFILE=${1#*=}
      shift
      ;;
    --only)
      need_value --only $#
      ONLY=$2
      shift 2
      ;;
    --only=*)
      ONLY=${1#*=}
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --list)
      LIST=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option %s\n' "$1" >&2
      printf 'Try scripts/install.sh --help\n' >&2
      exit 2
      ;;
  esac
done

case "$PROFILE" in
  ""|*/*|*..*|*[[:space:]]*)
    printf 'error: invalid profile name %s\n' "$PROFILE" >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
if [ ! -f "$ROOT/index.json" ] || [ ! -d "$ROOT/plugins" ]; then
  printf 'error: %s does not look like the Xian'"'"'s DeepSeek Plugins checkout\n' "$ROOT" >&2
  exit 1
fi

# slug|kind|package|version — keep in sync with index.json and
# scripts/validate.mjs (validate.mjs fails when they drift).
TABLE_FILE=$(mktemp "${TMPDIR:-/tmp}/xdp-install.XXXXXX")
cleanup() { rm -f "$TABLE_FILE"; }
trap cleanup EXIT HUP INT TERM
cat > "$TABLE_FILE" <<'TABLE'
context-lens|npm|@goodandready/dsh-context-lens|0.1.35
notify|npm|@goodandready/dsh-plugin-notify|0.4.7
git-worktree|npm|@laoyuehanni/dsh-git-worktree|0.4.13
repo-map|npm|@mkaliezz/dsh-repo-map|0.2.2
agent-team-plus|vendored|@local/agent-team-plus|0.6.6
browser-control|vendored|@local/browser-control|0.1.0
game-lab|vendored|@local/game-lab|1.4.5
harness-chrome|vendored|@local/harness-chrome|1.0.0
harness-deck|vendored|@local/harness-deck|1.0.0
harness-rail|vendored|@local/harness-rail|1.0.0
inhouse-browser|vendored|@local/inhouse-browser|0.1.0
mobile-host|vendored|dsh-mobile-host|0.3.13
run-hidden|vendored|@local/dsh-plugin-run-hidden|1.0.0
session-resume|vendored|@local/session-resume|0.1.0
system-monitor|vendored|@local/system-monitor|1.0.0
TABLE

if [ "$LIST" -eq 1 ]; then
  printf '%-18s %-9s %s\n' "SLUG" "KIND" "PACKAGE@VERSION"
  npm_count=0
  vendored_count=0
  while IFS='|' read -r slug kind pkg version; do
    [ -n "$slug" ] || continue
    printf '%-18s %-9s %s@%s\n' "$slug" "$kind" "$pkg" "$version"
    case "$kind" in
      npm) npm_count=$((npm_count + 1)) ;;
      vendored) vendored_count=$((vendored_count + 1)) ;;
    esac
  done < "$TABLE_FILE"
  printf '\n%d plugins: %d npm, %d vendored\n' \
    "$((npm_count + vendored_count))" "$npm_count" "$vendored_count"
  exit 0
fi

# Normalise --only to ",slug1,slug2," and reject unknown slugs up front.
if [ -n "$ONLY" ]; then
  normalised=","
  old_ifs=$IFS
  IFS=','
  for want in $ONLY; do
    want=$(printf '%s' "$want" | tr -d '[:space:]')
    if [ -z "$want" ]; then
      continue
    fi
    known=0
    while IFS='|' read -r slug _kind _pkg _version; do
      [ -n "$slug" ] || continue
      if [ "$slug" = "$want" ]; then known=1; fi
    done < "$TABLE_FILE"
    if [ "$known" -eq 0 ]; then
      IFS=$old_ifs
      printf 'error: --only names unknown plugin %s\n' "$want" >&2
      printf '       run scripts/install.sh --list to see the slugs\n' >&2
      exit 2
    fi
    normalised=$normalised$want,
  done
  IFS=$old_ifs
  ONLY=$normalised
fi

is_selected() {
  if [ -z "$ONLY" ]; then
    return 0
  fi
  case "$ONLY" in
    *",$1,"*) return 0 ;;
  esac
  return 1
}

DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR=$DSH_HOME_DIR/profiles/$PROFILE
PKG_JSON=$PROFILE_DIR/package.json
PATCH_FILE=$PROFILE_DIR/cordis.patch.yml
DSH_BIN=${DSH_BIN:-dsh}

if [ "$DRY_RUN" -eq 0 ] && ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  printf "error: '%s' was not found on PATH.\n" "$DSH_BIN" >&2
  printf '       Install DeepSeek Harness first, or set DSH_BIN=/path/to/dsh.\n' >&2
  exit 1
fi
if [ "$DRY_RUN" -eq 1 ] && ! command -v "$DSH_BIN" >/dev/null 2>&1; then
  printf "warning: '%s' is not on PATH; the dry run still prints the commands it would run\n" "$DSH_BIN" >&2
fi

plugin_installed() {
  [ -f "$PKG_JSON" ] || return 1
  grep -Fq "\"$1\"" "$PKG_JSON"
}

row_present() {
  [ -f "$PATCH_FILE" ] || return 1
  # Match a row id line: optional list dash, `id:`, the exact id, end of line
  # (an optional YAML comment is tolerated). The slug boundary keeps
  # xdp-harness-rail from matching xdp-harness-rail-extra.
  grep -Eq "^[[:space:]]*(-[[:space:]]+)?id:[[:space:]]*xdp-$1([[:space:]]+#.*)?$" "$PATCH_FILE"
}

ensure_trailing_newline() {
  file=$1
  [ -f "$file" ] || return 0
  [ -s "$file" ] || return 0
  if [ -n "$(tail -c 1 "$file")" ]; then
    printf '\n' >> "$file"
  fi
}

patch_is_empty_list() {
  # A freshly initialized profile ships a cordis.patch.yml whose only YAML
  # document is the empty list placeholder `[]`. Appending a second document
  # without `---` would make the file unparsable, so the placeholder line is
  # removed before rows are appended. Real user content is never rewritten.
  [ -f "$PATCH_FILE" ] || return 1
  meaningful=$(grep -v -E '^[[:space:]]*(#|$)' "$PATCH_FILE" | tr -d '[:space:]' || true)
  [ "$meaningful" = "[]" ]
}

remove_empty_list_placeholder() {
  tmp="${PATCH_FILE}.xdp-tmp"
  awk '!/^[[:space:]]*\[[[:space:]]*\][[:space:]]*$/' "$PATCH_FILE" > "$tmp"
  mv "$tmp" "$PATCH_FILE"
}

append_row() {
  slug=$1
  pkg=$2
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] append disabled row xdp-%s (%s) to %s\n' "$slug" "$pkg" "$PATCH_FILE"
    return 0
  fi
  if [ ! -f "$PATCH_FILE" ]; then
    mkdir -p "$PROFILE_DIR"
    cat > "$PATCH_FILE" <<'EOF'
# Rows added by Xian's DeepSeek Plugins scripts/install.sh.
# Every package is installed but left unselected (off) and its row is inserted
# DISABLED; switch on what you want in Settings -> Plugins, then reload the page
# (restart the DSH host for host-side plugins).
EOF
  elif patch_is_empty_list; then
    remove_empty_list_placeholder
  fi
  ensure_trailing_newline "$PATCH_FILE"
  cat >> "$PATCH_FILE" <<EOF

# xdp-$slug: added disabled; enable it in Settings -> Plugins, then reload.
- insert:
    - id: xdp-$slug
      name: '$pkg'
      disabled: true
EOF
}

keep_off() {
  pkg=$1
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    [dry-run] keep %s switched off (drop it from dsh.profile.bundles)\n' "$pkg"
    return 0
  fi
  if [ ! -f "$PKG_JSON" ]; then
    return 0
  fi
  PKG_JSON="$PKG_JSON" PKG_NAME="$pkg" node -e '
    const fs = require("node:fs");
    const file = process.env.PKG_JSON;
    const name = process.env.PKG_NAME;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const bundles = data?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.includes(name)) {
      console.log("    " + name + " is not a selected bundle; it stays off");
      process.exit(0);
    }
    data.dsh.profile.bundles = bundles.filter((entry) => entry !== name);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log("    removed " + name + " from dsh.profile.bundles so it stays off");
  '
}

printf 'Installing Xian'"'"'s DeepSeek Plugins\n'
printf '  repo:    %s\n' "$ROOT"
printf '  profile: %s (%s)\n' "$PROFILE" "$PROFILE_DIR"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  mode:    dry run\n'
else
  printf '  mode:    live\n'
fi
printf '\n'

selected=0
added=0
skipped=0
failed=0
kept_off=0
rows_added=0
rows_present=0

while IFS='|' read -r slug kind pkg version; do
  [ -n "$slug" ] || continue
  is_selected "$slug" || continue
  selected=$((selected + 1))

  case "$kind" in
    vendored) spec="link:$ROOT/plugins/$slug" ;;
    npm) spec="$pkg@$version" ;;
    *)
      printf 'error: unknown kind %s for %s\n' "$kind" "$slug" >&2
      exit 1
      ;;
  esac

  newly_installed=0
  if plugin_installed "$pkg"; then
    printf '  = keep  %-18s %s (already in %s)\n' "$slug" "$pkg" "$PROFILE"
    skipped=$((skipped + 1))
  elif [ "$DRY_RUN" -eq 1 ]; then
    printf '  + add   %-18s %s\n' "$slug" "$spec"
    added=$((added + 1))
    newly_installed=1
  else
    printf '  + add   %-18s %s\n' "$slug" "$spec"
    if "$DSH_BIN" plugin --profile "$PROFILE" add "$spec"; then
      added=$((added + 1))
      newly_installed=1
    else
      printf '  x FAIL  %-18s dsh plugin add exited non-zero\n' "$slug" >&2
      failed=$((failed + 1))
      continue
    fi
  fi

  # `dsh plugin add` selects a newly added bundle, which would run the plugin.
  # Leaving the package installed but unselected keeps it OFF.
  if [ "$newly_installed" -eq 1 ]; then
    keep_off "$pkg"
    kept_off=$((kept_off + 1))
  fi

  if row_present "$slug"; then
    rows_present=$((rows_present + 1))
  else
    append_row "$slug" "$pkg"
    rows_added=$((rows_added + 1))
  fi
done < "$TABLE_FILE"

printf '\nSummary\n'
printf '  selected       %d plugin(s)\n' "$selected"
printf '  installed      %d added, %d already present, %d failed\n' "$added" "$skipped" "$failed"
printf '  kept off       %d newly installed plugin(s) left unselected\n' "$kept_off"
printf '  rows           %d appended, %d already present\n' "$rows_added" "$rows_present"
if [ "$failed" -gt 0 ]; then
  printf '  result         FAILED — %d plugin(s) could not be installed\n' "$failed"
  exit 1
fi

printf '\nNext steps\n'
printf '  1. Settings -> Plugins: switch on the plugins you want.\n'
printf '     Everything this script installs is OFF by default.\n'
printf '  2. Reload the Web page so each plugin'"'"'s client half loads.\n'
printf '  3. Restart the DSH host for host-side plugins (mobile-host,\n'
printf '     session-resume, system-monitor, browser-control, agent-team-plus,\n'
printf '     run-hidden and game-lab).\n'
printf '  4. Re-run this script any time: installed packages and existing rows are left alone.\n'
if [ "$DRY_RUN" -eq 1 ]; then
  printf '\nDry run: nothing was installed and no file was written.\n'
fi
