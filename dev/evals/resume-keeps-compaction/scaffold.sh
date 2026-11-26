#!/usr/bin/env bash
set -euo pipefail
mkdir -p fixtures
cp "$(dirname "$0")"/fixtures/part-*.txt fixtures/
