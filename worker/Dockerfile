# syntax=docker/dockerfile:1

FROM node:22.21.1-bullseye

ENV NODE_ENV=development

ARG UID
ARG GID
RUN groupadd -fg "$GID" apprunner
RUN useradd -om -u "$UID" -g "$GID" apprunner

# pg_dump for the nightly encrypted-backup job (worker/dbBackup.js). Must match
# the db major version (postgres:16) — bullseye's default postgresql-client is
# v13, which aborts against a v16 server with "server version mismatch", so pull
# v16 from the official PGDG apt repo. curl/wget ship in the base image.
RUN curl -sL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt bullseye-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

# Mount point for the `backups` compose volume, owned by the runtime user so the
# nightly backup job (which runs as apprunner) can write dumps to it. A named
# volume copies this ownership into itself on first mount.
RUN mkdir -p /backups && chown apprunner:apprunner /backups

USER apprunner

WORKDIR /app
