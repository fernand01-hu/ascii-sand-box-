#!/usr/bin/env bash
# Development loop for the infinite world: runs the app with a frame trace and
# relaunches it in place (same seed, camera, walking) whenever its binary is
# rebuilt. Closing the window ends the loop.
#
#   scripts/dev-loop.sh [app options]        # e.g. --day
#   (cd native && cargo build --profile profiling)   # elsewhere: triggers a relaunch
#
# Writes to dev-run/: trace.jsonl (one line per second and per slow frame,
# see native/app/src/trace.rs), pose.txt (where you are), app.log. Reads
# dev-run/tune.txt live (key = value: autowalk, fade, underpaint).
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="$root/native/target/profiling/ascii-scene"
run="${ASCII_DEV_DIR:-$root/dev-run}"
mkdir -p "$run"
export ASCII_TRACE="$run/trace.jsonl" ASCII_POSE="$run/pose.txt" ASCII_TUNE="$run/tune.txt" ASCII_PERF=1

stamp() { stat -f %m "$bin" 2>/dev/null || stat -c %Y "$bin"; }

[ -x "$bin" ] || (cd "$root/native" && cargo build --profile profiling -p ascii_native)
while true; do
  before="$(stamp)"
  echo "[dev-loop] start $(date +%T)" | tee -a "$run/app.log"
  "$bin" --world "$@" >>"$run/app.log" 2>&1 &
  pid=$!
  rebuilt=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 0.5
    if [ "$(stamp)" != "$before" ]; then
      sleep 1 # let the build finish writing
      rebuilt=1
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      break
    fi
  done
  if [ "$rebuilt" = 0 ]; then
    echo "[dev-loop] window closed, stopping" | tee -a "$run/app.log"
    exit 0
  fi
  echo "[dev-loop] new build, relaunching in place" | tee -a "$run/app.log"
done
