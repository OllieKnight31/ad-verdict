#!/bin/bash
# Installs ad-verdict-skill for Claude Code. Safe to run more than once.
# It never overwrites a client config or a token file that already exists.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/skill"
DEST="$HOME/.claude/skills/ad-verdict-skill"
TOKEN_DIR="$HOME/.ad-verdict"
TOKEN_FILE="$TOKEN_DIR/.env"
CONFIG="$DEST/clients/my-account.json"

if [ ! -f "$SRC/SKILL.md" ]; then
  echo "ERROR: cannot find the skill folder next to install.sh (looked in $SRC)." >&2
  echo "Run install.sh from inside the unzipped ad-verdict-skill folder." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. This skill needs Node.js 18 or newer." >&2
  echo "Install it from https://nodejs.org (choose the LTS download), then run install.sh again." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js $(node --version) is too old. This skill needs version 18 or newer." >&2
  echo "Install the LTS version from https://nodejs.org, then run install.sh again." >&2
  exit 1
fi

mkdir -p "$DEST/scripts" "$DEST/clients" "$DEST/fixtures"
cp "$SRC/SKILL.md" "$DEST/SKILL.md"
cp "$SRC"/scripts/*.js "$DEST/scripts/"
cp "$SRC"/fixtures/*.json "$DEST/fixtures/"
cp "$SRC/clients/example.json" "$DEST/clients/example.json"
echo "Skill installed to $DEST"

if [ -e "$CONFIG" ]; then
  echo "Kept your existing config: $CONFIG"
else
  cp "$SRC/clients/example.json" "$CONFIG"
  echo "Created your config from the example: $CONFIG"
fi

mkdir -p "$TOKEN_DIR"
chmod 700 "$TOKEN_DIR"
if [ -e "$TOKEN_FILE" ]; then
  echo "Kept your existing token file: $TOKEN_FILE"
else
  ( umask 077; printf '%s\n' '# Paste your Meta access token after the equals sign. One line, no quotes, no spaces.' 'META_ACCESS_TOKEN=PASTE_YOUR_TOKEN_HERE' > "$TOKEN_FILE" )
  echo "Created an empty token file: $TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

echo
echo "Running the offline self test (invented data, no internet needed)..."
if node "$DEST/scripts/selftest.js"; then
  echo "Self test passed."
else
  echo "ERROR: the self test failed. The skill is installed but may not work. See Troubleshooting in README.md." >&2
  exit 1
fi

cat <<NEXT

Next steps:
  1. Paste your Meta access token into:   $TOKEN_FILE
  2. Put your ad account id and CPL numbers into:   $CONFIG
  3. Check the setup (no network call):
       node "$DEST/scripts/pull-meta-ads.js" --client my-account --check
  4. Restart Claude Code and say:  ad verdict for my-account
To see a demo on invented data first, say:  run the ad verdict demo
NEXT
