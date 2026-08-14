# syntax=docker/dockerfile:1

FROM node:22.21.1-bullseye

ENV NODE_ENV=development

ARG UID
ARG GID
RUN groupadd -fg "$GID" apprunner
RUN useradd -om -u "$UID" -g "$GID" apprunner

WORKDIR /app

# pg_dump/psql for scripts/deploy-migrate.sh (pre-migration snapshot + rollback)
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --loglevel verbose

USER apprunner

# node_modules is bind-mounted from the host in local dev, shared by app and
# worker. npm ci deletes and reinstalls the whole tree, so it only runs when
# node_modules is missing/incomplete or package-lock.json changed since the
# last install (stamped in .npm-installed-stamp). An unconditional reinstall
# on every start wipes the shared tree mid-flight and can kill the worker
# container (observed: Cannot find module tsx/dist/preflight.cjs, all pg-boss
# jobs dead until a manual worker restart).
# migrate deploy is non-interactive (migrate dev prompts on drift and hangs in a
# non-tty container); run migrate dev manually via `./sndev prisma migrate dev`
CMD ["sh","-c","set -e\nlockhash=$(md5sum package-lock.json | cut -d' ' -f1)\nif [ -f .npm-installed-stamp ] && [ \"$(cat .npm-installed-stamp)\" = \"$lockhash\" ] && [ -f node_modules/.package-lock.json ]; then\n  echo 'node_modules up to date (lockfile unchanged), skipping npm ci'\nelse\n  npm ci --legacy-peer-deps --loglevel verbose\n  printf '%s\\n' \"$lockhash\" > .npm-installed-stamp\nfi\nnpx prisma migrate deploy && npm run dev"]
