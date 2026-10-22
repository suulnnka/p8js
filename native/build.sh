#!/usr/bin/env bash
# Build z8lua (liblua.a + z8lua interpreter) and p8luac inside WSL.
# Sources come from the z8lua submodule (tracked, already carrying the
# fake-08 compatibility edits); copied into native/build/ (gitignored) so
# the in-tree make never dirties the submodule working tree.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../z8lua"
bld="$here/build"
zbld="$bld/z8lua"

if [ ! -f "$src/makefile" ] || [ ! -f "$src/lparser.c" ]; then
    echo "build.sh: $src missing — init the submodule: git submodule update --init" >&2
    exit 1
fi

rm -rf "$zbld"
mkdir -p "$zbld"
cp "$src"/*.c "$src"/*.h "$src"/makefile "$src"/trigtables.h "$zbld"/ 2>/dev/null || true

cd "$zbld"

# liblua.a + z8lua interpreter. readline headers are present; history lives in
# libreadline on modern Ubuntu, so link -lreadline -ldl explicitly (the
# makefile's default -lhistory/-ldl mix is unreliable across distros).
make -j"$(nproc)" all MYLIBS="-lreadline -ldl"

# luac-style driver: stdin/file -> bytecode file/stdout
g++ -std=c++17 -O2 -Wall -I. "$here/p8luac.c" "$zbld/liblua.a" -o "$bld/p8luac" -lm

echo "build.sh: ok"
echo "  $bld/p8luac"
echo "  $zbld/z8lua"
