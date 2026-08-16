#!/bin/sh
# Release: migrate, then serve.
#
# A script rather than a chained CMD so that a failure names itself. The two
# steps fail for entirely different reasons and only one of them is the
# application: when `migrate deploy` cannot reach the database the container
# exits before Fastify ever loads, so the platform reports "deployment failed"
# and the logs show a Prisma stack trace with no indication that a variable is
# missing.
#
# DIRECT_URL is the specific trap. apps/api validates its own environment at
# boot with Zod and refuses to start while naming what is wrong — but
# DIRECT_URL is not in that schema, because the server never uses it. Only the
# migration does, through packages/db/prisma.config.ts. So it is the one
# variable that can be absent with nothing checking for it until Prisma fails
# on a datasource it was never given.

set -e

if [ -z "${DIRECT_URL:-}" ]; then
  echo "FATAL: DIRECT_URL is not set." >&2
  echo >&2
  echo "  Migrations need it and only migrations need it, which is why the" >&2
  echo "  service's own environment validation does not mention it." >&2
  echo >&2
  echo "  It is the Supabase SESSION pooler, port 5432, with no pgbouncer" >&2
  echo "  parameters — NOT db.<project-ref>.supabase.co, which publishes only" >&2
  echo "  an AAAA record and is unreachable from an IPv4-only network." >&2
  echo >&2
  echo "  See docs/despliegue-railway.md." >&2
  exit 1
fi

echo "release: applying migrations"
# Only rolls forward; never resets. Safe to run on every start, including a
# restart, and it takes an advisory lock so two containers starting together
# cannot race each other.
pnpm --filter @qsim/db exec prisma migrate deploy

echo "release: starting the server"
exec node apps/api/dist/server.js
