#!/usr/bin/env bash
# Export a regression bundle, then verify it with only the built single-file CLI and Node in an
# empty temporary directory (no node_modules, no source tree). Also checks that tampering is caught.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run --silent build:cli
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
node dist/cli/fa.mjs export lost-response-duplicate-charge --policy faulty --faults lost-response --out "$work/faulty.bundle.json" >/dev/null
node dist/cli/fa.mjs export lost-response-duplicate-charge --policy corrected --faults lost-response --out "$work/corrected.bundle.json" >/dev/null
cp dist/cli/fa.mjs "$work/fa.mjs"
cd "$work"
echo "clean directory: $(ls)"
node fa.mjs verify faulty.bundle.json
node fa.mjs verify corrected.bundle.json
# Change one expected assertion outcome without fixing the integrity hash: verify must fail.
node -e '
const fs = require("fs");
const b = JSON.parse(fs.readFileSync("faulty.bundle.json", "utf8"));
b.expected.assertions[0].status = "pass";
fs.writeFileSync("tampered.bundle.json", JSON.stringify(b));
'
if node fa.mjs verify tampered.bundle.json >tampered.out 2>&1; then
  echo "FAIL: tampered bundle verified"; cat tampered.out; exit 1
else
  echo "tampered bundle rejected as expected:"; grep -iE 'integrity|FAIL|mismatch' tampered.out | head -3
fi
echo "clean-environment check passed"
