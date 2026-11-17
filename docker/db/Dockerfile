# https://github.com/JonasProgrammer/docker-postgres-ip4r
FROM postgres:16.16-bookworm

RUN apt-get update \
    && apt-get install --no-install-recommends -y postgresql-16-ip4r \
    && rm -rf /var/lib/apt/lists/*
