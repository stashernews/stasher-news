# mkp224o vanity miner — LOCAL USE ONLY (compose profile `onion-miner`).
# Pinned to the v1.7.0 release commit; the build fails if the tag moves
# upstream, so the tag can never silently change what we build.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc AS build
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends \
        build-essential libsodium-dev autoconf automake git ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ARG MKP224O_TAG=v1.7.0
ARG MKP224O_COMMIT=3e7aaf8a3a9cbbed56872afeef88c7a9d538d51a
RUN git clone --depth 1 --branch "$MKP224O_TAG" https://github.com/cathugger/mkp224o /src \
    && cd /src \
    && [ "$(git rev-parse HEAD)" = "$MKP224O_COMMIT" ] \
    && ./autogen.sh \
    && ./configure \
    && make -j"$(nproc)"

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends libsodium23 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/mkp224o /usr/local/bin/mkp224o
WORKDIR /out
ENTRYPOINT ["mkp224o"]
