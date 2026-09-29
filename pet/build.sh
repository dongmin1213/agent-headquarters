#!/bin/sh
# Builds HQPet.app (menu-bar only, no Dock icon). Sprite packs are copied into the bundle.
set -e
cd "$(dirname "$0")"
swiftc -O -swift-version 6 main.swift -o hqpet
rm -rf HQPet.app && mkdir -p HQPet.app/Contents/MacOS HQPet.app/Contents/Resources
mv hqpet HQPet.app/Contents/MacOS/hqpet
[ -d packs ] && cp -R packs HQPet.app/Contents/Resources/packs || echo "packs/ 없음: scripts/fetch-packs.sh 실행 전에는 기본 아이콘으로 표시"
cat > HQPet.app/Contents/Info.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.hq.pet</string>
  <key>CFBundleName</key><string>HQPet</string>
  <key>CFBundleExecutable</key><string>hqpet</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
echo "built $(pwd)/HQPet.app"
