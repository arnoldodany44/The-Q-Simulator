# The API image.
#
# A Dockerfile rather than Nixpacks, and the reason is worth writing down: this
# is a pnpm workspace pinned to a specific package manager and a Node floor
# (>=22.12, developed on 24). Nixpacks infers both, and when its inference and
# the repository disagree the build fails somewhere inside an install with an
# error about a package that does not exist on npm — because the workspace
# protocol was never resolved. Pinning them here removes the whole class.
#
# Build context is the REPOSITORY ROOT, not apps/api. A workspace package
# cannot be installed from inside its own directory: pnpm needs
# pnpm-workspace.yaml, the lockfile and every sibling package the API imports
# (@qsim/core, @qsim/schema, @qsim/db, @qsim/contract). railway.json points at
# this file while leaving the root directory unset for exactly that reason.

FROM node:24-slim

# Prisma's engines link against OpenSSL, and node:*-slim does not ship it.
# Without this, `prisma generate` succeeds and the first query fails at
# runtime with a message about a missing shared library — a failure that
# survives the build and only appears once real traffic arrives.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# corepack reads `packageManager` from package.json, so the version here is
# whatever the repository pins rather than whatever is newest today.
COPY package.json ./
RUN corepack enable && corepack prepare --activate

# The manifests first, so a change to source code does not invalidate the
# install layer. Every workspace package needs its package.json present before
# `pnpm install`, because the lockfile is resolved against all of them at once.
COPY pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Directory names, not package names: @qsim/core lives in packages/qsim.
COPY packages/config/package.json packages/config/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/qasm/package.json packages/qasm/
COPY packages/qsim/package.json packages/qsim/
COPY packages/schema/package.json packages/schema/

# The Prisma schema has to exist before install: @qsim/db generates its client
# in a postinstall script, and a postinstall that cannot find its schema fails
# the whole install.
#
# prisma.config.ts is copied separately because it sits BESIDE prisma/ rather
# than inside it, and it is what tells the CLI where the schema and the
# migrations are. Copying only the directory leaves `prisma generate` with no
# config, which fails the install with an error about a missing schema while
# the schema is sitting right there.
COPY packages/db/prisma.config.ts packages/db/
COPY packages/db/prisma packages/db/prisma/

RUN pnpm install --frozen-lockfile

COPY . .

# Filtered, so the image does not build the web client it will never serve.
# Turbo pulls in the API's workspace dependencies on its own.
RUN pnpm turbo build --filter=api

ENV NODE_ENV=production
ENV HOST=0.0.0.0

# PORT is injected by the platform and deliberately not set here: a hardcoded
# port is the usual reason a healthcheck fails while the service is perfectly
# healthy on a different one.
EXPOSE 8080

# Migrations run on release rather than at build time, because the build has no
# database. release.sh explains the ordering and checks DIRECT_URL first, so a
# missing variable names itself instead of surfacing as a Prisma stack trace
# from a container that died before the server loaded.
#
# chmod here rather than relying on the checked-in mode: git on Windows does
# not preserve the executable bit, so the file arrives without it.
RUN chmod +x apps/api/release.sh
CMD ["./apps/api/release.sh"]
