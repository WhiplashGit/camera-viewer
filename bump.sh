#!/bin/sh
# Run before every commit that ships a change.
# 1. Add a new entry at the TOP of releases.json (version, title, items) with no "date".
# 2. Run ./bump.sh: it stamps that entry's date, the visible version number,
#    and a cache-busting ?v= on every asset so open pages auto-reload.
set -e
cd "$(dirname "$0")"
R=$(python3 -c '
import json, sys, datetime
r = json.load(open("releases.json"))
top = r[0]
if top.get("date"):
    sys.exit("releases.json: add a new entry at the top (without a date) describing this update first")
top["date"] = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
json.dump(r, open("releases.json", "w"), ensure_ascii=False, indent=2)
open("releases.json", "a").write("\n")
print(top["version"])
')
V=$(date -u +%Y%m%d%H%M%S)
sed -i -E "s/\?v=[0-9A-Za-z_]+/?v=$V/g" index.html history.html help.html
sed -i -E "s/^const APP_VERSION = '[^']*';/const APP_VERSION = '$V';/" app.js
sed -i -E "s/^const APP_RELEASE = '[^']*';/const APP_RELEASE = '$R';/" app.js
printf '{"v":"%s","release":"%s"}\n' "$V" "$R" > version.json
echo "v$R ($V)"
