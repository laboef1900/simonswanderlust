# G6 — qualify the native file lock on the deployment mount (run by the owner)

The #304/#305 contract makes this a **pre-deployment gate** for the native-lock releases
(#486–#489): the server's real `/data` filesystem must pass the same packaged ownership matrix
(descriptor/inode, CLOEXEC, ordinary child, SIGKILL, PostgreSQL loss, app versus offline
restore) that CI runs on named volumes. `--data-root` makes the harness bind fresh
subdirectories of one disposable directory to `/data`, so the test runs on the real mount.

Nothing here touches production: the harness creates its own containers, database container,
network and directories under a new prefix, refuses a directory inside a live data root, and
never removes or prunes anything it did not create.

## 0. Before you start

- A shell on the server with Docker, `python3`, `git` and `openssl`; about 2 GB free on the data
  filesystem and 2 GB of memory for the test containers. Run it in a quiet period.
- The **exact image you intend to deploy** (`docker image inspect <image>` must work on the
  server) and its full 40-character source commit `<SHA>`. Until a `wanderlust-studio` release
  exists, build it on the Mac for the server's architecture and copy it over:
  ```bash
  docker build --platform linux/<amd64|arm64> -t swl-g6:<SHA> .        # in a checkout at <SHA>
  docker save swl-g6:<SHA> | ssh <server> docker load
  ```

## 1. Find the data mount and check its filesystem

```bash
cd <production deployment directory>        # where production's docker-compose.yml is
DATA=$(realpath uploader/data)               # production's /data bind source
findmnt -T "$DATA"                           # note SOURCE and TARGET
stat -f -c %T "$DATA"                        # ext4 shows as ext2/ext3
```

The harness deliberately qualifies **local ext4 only**. If this is not ext4 (XFS, btrfs, ZFS,
NFS, SMB, FUSE…), stop and send me the two outputs: that filesystem needs its own decision.

## 2. Create the disposable directory on the same filesystem

```bash
Q="$(dirname "$DATA")/g6-qualify-$(date +%Y%m%d)"   # a sibling of uploader/data, NOT inside it
mkdir -m 700 "$Q"
findmnt -T "$Q"                                     # SOURCE/TARGET must equal step 1's
PRIV=$(mktemp -d) && chmod 700 "$PRIV"             # private: env files and raw output
```

## 3. Source checkout and a private PostgreSQL fixture

```bash
git clone -q https://github.com/laboef1900/simonswanderlust.git "$PRIV/src"
git -C "$PRIV/src" checkout -q <SHA>
P=swl_305_package_g6_$(date +%Y%m%d)
PW=$(openssl rand -hex 32)
printf 'POSTGRES_USER=package_owner\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=postgres\n' "$PW" > "$PRIV/postgres.env"
printf 'DATABASE_URL=postgres://package_owner:%s@127.0.0.1:5432/postgres\n' "$PW" > "$PRIV/database.env"
chmod 600 "$PRIV"/*.env; unset PW
docker network create "$P"
docker volume create "${P}_pgdata"
docker run -d --name "${P}_pg" --network "$P" --env-file "$PRIV/postgres.env" \
  --mount "type=volume,src=${P}_pgdata,dst=/var/lib/postgresql" \
  --health-cmd 'pg_isready -U package_owner -d postgres' --health-interval 2s --health-retries 30 \
  postgres:18-alpine
until [ "$(docker inspect -f '{{.State.Health.Status}}' "${P}_pg")" = healthy ]; do sleep 2; done
```

## 4. Run the matrix on the real mount

```bash
python3 "$PRIV/src/.github/native-owner/package-qualify.py" \
  --image <image you will deploy> --source-sha <SHA> --source-root "$PRIV/src" \
  --expected-arch <amd64|arm64> --pg-container "${P}_pg" --database-env "$PRIV/database.env" \
  --output "$PRIV/out" --prefix "$P" --port 34315 --data-root "$Q"
echo "exit: $?"
```

It takes a few minutes and prints one line per step. **Pass** = exit 0 and
`"status": "passed"` in `$PRIV/out/sanitized-evidence/issue-305-packaged-owner-runtime.json`,
whose `package.fsType` is `ef53` and whose `dataRoot.path` is your `$Q`.

## 5. Send me the evidence

Send `$PRIV/out/sanitized-evidence/` (the JSON and the `*.log` files). They are secret-screened
(the database URL and password are redacted); skim them before sending. Never send
`$PRIV/*.env` or anything else from `$PRIV`. I record the result, the mount (`findmnt` line), the
image ID and `<SHA>` in the #304 spec, which lifts the gate for that image on that mount.

## 6. Clean up (only what this run created)

```bash
for c in $(docker ps -a --format '{{.Names}}' | grep "^$P"); do docker rm -f "$c"; done
docker network rm "$P"; docker volume rm "${P}_pgdata"
rm -rf "$Q" "$PRIV"
```

Never run `docker volume prune`/`system prune`, and never remove anything without the `$P`
prefix. On a failure, keep `$Q` and `$PRIV/out` until we have looked at them.
