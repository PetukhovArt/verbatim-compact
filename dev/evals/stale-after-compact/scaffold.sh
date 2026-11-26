#!/usr/bin/env bash
set -euo pipefail
case_dir="$(dirname "$0")"
mkdir -p fixtures src docs patches
cp "$case_dir"/../resume-keeps-compaction/fixtures/part-*.txt fixtures/
cp "$case_dir"/fixtures/src/pricing.ts src/
cp "$case_dir"/fixtures/docs/release-notes.md docs/
cp "$case_dir"/fixtures/patches/teammate.md patches/
