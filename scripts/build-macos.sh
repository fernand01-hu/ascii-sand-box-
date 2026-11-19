#!/usr/bin/env bash
# Build the native macOS (Apple Silicon) app: dist-macos/ASCII Scene.app
#
#   scripts/build-macos.sh
#
# Needs Rust (https://rustup.rs) and the Xcode command line tools. The app is
# not signed: macOS quarantines apps that arrive through a download. Lift it
# with:
#   xattr -dr com.apple.quarantine "dist-macos/ASCII Scene.app"
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
target=aarch64-apple-darwin
app="$root/dist-macos/ASCII Scene.app"

rustup target add "$target" >/dev/null
( cd "$root/native" && cargo build --release --target "$target" -p ascii_native )

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$root/native/target/$target/release/ascii-scene" "$app/Contents/MacOS/ascii-scene"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ASCII Scene</string>
  <key>CFBundleDisplayName</key><string>ASCII Scene</string>
  <key>CFBundleIdentifier</key><string>local.ascii-scene</string>
  <key>CFBundleExecutable</key><string>ascii-scene</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>STL model</string>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>LSItemContentTypes</key><array><string>public.standard-tesselated-geometry-format</string></array>
      <key>CFBundleTypeExtensions</key><array><string>stl</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
echo "built: $app"
echo "unsigned app: xattr -dr com.apple.quarantine \"$app\"  (then: open \"$app\", or $app/Contents/MacOS/ascii-scene --perf)"
