#!/usr/bin/env bash
# Fresh development account storage, immutable public catalogues, loopback only.
# Never read .env or inherit production/authentication configuration.
set -euo pipefail
if [ "$#" -ne 0 ]; then echo 'Usage: bash scripts/nutrition-local-catalog/start-reference-dev.sh' >&2; exit 2; fi
REPOSITORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$REPOSITORY"
NODE22=/home/codex/.local/opt/node22/bin/node
test -x "$NODE22"
"$NODE22" -e 'if(process.versions.node.split(".")[0]!=="22")process.exit(1)'
python3 - <<'PY'
import os,pathlib
p=pathlib.Path('scripts/nutrition-local-catalog/artifacts')
d=os.statvfs(p);m=int(next(x.split()[1]for x in pathlib.Path('/proc/meminfo').read_text().splitlines()if x.startswith('MemAvailable:')))*1024
if d.f_bavail*d.f_frsize<21*1024**3 or m<2.5*1024**3:raise SystemExit('Insufficient development headroom (21 GiB disk / 2.5 GiB RAM required).')
for name in ('wger-full-registered-20261025','wger-fr-quality-20261026','off-reference-full2-20261026','wger-off-search-20261026'):
 if not(p/name/'current.json').is_file():raise SystemExit('Missing immutable generation: '+name)
PY
mkdir -p scripts/nutrition-local-catalog/runtime
DEV_REFERENCE_DATA=$(mktemp -d "$REPOSITORY/scripts/nutrition-local-catalog/runtime/ref-api.XXXXXX")
printf 'Isolated development DATA_DIR: %s\nWait for "gym-api on :3301" before opening Vite.\n' "$DEV_REFERENCE_DATA"
exec env -i PATH=/home/codex/.local/opt/node22/bin:/usr/bin:/bin \
 NODE_ENV=development PORT=3301 DATA_DIR="$DEV_REFERENCE_DATA" ORIGIN=http://localhost:5175 \
 NUTRITION_LOCAL_CATALOG=1 NUTRITION_LOCAL_CATALOG_KIND=wger-v1 \
 NUTRITION_LOCAL_CATALOG_WORKSPACE=wger-full-registered-20261025 \
 NUTRITION_LOCAL_CATALOG_COMPLEMENT=wger-fr-quality-20261026 \
 NUTRITION_LOCAL_CATALOG_REFERENCE=off-reference-full2-20261026 \
 NUTRITION_LOCAL_CATALOG_REFERENCE_INDEX=wger-off-search-20261026 \
 "$NODE22" api/server.js
