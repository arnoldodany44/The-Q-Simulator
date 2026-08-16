# The worker image.
#
# Almost the API's Dockerfile, and the differences are the interesting part.
# Read apps/api/Dockerfile first: the argument for a Dockerfile over Nixpacks,
# for the repository root as the build context, and for copying every workspace
# manifest before `pnpm install` is written out in full there and is identical
# here.
#
# What differs:
#
#   1. There is no PORT and no EXPOSE. This process listens on nothing. It
#      dials out to Redis and to Postgres and that is all — which also means a
#      platform healthcheck cannot be an HTTP probe, so railway.json here has
#      none and liveness is the process staying up.
#
#   2. There is no release script and no migration. Two services running
#      `prisma migrate deploy` against one database is two services racing for
#      the same advisory lock on every deploy; the API owns migrations because
#      it is the one that must not serve traffic against an unmigrated schema.
#      This process starts straight into `node dist/worker.js` and will fail
#      loudly on a column that is not there yet.
#
#   3. The build must emit TWO files. `dist/worker.js` is what starts, and
#      `dist/simulate.child.js` is what it forks per simulation — see
#      apps/worker/build.js, which fails the build if the second is missing,
#      because a worker without it starts happily and fails every job.
#
# The configuration beside this file is apps/worker/railway.json, and Railway
# only looks there if the service's "Config file path" is set to it: the
# repository root's railway.json is the API's, and a second service left on the
# default would build the API image under the worker's name.

FROM node:24-slim

# Prisma's engines link against OpenSSL and node:*-slim does not ship it.
# Without this, `prisma generate` succeeds and the first query fails at runtime
# with a message about a missing shared library.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# corepack reads `packageManager` from package.json, so the version here is
# whatever the repository pins rather than whatever is newest today.
COPY package.json ./
RUN corepack enable && corepack prepare --activate

# The manifests first, so a change to source does not invalidate the install
# layer. Every workspace package needs its package.json present before
# `pnpm install`, because the lockfile is resolved against all of them at once.
COPY pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
# Directory names, not package names: @qsim/core lives in packages/qsim.
COPY packages/config/package.json packages/config/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/jobs/package.json packages/jobs/
COPY packages/qasm/package.json packages/qasm/
COPY packages/qsim/package.json packages/qsim/
COPY packages/schema/package.json packages/schema/

# The Prisma schema has to exist before install: @qsim/db generates its client
# in a postinstall script, and a postinstall that cannot find its schema fails
# the whole install. prisma.config.ts sits beside prisma/ rather than inside it
# and is what tells the CLI where the schema and the migrations are.
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma/

RUN pnpm install --frozen-lockfile

COPY . .

# Filtered, so the image does not build the web client or the API it will never
# run. Turbo pulls in the worker's workspace dependencies on its own.
RUN pnpm turbo build --filter=worker

ENV NODE_ENV=production

# No shell wrapper: there is nothing to do before starting, and `exec`-ing node
# directly makes it PID 1, which is what receives the platform's SIGTERM. A
# shell in between would swallow it and every redeploy would be a SIGKILL —
# skipping the shutdown that kills this process's forked children, which the OS
# would then leave running.
CMD ["node", "apps/worker/dist/worker.js"]
