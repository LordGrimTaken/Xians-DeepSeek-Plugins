#!/bin/sh
# Cosmetic green-icon overlay for the four published (npm) plugins.
#
# The vendored plugins in plugins/ ship the curated icon inside their package.
# Plugins installed from the npm registry do not, so their cards fall back to
# the default artwork in the Plugins/Discover lists. This helper copies
# icons/<slug>.svg into the installed package directory under the profile's
# node_modules and adds "icon": "./icon.svg" to its package.json when absent.
#
# WARNING: this is cosmetic and reversible, not durable.
#   - A package update or reinstall replaces the package directory, removing the
#     image and the field; simply re-run this script afterwards.
#   - pnpm may share the package directory with other profiles through its
#     content store, so the overlay can appear in those profiles too.
#   - `--restore` removes the files and field this script added.
#
# Usage: scripts/apply-icon-overlay.sh [--profile <name>] [--restore] [-h]
set -eu

PROFILE=web
RESTORE=0

usage() {
  cat <<'EOF'
Overlay the curated green icons onto already-installed npm plugins.

The four published plugins (context-lens, notify, git-worktree, repo-map) are
installed from the npm registry, so they do not carry icons/<slug>.svg inside
the package. This script copies the curated icon into each installed package
directory and points the package manifest at it.

WARNING: package updates and reinstalls revert this overlay. Re-run it after an
update, or use --restore to remove it.

Usage: scripts/apply-icon-overlay.sh [options]

Options:
  --profile <name>   DSH profile whose node_modules to touch (default: web)
  --restore          remove the icons and "icon" fields this script added
  -h, --help         show this help
EOF
}

need_value() {
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
    --restore)
      RESTORE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown option %s\n' "$1" >&2
      printf 'Try scripts/apply-icon-overlay.sh --help\n' >&2
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

if ! command -v node >/dev/null 2>&1; then
  printf 'error: node is required to edit package.json\n' >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ICONS_DIR=$ROOT/icons
if [ ! -d "$ICONS_DIR" ]; then
  printf 'error: %s is missing; this checkout has no curated icon set\n' "$ICONS_DIR" >&2
  exit 1
fi

DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR=$DSH_HOME_DIR/profiles/$PROFILE
NODE_MODULES=$PROFILE_DIR/node_modules

if [ ! -d "$NODE_MODULES" ]; then
  printf 'error: %s does not exist.\n' "$NODE_MODULES" >&2
  printf '       Install the plugins into profile %s first (scripts/install.sh).\n' "$PROFILE" >&2
  exit 1
fi

# slug|package — only the published npm plugins need this overlay.
ICON_TABLE=$(mktemp "${TMPDIR:-/tmp}/xdp-icon-overlay.XXXXXX")
cleanup() { rm -f "$ICON_TABLE"; }
trap cleanup EXIT HUP INT TERM
cat > "$ICON_TABLE" <<'TABLE'
context-lens|@goodandready/dsh-context-lens
notify|@goodandready/dsh-plugin-notify
git-worktree|@laoyuehanni/dsh-git-worktree
repo-map|@mkaliezz/dsh-repo-map
TABLE

add_icon_field() {
  PKG_JSON=$1 node -e '
    const fs = require("node:fs");
    const file = process.env.PKG_JSON;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.icon === "./icon.svg") {
      console.log("      package.json already points icon at ./icon.svg");
      process.exit(0);
    }
    if (data.icon !== undefined) {
      console.log("      kept the package\047s own icon field " + JSON.stringify(data.icon));
      process.exit(0);
    }
    // Keep the familiar key order: icon follows exports (or type) when present.
    const out = {};
    let placed = false;
    const put = () => { if (!placed) { out.icon = "./icon.svg"; placed = true; } };
    for (const [key, value] of Object.entries(data)) {
      out[key] = value;
      if (key === "exports" || (!("exports" in data) && key === "type")) put();
    }
    if (!placed) put();
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
    console.log("      added \"icon\": \"./icon.svg\" to package.json");
  '
}

remove_icon_field() {
  PKG_JSON=$1 node -e '
    const fs = require("node:fs");
    const file = process.env.PKG_JSON;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.icon !== "./icon.svg") {
      console.log("      package.json icon field is not ours; left untouched");
      process.exit(0);
    }
    delete data.icon;
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log("      removed \"icon\": \"./icon.svg\" from package.json");
  '
}

if [ "$RESTORE" -eq 1 ]; then
  printf 'Removing the green-icon overlay from profile %s\n' "$PROFILE"
else
  printf "Applying the green-icon overlay to profile %s\n" "$PROFILE"
  printf 'WARNING: package updates and reinstalls revert this overlay; cosmetic only.\n'
fi

changed=0
skipped=0
while IFS='|' read -r slug pkg; do
  [ -n "$slug" ] || continue
  pkg_dir=$NODE_MODULES/$pkg
  icon=$ICONS_DIR/$slug.svg
  printf '  %s (%s)\n' "$slug" "$pkg"

  if [ ! -d "$pkg_dir" ]; then
    printf '    skipped: not installed in this profile\n'
    skipped=$((skipped + 1))
    continue
  fi
  if [ ! -f "$icon" ]; then
    printf '    skipped: curated icon %s is missing\n' "$icon"
    skipped=$((skipped + 1))
    continue
  fi
  if [ ! -f "$pkg_dir/package.json" ]; then
    printf '    skipped: %s/package.json is missing\n' "$pkg_dir"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$RESTORE" -eq 1 ]; then
    if [ -f "$pkg_dir/icon.svg" ] && cmp -s "$pkg_dir/icon.svg" "$icon"; then
      rm -f "$pkg_dir/icon.svg"
      printf '    removed icon.svg\n'
    else
      printf '    no overlay icon.svg to remove (or it is not ours)\n'
    fi
    remove_icon_field "$pkg_dir/package.json"
  else
    cp "$icon" "$pkg_dir/icon.svg"
    printf '    copied icon.svg\n'
    add_icon_field "$pkg_dir/package.json"
  fi
  changed=$((changed + 1))
done < "$ICON_TABLE"

if [ "$RESTORE" -eq 1 ]; then
  action=Restored
else
  action=Overlaid
fi
printf '\n%s %d plugin(s), skipped %d.\n' "$action" "$changed" "$skipped"
if [ "$RESTORE" -eq 1 ]; then
  printf 'Reload the Web page to see the default artwork again.\n'
else
  printf 'Reload the Web page to see the icons.\n'
  printf 'Re-run this script after every package update; it is overwritten otherwise.\n'
fi
