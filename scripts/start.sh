#!/bin/sh
set -eu
npm run db:migrate
if [ "${BOOTSTRAP_ADMIN:-0}" = "1" ]; then
  npm run user:create
fi
exec node dist/main.js
