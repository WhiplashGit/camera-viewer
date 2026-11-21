#!/bin/sh
# Stamp a new version so browsers load fresh files and open pages auto-reload.
V=$(date -u +%Y%m%d%H%M%S)
sed -i -E "s/\?v=[0-9A-Za-z_]+/?v=$V/g" index.html history.html
sed -i -E "s/^const APP_VERSION = '[^']*';/const APP_VERSION = '$V';/" app.js
printf '{"v":"%s"}\n' "$V" > version.json
echo "$V"
