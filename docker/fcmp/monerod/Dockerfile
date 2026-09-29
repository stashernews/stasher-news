# ubuntu:24.04 runtime: the official binaries are built on a modern toolchain;
# bookworm's glibc 2.36 may be older than what they require.
FROM ubuntu:24.04
ARG FCMP_VERSION=v0.19.0.0-beta.3.0
ARG FCMP_ASSET=linux_x64_beta-v3.0.zip
# Digest from the GitHub releases API (asset linux_x64_beta-v3.0.zip):
#   curl -s https://api.github.com/repos/seraphis-migration/monero/releases/tags/$FCMP_VERSION \
#     | jq -r '.assets[] | select(.name=="linux_x64_beta-v3.0.zip") | .digest'
ARG FCMP_SHA256=efb20d5abaf1a64043c06a35927aadd0994a08f459e44481c94a010c786768fb
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip bzip2 \
 && rm -rf /var/lib/apt/lists/*
# The release zip wraps a guix build tree whose payload is a nested
# monero-<arch>-<commit>.tar.bz2; extract zip → tarball → find the binaries
# (robust to the tarball's internal directory layout).
RUN curl -fsSL -o /tmp/monero.zip \
      "https://github.com/seraphis-migration/monero/releases/download/${FCMP_VERSION}/${FCMP_ASSET}" \
 && echo "${FCMP_SHA256}  /tmp/monero.zip" | sha256sum -c - \
 && unzip -j /tmp/monero.zip '*monero-*.tar.bz2' -d /tmp \
 && mkdir -p /tmp/mx /opt/monero && tar -xjf /tmp/monero-*.tar.bz2 -C /tmp/mx \
 && find /tmp/mx -type f -name monerod -exec mv {} /opt/monero/monerod \; \
 && find /tmp/mx -type f -name monero-wallet-cli -exec mv {} /opt/monero/monero-wallet-cli \; \
 && rm -rf /tmp/monero.zip /tmp/monero-*.tar.bz2 /tmp/mx && chmod +x /opt/monero/*
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
