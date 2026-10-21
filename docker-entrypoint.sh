#!/bin/sh
set -eu
umask 077

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R node:node /data
  exec gosu node "$@"
fi

exec "$@"
