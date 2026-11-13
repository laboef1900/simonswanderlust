#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${PRIVATE_ROOT:?}" "${FIXTURE_PREFIX:?}" "${CANDIDATE:?}" "${ARCH:?}" "${SOURCE_SHA:?}"
python3 - <<'PY'
import os, secrets
from pathlib import Path
root = Path(os.environ['PRIVATE_ROOT'])
password = secrets.token_hex(32)
print('::add-mask::' + password)
files = {
    'postgres.env': 'POSTGRES_USER=package_owner\nPOSTGRES_PASSWORD=' + password + '\nPOSTGRES_DB=postgres\n',
    'database.env': 'DATABASE_URL=postgres://package_owner:' + password + '@127.0.0.1:5432/postgres\n',
}
for name, content in files.items():
    with (root / name).open('x') as file:
        file.write(content)
    (root / name).chmod(0o600)
PY
docker network create "$FIXTURE_PREFIX"
if docker volume inspect "${FIXTURE_PREFIX}_pgdata" >/dev/null 2>&1; then
  echo 'Refusing an existing fixture volume' >&2
  exit 1
fi
docker volume create "${FIXTURE_PREFIX}_pgdata"
docker run -d --name "${FIXTURE_PREFIX}_pg" --network "$FIXTURE_PREFIX" \
  --platform="linux/$ARCH" --env-file "$PRIVATE_ROOT/postgres.env" \
  --mount "type=volume,src=${FIXTURE_PREFIX}_pgdata,dst=/var/lib/postgresql" \
  --health-cmd 'pg_isready -U package_owner -d postgres' \
  --health-interval 2s --health-timeout 5s --health-retries 30 postgres:18-alpine
healthy=false
for _ in {1..60}; do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "${FIXTURE_PREFIX}_pg")" = healthy ]; then
    healthy=true
    break
  fi
  sleep 2
done
if [ "$healthy" != true ]; then
  echo 'Private PostgreSQL fixture did not become healthy' >&2
  exit 1
fi
python3 .github/native-owner/package-qualify.py \
  --image "$CANDIDATE" --source-sha "$SOURCE_SHA" --source-root "$GITHUB_WORKSPACE" \
  --expected-arch "$ARCH" --pg-container "${FIXTURE_PREFIX}_pg" \
  --database-env "$PRIVATE_ROOT/database.env" --output "$PRIVATE_ROOT/output" \
  --prefix "$FIXTURE_PREFIX" --port 34315
mkdir -m 700 "$PRIVATE_ROOT/bind-root"
python3 .github/native-owner/package-qualify.py \
  --image "$CANDIDATE" --source-sha "$SOURCE_SHA" --source-root "$GITHUB_WORKSPACE" \
  --expected-arch "$ARCH" --pg-container "${FIXTURE_PREFIX}_pg" \
  --database-env "$PRIVATE_ROOT/database.env" --output "$PRIVATE_ROOT/output-bind" \
  --prefix "${FIXTURE_PREFIX}_b" --port 34316 --data-root "$PRIVATE_ROOT/bind-root"
node uploader/scripts/check-image-legal.mjs "$CANDIDATE" --platform "linux/$ARCH" --revision "$SOURCE_SHA"
