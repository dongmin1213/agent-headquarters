#!/bin/sh
# Test stand-in for sandbox-exec when tests already run inside a sandbox (macOS refuses nesting).
# Expects `-f <profile> <cmd...>`, ignores the profile and runs the command unconfined.
[ "$1" = "-f" ] || exit 64
shift 2
exec "$@"
