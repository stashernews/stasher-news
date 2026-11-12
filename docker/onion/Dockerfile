# Tor ingress sidecar for the onion mirror. Keys live only in the
# onion_tordata volume; keys must be staged BEFORE first start (an empty
# HiddenServiceDir makes tor mint a random address).
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends tor curl ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*
# uid/gid 1000 matches the legacy docker/tor convention
RUN groupadd -g 1000 tord && useradd -u 1000 -g 1000 -m tord \
    && mkdir -p /tordata && chown -R tord:tord /tordata
COPY torrc /etc/tor/torrc
USER tord
VOLUME ["/tordata"]
CMD ["tor", "-f", "/etc/tor/torrc"]
