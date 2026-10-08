# madebytimo/monerod v0.1.2-2026.10.07 bundles the official GPG-verified
# monerod v0.18.5.3 'Fluorine Fermi' linux-x64 binary (release tarball SHA256
# 3333d0e04c9cbe3023e7e2b6dd369c407f36bb8df5b05fb0a19d7685b3d56dfc).
# Verify in a built image: /opt/monero/monerod --version
# Tag scheme is the image's own version + build date, NOT the monero version —
# bump deliberately and re-check --version whenever this tag changes.
FROM madebytimo/monerod:v0.1.2-2026.10.07

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
