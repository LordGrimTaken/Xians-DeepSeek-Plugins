#!/bin/sh
# Cosmetic green-icon overlay for the four published (npm) plugins.
#
# The vendored plugins in plugins/ ship the curated icon inside their package, so
# they need nothing. Plugins installed from the npm registry do not carry
# icons/<slug>.svg in their package, so their cards fall back to the default
# artwork in the Plugins/Discover lists. This helper copies icons/<slug>.svg into
# the installed package directory under the profile's node_modules and makes the
# manifest able to advertise it:
#   - adds "icon": "./icon.svg" when the package has no icon field, and
#   - adds an "./icon" export when the package's `exports` map hides package.json
#     (without one, the Harness cannot read the manifest and the icon is ignored).
#
# WARNING: this is cosmetic and reversible, not durable.
#   - A package update or reinstall replaces the package directory, removing the
#     image and the edits; simply re-run this script afterwards.
#   - pnpm may share the package directory with other profiles through its
#     content store, so the overlay can appear in those profiles too.
#   - `--restore` reverts exactly what it added, using a state file kept in the
#     profile: <profile>/.xdp-icon-overlay/state.json and the replaced icons.
#
# Usage: scripts/apply-icon-overlay.sh [--profile <name>] [--restore] [-h]
set -eu

PROFILE=web
RESTORE=0

usage() {
  cat <<'EOF'
Overlay the curated green icons onto already-installed npm plugins.

The four published plugins (context-lens, notify, git-worktree, repo-map) are
installed from the npm registry, so they do not carry icons/<slug>.svg inside the
package. This script copies the curated icon into each installed package
directory and points the package manifest at it (adding an "./icon" export when
the manifest would otherwise be unreachable).

WARNING: package updates and reinstalls revert this overlay. Re-run it after an
update, or use --restore to remove it.

Usage: scripts/apply-icon-overlay.sh [options]

Options:
  --profile <name>   DSH profile whose node_modules to touch (default: web)
  --restore          remove the icons and manifest edits this script added
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

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ICONS_DIR=$ROOT/icons
if [ ! -d "$ICONS_DIR" ]; then
  printf 'error: %s/icons is missing; run this from a full checkout.\n' "$ROOT" >&2
  exit 1
fi

DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
PROFILE_DIR=$DSH_HOME_DIR/profiles/$PROFILE
NODE_MODULES=$PROFILE_DIR/node_modules
STATE_DIR=$PROFILE_DIR/.xdp-icon-overlay
STATE_FILE=$STATE_DIR/state.json

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

# Edit one package manifest and record/replay exactly our own edits.
#   MODE=apply   PKG=... ICON_FIELD/EXPORT flags computed in-node
#   MODE=restore PKG=... SLUG=... STATE=...
edit_manifest() {
  MODE=$1 PKG_JSON=$2 STATE=$STATE_FILE SLUG=${3:-} node -e '
    const fs = require("node:fs");
    const file = process.env.PKG_JSON;
    const stateFile = process.env.STATE;
    const mode = process.env.MODE;
    const slug = process.env.SLUG;
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const name = data.name;
    const put = (key, value) => {
      if (data[key] === value) return;
      // keep the familiar key order: icon right after exports (or type)
      const out = {};
      let placed = key !== "icon";
      for (const [k, v] of Object.entries(data)) {
        if (k === key) continue;
        out[k] = v;
        if (!placed && (k === "exports" || (!("exports" in data) && k === "type"))) {
          out[key] = value;
          placed = true;
        }
      }
      if (!placed) out[key] = value;
      for (const k of Object.keys(data)) delete data[k];
      Object.assign(data, out);
    };

    if (mode === "apply") {
      const hadIconField = data.icon !== undefined;
      const exportsObj = data.exports !== undefined && typeof data.exports === "object" && data.exports !== null;
      const manifestReachable = !exportsObj || data.exports["./package.json"] !== undefined;
      const hadIconExport = exportsObj && data.exports["./icon"] !== undefined;
      if (hadIconField) {
        console.log("      kept the package\047s own icon field " + JSON.stringify(data.icon));
      } else {
        put("icon", "./icon.svg");
        console.log("      added \"icon\": \"./icon.svg\" to package.json");
      }
      let addedExport = false;
      if (!manifestReachable && !hadIconExport) {
        data.exports["./icon"] = "./icon.svg";
        addedExport = true;
        console.log("      added \"./icon\" export so the manifest is readable");
      }
      fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
      if (!hadIconField || addedExport) {
        state[name] = { slug: process.env.SLUG || name, addedIconField: !hadIconField, addedExport };
        fs.mkdirSync(require("node:path").dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
      }
      process.exit(0);
    }

    const entry = state[name];
    if (entry === undefined) {
      console.log("      no recorded overlay edits; left untouched");
      process.exit(0);
    }
    if (entry.addedIconField && data.icon === "./icon.svg") {
      delete data.icon;
      console.log("      removed \"icon\": \"./icon.svg\"");
    }
    if (entry.addedExport && data.exports !== undefined && data.exports["./icon"] === "./icon.svg") {
      delete data.exports["./icon"];
      console.log("      removed the \"./icon\" export we added");
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    delete state[name];
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  '
}

if [ "$RESTORE" -eq 1 ]; then
  printf 'Removing the green-icon overlay from profile %s\n' "$PROFILE"
else
  printf 'Applying the green-icon overlay to profile %s\n' "$PROFILE"
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
  if [ ! -f "$pkg_dir/package.json" ]; then
    printf '    skipped: %s/package.json is missing\n' "$pkg_dir"
    skipped=$((skipped + 1))
    continue
  fi

  backup=$STATE_DIR/icons/$slug.svg
  mkdir -p "$STATE_DIR/icons"

  if [ "$RESTORE" -eq 1 ]; then
    edit_manifest restore "$pkg_dir/package.json" "$slug"
    if [ -f "$backup" ]; then
      cp "$backup" "$pkg_dir/icon.svg"
      rm -f "$backup"
      printf '    restored the original icon.svg\n'
    elif [ -f "$pkg_dir/icon.svg" ] && cmp -s "$pkg_dir/icon.svg" "$icon"; then
      rm -f "$pkg_dir/icon.svg"
      printf '    removed icon.svg\n'
    else
      printf '    no overlay icon.svg to remove (or it is not ours)\n'
    fi
    changed=$((changed + 1))
    continue
  fi

  if [ ! -f "$icon" ]; then
    printf '    skipped: curated icon %s is missing\n' "$icon"
    skipped=$((skipped + 1))
    continue
  fi
  if [ -f "$pkg_dir/icon.svg" ]; then
    cp "$pkg_dir/icon.svg" "$backup"
  fi
  cp "$icon" "$pkg_dir/icon.svg"
  printf '    copied icon.svg\n'
  edit_manifest apply "$pkg_dir/package.json" "$slug"
  changed=$((changed + 1))
done < "$ICON_TABLE"

if [ "$RESTORE" -eq 1 ] && [ -f "$STATE_FILE" ] && [ "$(tr -d '[:space:]{}' < "$STATE_FILE")" = "" ]; then
  rm -f "$STATE_FILE"
  rmdir "$STATE_DIR/icons" "$STATE_DIR" 2>/dev/null || true
fi

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
