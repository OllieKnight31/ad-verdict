#!/bin/bash
# Offline test suite for the giveaway copy. No network, no real token, no real ad account.
# Usage: tests/run-all.sh        (run from anywhere)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/adv-tests.XXXXXX")"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
# check <name> <expected exit code> <text that must appear, or ''> <command...>
check() {
  local name="$1" want="$2" needle="$3"; shift 3
  local out; out="$("$@" 2>&1)"; local code=$?
  if [ "$code" -ne "$want" ]; then bad "$name (exit $code, wanted $want)"; echo "$out" | head -5 | sed 's/^/      /'; return; fi
  if [ -n "$needle" ] && ! echo "$out" | grep -qF -- "$needle"; then bad "$name (output lacks: $needle)"; echo "$out" | head -5 | sed 's/^/      /'; return; fi
  ok "$name"
}

echo "== 1. Syntax =="
for f in "$ROOT"/skill/scripts/*.js "$ROOT"/tests/*.js; do check "node --check $(basename "$f")" 0 '' node --check "$f"; done
check "bash -n install.sh" 0 '' bash -n "$ROOT/install.sh"
for f in "$ROOT"/skill/clients/example.json "$ROOT"/skill/fixtures/demo-account.json; do check "valid JSON $(basename "$f")" 0 '' node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$f"; done

echo "== 2. Fresh install in an empty HOME =="
H="$T/home"; mkdir -p "$H"
S="$H/.claude/skills/ad-verdict-skill"
check "install.sh in empty HOME" 0 'Self test passed.' env HOME="$H" bash "$ROOT/install.sh"
for f in SKILL.md scripts/pull-meta-ads.js scripts/verdict.js scripts/lib.js scripts/selftest.js fixtures/demo-account.json clients/example.json clients/my-account.json; do
  [ -f "$S/$f" ] && ok "installed $f" || bad "installed $f"
done
[ "$(stat -f '%Lp' "$H/.ad-verdict/.env" 2>/dev/null || stat -c '%a' "$H/.ad-verdict/.env")" = "600" ] && ok "token file is private (600)" || bad "token file is private (600)"
P="$S/scripts/pull-meta-ads.js"; V="$S/scripts/verdict.js"

echo "== 3. Help and argument errors =="
check "pull --help" 0 'never changes anything' env HOME="$H" node "$P" --help
check "verdict --help" 0 'never changes an ad account' env HOME="$H" node "$V" --help
check "pull, bad date" 1 'must be a real date' env HOME="$H" node "$P" --client my-account --since 2026-13-40
check "pull, unknown client" 1 'No config found for "nobody"' env HOME="$H" node "$P" --client nobody
check "pull, path trick in client name" 1 'is not valid' env HOME="$H" node "$P" --client ../../etc/passwd
check "pull, option without value" 1 'missing its value' env HOME="$H" node "$P" --client
check "verdict, no dump" 1 'Say which dump' env HOME="$H" node "$V"
check "verdict, missing file" 1 'Dump file not found' env HOME="$H" node "$V" --dump "$T/nope.json"

echo "== 4. Fresh install refuses to run live until it is set up =="
check "placeholder account id refused" 1 'placeholder ad account id' env HOME="$H" node "$P" --client my-account
check "placeholder account id refused with --check" 1 'placeholder ad account id' env HOME="$H" node "$P" --check
node -e 'const f=process.argv[1],fs=require("fs");const j=JSON.parse(fs.readFileSync(f,"utf8"));j.act_id="act_1234567890";fs.writeFileSync(f,JSON.stringify(j,null,2))' "$S/clients/my-account.json"
check "placeholder token refused" 1 'still empty or the placeholder' env HOME="$H" node "$P" --client my-account
printf 'META_ACCESS_TOKEN=fake_token_for_mock_tests\n' > "$H/.ad-verdict/.env"
check "--check passes once set up, no network" 0 'No network call was made.' env HOME="$H" node "$P" --check
if env HOME="$H" node "$P" --check 2>&1 | grep -q fake_token_for_mock_tests; then bad "--check does not print the token"; else ok "--check does not print the token"; fi

echo "== 5. Whole flow on the invented fixture =="
mkdir -p "$T/out"
check "demo pull" 0 'FIXTURE DATA, not a live account' env HOME="$H" node "$P" --demo --outdir "$T/out"
D="$T/out/ad-verdict-example-2026-01-11.json"
check "demo verdict" 0 'SCALE 3 | HOLD 3 | KILL 4' env HOME="$H" node "$V" --dump "$D"
check "demo verdict says analysis only" 0 'Nothing in the ad account was changed.' env HOME="$H" node "$V" --dump "$D"
check "self test from the installed copy" 0 ' 0 failed.' env HOME="$H" node "$S/scripts/selftest.js"

echo "== 6. Live code path with fetch replaced by a local stub (no network) =="
M="$ROOT/tests/mock-fetch.js"; FX="$S/fixtures/demo-account.json"; LOG="$T/requests.log"; mkdir -p "$T/live"
mock() { env HOME="$H" MOCK_FIXTURE="$FX" MOCK_LOG="$LOG" MOCK_FAIL="${MOCK_FAIL:-}" node -r "$M" "$P" "$@"; }
: > "$LOG"
check "live path pull through the stub" 0 'live read, Graph API v26.0' mock --client my-account --since 2026-01-05 --until 2026-01-11 --outdir "$T/live"
LD="$(ls "$T"/live/ad-verdict-my-account-*.json 2>/dev/null | head -1)"
N="$(wc -l < "$LOG" | tr -d ' ')"
[ "$N" -gt 6 ] && ok "stub saw $N requests (paging followed)" || bad "stub saw $N requests (paging followed)"
[ "$(grep -vc '^GET graph.facebook.com/v26.0/' "$LOG")" = "0" ] && ok "every request was a GET to graph.facebook.com/v26.0" || bad "every request was a GET to graph.facebook.com/v26.0"
[ "$(grep -c 'UNEXPECTED' "$LOG")" = "0" ] && ok "every request carried the token from the token file" || bad "every request carried the token from the token file"
if grep -rq fake_token_for_mock_tests "$T/live"; then bad "token is not written to the dump"; else ok "token is not written to the dump"; fi
if mock --client my-account --since 2026-01-05 --until 2026-01-11 --outdir "$T/live" 2>&1 | grep -q fake_token_for_mock_tests; then bad "token is not printed"; else ok "token is not printed"; fi
env HOME="$H" node "$V" --dump "$D" --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(j.campaigns))' > "$T/a.json"
env HOME="$H" node "$V" --dump "$LD" --json | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(j.campaigns))' > "$T/b.json"
cmp -s "$T/a.json" "$T/b.json" && ok "live path and fixture path give identical verdicts" || bad "live path and fixture path give identical verdicts"
MOCK_FAIL=account:190 check "expired token: clear message, exit 1" 1 'invalid or has expired' mock --client my-account --outdir "$T/live"
MOCK_FAIL=campaigns:200 check "missing permission: clear message, exit 1" 1 'needs ads_read' mock --client my-account --outdir "$T/live"
MOCK_FAIL=account:2635 check "retired API version: clear message, exit 1" 1 'api_version' mock --client my-account --outdir "$T/live"
MOCK_FAIL=network:down check "no internet: clear message, exit 1" 1 'could not reach graph.facebook.com' mock --client my-account --outdir "$T/live"
rm -f "$T"/live/*.json
MOCK_FAIL=insights_daily:17 check "rate limit mid pull: exit 2, marked incomplete" 2 'INCOMPLETE' mock --client my-account --since 2026-01-05 --until 2026-01-11 --outdir "$T/live"
LD="$(ls "$T"/live/ad-verdict-my-account-*.json | head -1)"
check "verdict refuses an incomplete dump" 1 'This dump is incomplete' env HOME="$H" node "$V" --dump "$LD"
check "verdict --allow-incomplete warns" 0 'WARNING: the pull was incomplete' env HOME="$H" node "$V" --dump "$LD" --allow-incomplete

echo "== 7. Reinstall never overwrites the user's files =="
BEFORE_C="$(cat "$S/clients/my-account.json")"; BEFORE_T="$(cat "$H/.ad-verdict/.env")"
printf '{"mine":true}\n' > "$S/clients/other-client.json"
check "second install.sh run" 0 'Kept your existing config' env HOME="$H" bash "$ROOT/install.sh"
[ "$(cat "$S/clients/my-account.json")" = "$BEFORE_C" ] && ok "my-account.json unchanged" || bad "my-account.json unchanged"
[ "$(cat "$H/.ad-verdict/.env")" = "$BEFORE_T" ] && ok "token file unchanged" || bad "token file unchanged"
[ "$(cat "$S/clients/other-client.json")" = '{"mine":true}' ] && ok "other client config unchanged" || bad "other client config unchanged"

echo "== 8. Install guards =="
mkdir -p "$T/nonode" "$T/home2"
check "install.sh without Node.js: clear message" 1 'Node.js is not installed' env HOME="$T/home2" PATH="/usr/bin:/bin" bash "$ROOT/install.sh"
[ ! -e "$T/home2/.claude" ] && ok "nothing installed when Node.js is missing" || bad "nothing installed when Node.js is missing"

echo "== 9. Hygiene scan of the giveaway folder =="
scan() { # scan <name> <extended regex> [allowed text to ignore]
  local hits; hits="$(grep -rnE -- "$2" "$ROOT" --include='*' -I 2>/dev/null | grep -v '/tests/run-all.sh:' | grep -vE -- "${3:-@@none@@}" | head -5)"
  if [ -z "$hits" ]; then ok "$1"; else bad "$1"; echo "$hits" | cut -c1-160 | sed 's/^/      /'; fi
}
scan "no personal paths" '/Users/[A-Za-z]'
scan "no em or en dashes" "$(printf '\xe2\x80\x94|\xe2\x80\x93')"
# names to keep out of a copy you share: put them in PRIVATE_TERMS, for example PRIVATE_TERMS='Acme|Jane Doe'
[ -n "${PRIVATE_TERMS:-}" ] && scan "no private names" "$PRIVATE_TERMS"
scan "no access tokens" 'EAA[A-Za-z0-9]{20,}'
scan "no real ad account ids" 'act_[0-9]*[1-9][0-9]*' 'act_1234567890'
scan "no write calls to Meta" "method: *'(POST|DELETE|PUT|PATCH)'|\"(POST|DELETE|PUT|PATCH)\""
scan "no US spellings" '[Aa]nalyz|[Oo]ptimiz|[Nn]ormaliz|[Cc]olor[^a-z]|[Bb]ehavior|[Cc]enter[^a-z]|[Cc]atalog[^u]' 'optimization_goal'

echo
echo "RESULT: $PASS passed, $FAIL failed."
[ "$FAIL" -eq 0 ]
