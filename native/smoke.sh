#!/usr/bin/env bash
# Phase 0 acceptance: compile the dialect fixture, check the dump header,
# execute the dump with the z8lua interpreter, and exercise the error path.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
b="$here/build"
f="$here/../tests/fixtures/sample.lua"

"$b/p8luac" "$f" /tmp/p8js-sample.bc
echo '--- header (32 bytes) ---'
od -An -tx1 -N32 /tmp/p8js-sample.bc
echo '--- dump size ---'
wc -c < /tmp/p8js-sample.bc
echo '--- run dump with z8lua interpreter ---'
"$b/z8lua/z8lua" /tmp/p8js-sample.bc && echo RUN-OK
echo '--- compile error path ---'
printf 'x=\n' > /tmp/p8js-bad.lua
if "$b/p8luac" /tmp/p8js-bad.lua /dev/null; then
    echo UNEXPECTED-OK
    exit 1
else
    echo ERR-CAPTURED
fi
echo 'smoke: ok'
