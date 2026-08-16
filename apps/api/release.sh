#!/bin/sh
# Release: migrate, then serve.
#
# A script rather than a chained CMD so that a failure names itself. The two
# steps fail for entirely different reasons and only one of them is the
# application: when `migrate deploy` cannot reach the database the container
# exits before Fastify ever loads, so the platform reports "deployment failed"
# and the logs show a Prisma stack trace with no indication that a variable is
# missing.

set -e

# ---------------------------------------------------------------------------
# What this container can actually see.
#
# Printed unconditionally, because the alternative is guessing from the
# outside. A dashboard showing a variable and a container receiving one are
# different claims: the variable can be on another service, on another
# environment, defined after the deployment that is running, or set to an
# empty string. This turns all of those into one line of evidence.
#
# NAMES AND STATUS ONLY, never values — logs are retained, forwarded and read
# by people who do not need the credentials.
# ---------------------------------------------------------------------------
echo "release: environment as seen by the container"
for name in \
  NODE_ENV PORT HOST WEB_URL TRUST_PROXY \
  DATABASE_URL DIRECT_URL \
  SUPABASE_URL SUPABASE_JWKS_URL SUPABASE_SECRET_KEY \
  REDIS_URL ENCRYPTION_KEY
do
  # POSIX indirection: ${name} is the variable's NAME, eval reads its value
  # without ever echoing it.
  value=$(eval "printf '%s' \"\${$name-__ABSENT__}\"")
  case "$value" in
    __ABSENT__) status="absent" ;;
    '')         status="present but EMPTY" ;;
    *)          status="set (${#value} chars)" ;;
  esac
  printf '  %-22s %s\n' "$name" "$status"
done

echo "release: node $(node --version), pnpm $(pnpm --version 2>/dev/null || echo 'NOT ON PATH')"
echo "release: $(env | wc -l) variables in the environment"

if [ -z "${DIRECT_URL:-}" ]; then
  echo >&2
  echo "FATAL: DIRECT_URL is not set." >&2
  echo >&2
  echo "  Migrations need it and only migrations need it, which is why the" >&2
  echo "  service's own environment validation does not mention it." >&2
  echo >&2
  echo "  It is the Supabase SESSION pooler, port 5432, with no pgbouncer" >&2
  echo "  parameters — NOT db.<project-ref>.supabase.co, which publishes only" >&2
  echo "  an AAAA record and is unreachable from an IPv4-only network." >&2
  echo >&2
  echo "  If the dashboard shows it set, compare the inventory above: the" >&2
  echo "  variable may be on a different service or environment than the one" >&2
  echo "  running this container, or it may have been added after this" >&2
  echo "  deployment started. Redeploy after adding it." >&2
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
