#!/usr/bin/env bash
# Build the native Linux binary: dist-linux/ascii-scene
#
#   scripts/build-linux.sh
#
# Needs Rust (https://rustup.rs) and a C linker (gcc or clang). Nothing else at
# build time: the window and GPU libraries are loaded when the program starts.
# To run it, the machine needs a Vulkan driver (Mesa or the vendor's; OpenGL is
# the fallback) and an X11 or Wayland session with libxkbcommon.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
( cd "$root/native" && cargo build --release -p ascii_native )
mkdir -p "$root/dist-linux"
cp "$root/native/target/release/ascii-scene" "$root/dist-linux/ascii-scene"
echo "built $root/dist-linux/ascii-scene"
