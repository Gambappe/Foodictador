#!/bin/sh
# Relay entrypoint: make the snapshot directory writable, then drop root.
#
# WHY THIS EXISTS — the fly.io volume. A freshly created fly volume is an empty ext4
# filesystem mounted at `destination` and owned by root, and the mount replaces whatever
# ownership the image had at that path. The relay runs as `node`, so without this the very
# first mutation fails EACCES on /data/relay.json — and because a failed snapshot write is
# a failed mutation (P0.8, deliberately), every confession would 5xx while `fly status`
# showed a healthy machine.
#
# The docker-compose path does not need it: Docker seeds a fresh named volume from the
# image's directory, ownership included. Doing it here covers both without a second image.
#
# Root only long enough to chown, then busybox `su` replaces this shell with the relay
# running as `node`. Both are execs, so the relay is still PID 1 and `fly machine stop` /
# `docker stop` deliver SIGTERM straight to it (main.ts closes on it). Deliberately busybox
# rather than su-exec or gosu: those need `apk add`, which turns every image build into a
# network call to the alpine CDN, and this image is built on demo-setup day.
set -eu

dump_path="${RELAY_DUMP_PATH:-/var/lib/confit/relay.json}"
dump_dir=$(dirname "$dump_path")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$dump_dir"
  # Only the directory and an existing snapshot — not a recursive chown of a mount that
  # may hold a quarantined .corrupt-* file worth keeping readable as-is.
  chown node:node "$dump_dir"
  if [ -e "$dump_path" ]; then
    chown node:node "$dump_path"
  fi
  # `sh` is ARG0 for the -c shell, so "$@" inside it is exactly this script's arguments
  # (the image CMD) and nothing is re-split or re-quoted.
  exec su node -s /bin/sh -c 'exec "$@"' sh "$@"
fi

# Already unprivileged (e.g. `docker run --user`): nothing to fix, nothing to drop.
exec "$@"
