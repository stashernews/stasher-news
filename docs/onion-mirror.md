# Stasher News onion mirror — operations runbook

The clearnet site is mirrored as a Tor onion service with a vanity address
beginning `stasher`. This runbook covers mining the address, importing the key,
the one-time key-day deploy, backup/replacement, and the verification checklist.
It is a deployment checklist, not authorization to run production commands.

## 1. Overview

```
Tor Browser ── onion circuit ──▶ onion-tor (HiddenServicePort 80)
                                   └▶ caddy :8081 (plain HTTP, internal only)
                                        └▶ app:3000 (Host preserved)
```

- `onion-tor` (`docker/onion/`) is a tor **ingress sidecar only** — no relay,
  no exit, no control port, no published host ports. It runs with
  `network_mode: "service:caddy"`, so `127.0.0.1:8081` inside its namespace is
  Caddy's host-agnostic onion listener; `HiddenServicePort 80 127.0.0.1:8081`
  targets it. Caddy stays the only ingress: the `:8081` block imports the same
  `(ingress)` snippet as the clearnet site (admin 404s, `/uploads` →
  SeaweedFS, webhook 404, maintenance page, app proxy), so the two paths cannot
  drift.
- The mirror protects **readers** (privacy, censorship resistance), not the
  server: the VPS IP is already public through clearnet DNS.
- **Plain HTTP is deliberate.** The onion circuit is end-to-end encrypted and
  authenticated by the address itself; HTTP over the authenticated onion circuit
  is the deliberate choice — TLS there could only mean a self-signed certificate
  that browsers distrust, no added protection over the circuit. Tor Browser treats
  `*.onion` as a trustworthy origin (secure context),
  so `Secure` cookies, `crypto.subtle`, and session login work unchanged. HSTS
  on an HTTP onion response is ignored per RFC 6797 — harmless. The app is told
  `X-Forwarded-Proto: http`, truthfully. Phrase and nostr logins stay on the
  mirror: next-auth resolves callbacks against `NEXTAUTH_URL` (clearnet), so
  the auth redirect callback allowlists the exact mirror origin (`ONION_HOST`,
  which the overlay passes to the `app` service), and login forms hand it an
  absolute mirror-origin callback when browsed on `.onion`. Email magic-code
  logins also stay on the mirror: next-auth builds every auth redirect (the
  post-send check-your-email hop, the CSRF/error bounces, the post-login
  callback) from `NEXTAUTH_URL`, so the auth API boundary rewrites those
  redirects to the mirror origin for requests that verifiably arrived on it
  (`mirrorAuthRedirectRes` in `lib/safe-url.js` — only the canonical origin is
  ever rewritten) — the code form stays enabled and the session cookie is
  minted on the mirror origin. Login emails contain a code, not a login link.
  OAuth logins still complete on clearnet (their callback URLs are registered
  against clearnet). Login of any
  kind requires a client that treats `.onion` as trustworthy (Tor Browser
  does): a spec-strict client cannot satisfy the `Secure`-attributed CSRF
  cookie over plain HTTP. Rehearsal covers phrase, nostr, and email-code
  logins.
- Accepted trade-offs (same as BBC/NYT mirrors): share links, canonical/`og:url`,
  RSS links, push targets and email digests point at clearnet because they are
  generated from `NEXT_PUBLIC_URL`; media assets load from the clearnet media
  hosts over HTTPS (CSP already allows `https:`). Link generation is out of
  scope.

## 2. Mining the vanity address (workstation only)

Run this on the operator's workstation. **Never on the VPS** — it is CPU-bound
and the VPS is the production box.

```bash
cd /path/to/stasher.news
mkdir -p ./.onion-keys   # gitignored output dir, bind-mounted to /out
# ONION_HOST=unused.invalid satisfies the overlay's required-variable gate:
# no address exists yet (mining is what produces it), the miner service never
# receives the value, and `run` starts nothing but the miner
ONION_HOST=unused.invalid CURRENT_UID=$(id -u) CURRENT_GID=$(id -g) \
  docker compose --env-file .env.development \
  -f docker-compose.yml -f docker-compose.onion.yml \
  --profile onion-miner --profile domains-caddy \
  run --rm onion-miner -n 1 -d /out stasher
```

- `--profile onion-miner` activates the miner; `--profile domains-caddy` is
  needed because the base `caddy` service is profile-gated and the overlay
  extends it (the miner itself has no dependencies).
- `-n 1 -d /out stasher` = stop after the **first** match, write it to `/out`
  (the bind-mounted `.onion-keys/`), filtering on the `stasher` prefix.
- The filter alphabet is **base32**: `a`–`z` and `2`–`7` only. `0`, `1`, `8`
  and `9` can never appear in an onion address, so a filter containing them
  would never match.
- Expected time: 7 chars ≈ 2^35 ≈ **34 billion candidates**; mkp224o does
  roughly 1–3M keys/s per core, so **tens of minutes to a couple of hours
  depending on core count** (~1.2 h on 8 cores, ~20 min on 32 threads at
  1–3M keys/s/core; CPU-bound — a GPU does not help).
- Capping load: `docker compose run` has no `--cpus` flag. Use a throwaway
  override (never edit the committed files):

  ```bash
  cat > /tmp/onion-miner-cpus.yml <<'EOF'
  services:
    onion-miner:
      cpus: "2.0"
  EOF
  # add `-f /tmp/onion-miner-cpus.yml` to the run command above
  ```

  (Equivalent: `docker run --rm --cpus 2.0 --user "$(id -u):$(id -g)"
  -v "$PWD/.onion-keys:/out" stashernews-onion-miner -n 1 -d /out stasher` —
  the `--user` keeps the mined key files owned by you, not root.)
- Run it in `tmux`/`screen` (hours). On a non-interactive shell add `-T` to
  `docker compose run`. The image is built from a pinned mkp224o commit; the
  build fails if the tag moves upstream.
- **Never use `--profile '*'` with the onion overlay on the VPS.** The wildcard
  activates the miner there. The profile gate exists precisely so a normal
  `up` can never start it.
- Output is `.onion-keys/<56-char-base32>.onion/` containing `hostname`,
  `hs_ed25519_secret_key`, `hs_ed25519_public_key`. The directory name **is**
  the address. `.onion-keys/` must never be committed.

## 3. Import + verify into the tor volume

`scripts/onion-import-key.sh` takes a validated find and stages it into the
`stashernews_onion_tordata` volume:

```bash
# the volume must exist first (the script does not create it; create is idempotent)
docker volume create stashernews_onion_tordata
./scripts/onion-import-key.sh .onion-keys/<address>.onion
```

What it guarantees, in order:

1. **Validates the find** — the directory basename is exactly 56 base32 chars
   + `.onion`, all three files are present, and the `hostname` file agrees with
   the directory name.
2. **Re-derives the address and public key from the secret key alone** — it
   runs the pinned `stashernews-onion-tor` image once with *only*
   `hs_ed25519_secret_key` (no public key, no hostname file) and
   `HiddenServicePort 80 127.0.0.1:9`, then requires tor's derived hostname to
   equal the find **and** tor's regenerated `hs_ed25519_public_key` to match the
   candidate's (`cmp -s`). A hostname or public key that does not belong to the
   secret key — including a stale or corrupted public key file — is rejected
   here, before the key is ever staged for a deploy. (`HiddenServicePort` is
   re-specified on the CLI because CLI options replace the torrc
   `HiddenService*` lines.)
3. **Refuses a non-empty volume `hs/` dir** — it will not overwrite an existing
   identity, including a random address tor minted on an accidental early
   start. Clearing is deliberate only (section 6).
4. **Stages with production permissions** — `hostname`,
   `hs_ed25519_secret_key`, `hs_ed25519_public_key` into
   `/tordata/hs/` (0700 dir, 0600 files, owner `1000:1000` — the image's `tord`
   user), plus the `data/` dir.

The image must be built first:
`docker compose ... -f docker-compose.onion.yml build onion-tor`.

**Keys-first rule:** tor mints a *random* identity if `HiddenServiceDir` is
empty at first start. The volume must be staged **before** the sidecar's first
`up`; the overlay must not be attached before that.

## 4. Key-day deploy (single go-live)

Prerequisites: a key validated by section 3, a backup taken (section 5), and
`docker-compose.onion.yml` present in the release. Clearnet's configuration is
unchanged throughout — the overlay only adds `onion-tor` and extends `caddy`'s
**and `app`'s env (the auth redirect allowlist needs the mirror origin), so
attaching the overlay briefly recreates the app container as well.

On the VPS, the release dir is the compose project root; the live chain is
`base + volumes + prod + prodmode + the VPS-local override files, with the
onion overlay attached LAST`. The VPS-local part changes over time — reconfirm
the current chain before use:

```bash
docker inspect app --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
```

(the label doesn't show `--env-file` arguments).

**1. Copy the key to the VPS over the SSH admin channel.**

```bash
ssh <vps> 'umask 077; mkdir -p ~/onion-key-staging'
scp -r .onion-keys/<address>.onion <vps>:~/onion-key-staging/
```

**2. Set `ONION_HOST` where compose interpolation can see it.** The value is the
address with **no scheme and no trailing dot**; it is public, not a secret.

```bash
echo "ONION_HOST=<address>" >> /path/to/stasher.news/.env.local   # uncommitted
# or: export ONION_HOST=<address>   in the deploy shell
```

The overlay declares `ONION_HOST=${ONION_HOST:?…}`, so *every* overlay
invocation fails loudly until it is set. It must be in the shell or an
`--env-file` the invocation passes (`.env.local` is the VPS chain's second env
file). The SOPS secrets loader runs *inside* containers and cannot satisfy
this interpolation.

No committed env file may define it: `.env.development` is the first
`--env-file` of every documented chain, so even a placeholder value there
would satisfy the gate silently instead of failing it.

**`.env.production` is the WRONG place for it** — that file is only a container
`env_file` (it becomes variables *inside* running containers), never a compose
interpolation `--env-file`, so a value there leaves `${ONION_HOST:?…}` unmet.

**3. Build the tor sidecar image for the release.**

```bash
export NODE_ENV=production
DC="docker compose --env-file .env.development --env-file .env.local \
  -f docker-compose.yml -f docker-compose.volumes.yml -f docker-compose.prod.yml \
  -f docker-compose.prodmode.yml -f docker-compose.mptcp.yml -f docker-compose.local-overrides.yml \
  -f docker-compose.onion.yml"
$DC build onion-tor
```

**4. Create the volume and import the key on the VPS.**

```bash
docker volume create stashernews_onion_tordata
./scripts/onion-import-key.sh ~/onion-key-staging/<address>.onion
docker run --rm -v stashernews_onion_tordata:/tordata \
  debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc \
  sh -c 'ls -la /tordata/hs'          # expect the three files, 0600, uid 1000
rm -rf ~/onion-key-staging
```

**5. Attach the overlay as the last file and start.**

```bash
$DC up -d
```

Only `caddy` and `app` are expected to be recreated (their env gained
`ONION_HOST`; the app's auth redirect allowlist reads it) and `onion-tor`
starts; worker/db are unchanged by the overlay. `onion-tor` has
no published ports — the onion service is the only way in.

**6. Verify.**

```bash
$DC ps onion-tor                        # healthy (start_period 5m, 1m interval)
docker logs -f onion-tor                # wait for "Bootstrapped 100%" and the HS
                                        # descriptor upload; publication 1–5 min
docker exec onion-tor cat /tordata/hs/hostname   # == <address>
# Explicit identity assertion: the healthcheck reads the hostname file itself,
# so it cannot catch a typo'd ONION_HOST — a wrong env value would advertise a
# different address while everything looks healthy. Assert equality by value.
[ "$(docker exec onion-tor cat /tordata/hs/hostname)" = "$ONION_HOST" ] \
  && echo 'identity OK' || { echo "MISMATCH: hostname != ONION_HOST ($ONION_HOST)"; exit 1; }
curl -sI https://stasher.news/ | grep -i '^onion-location'
# → Onion-Location: http://<address>/
```

The healthcheck is end-to-end: it fetches
`http://<address>/api/health` through the container's own SOCKS port. Healthy
means keys exist, the descriptor is published, introduction points work, and
Caddy → app is alive. The first healthcheck may take up to ~10 minutes
(bootstrap + descriptor propagation); give it that long before diagnosing.

Then run section 8's docker-native checks and Tor Browser checks against
`http://<address>/` before announcing the address anywhere.

## 5. Key backup

The three files in `onion_tordata` **are** the identity: whoever holds
`hs_ed25519_secret_key` controls the address, and losing it means a new
address and updating every published reference. Treat it as production secret
material.

Back up **at creation and on every key change**, encrypted, off-box:

```bash
umask 077
tar -C .onion-keys -czf /tmp/<address>.onion.tgz <address>.onion
# .sops.yaml's only creation rule targets secrets.env, so pass the recipient:
sops --input-type binary --output-type binary --age "$AGE_RECIPIENT" \
  encrypt /tmp/<address>.onion.tgz > /secure/off-box/<address>.onion.tgz.sops
shred -u /tmp/<address>.onion.tgz
```

**VPS-side extraction (every key change after go-live).** `.onion-keys/` is a
workstation artifact: on the VPS the only copy of the current identity lives in
`stashernews_onion_tordata`, so the tar above cannot be taken there. Extract it
to the host first, then run the same sops step:

```bash
umask 077
docker run --rm \
  -v stashernews_onion_tordata:/tordata:ro \
  -v "$PWD:/out" \
  debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc \
  sh -c 'umask 077; tar -C /tordata/hs -czf /out/hs-backup.tgz .'
sudo chown "$(id -u):$(id -g)" hs-backup.tgz
sops --input-type binary --output-type binary --age "$AGE_RECIPIENT" \
  encrypt hs-backup.tgz > <address>.onion.tgz.sops
shred -u hs-backup.tgz
```

- The helper runs as **root** on purpose: the volume files are `0600` owned by
  uid 1000, so any other uid is denied. `umask 077` inside the `sh -c` keeps the
  tarball `0600` (the container default would be `0644`, i.e. a
  world-readable copy of the key), and the `chown` hands it back to you so
  `sops` and `shred` work without root.
- The tarball root is `./` (the three files), not `<address>.onion/`. Name the
  encrypted output after the address it belongs to so a retired address and its
  replacement do not collide.
- `$PWD` must be a real host directory with room to spare — not the repo — and
  the plaintext exists only between the `tar` and the `shred`.
- `$AGE_RECIPIENT` is the off-box backup key's public age key (`age1…`), not the
  box key in `.sops.yaml`. If `sops` binary-mode encryption is unavailable on
  the workstation, `age -r "$AGE_RECIPIENT" -o <out> <file>` produces an
  equivalent encrypted file.
- Restore/verify: `SOPS_AGE_KEY_FILE=<keyfile> sops --input-type binary
  --output-type binary decrypt <file>.sops > /tmp/restore.tgz`, then confirm the
  `hostname` file matches the expected address (a workstation tarball unpacks to
  `<address>.onion/`; the VPS-side one unpacks the three files into a dir you
  choose) and re-run section 3's verify before use. A backup nobody has decrypted
  is not a backup — test it once at creation.
- Never commit key material: `.onion-keys/` is gitignored; keys do not belong
  in `.env.*`, tickets, chat, or the repo's `secrets.env`.
- `onion_tordata` is **not** listed in `docker-compose.volumes.yml`'s wipe
  guard. `docker compose down --volumes`, `docker volume prune`, or removing
  the volume destroys the address. Never run those on the VPS; the off-box
  backup is the recovery path.

## 6. Key replacement

Only for a deliberate address change (compromise, or a planned migration). The
old address stops working the moment its descriptor is replaced; announce the
new one only after verification.

Section 4's `DC` is a shell variable, not exported — restate the whole chain in
the shell running this procedure:

```bash
export NODE_ENV=production
DC="docker compose --env-file .env.development --env-file .env.local \
  -f docker-compose.yml -f docker-compose.volumes.yml -f docker-compose.prod.yml \
  -f docker-compose.prodmode.yml -f docker-compose.mptcp.yml -f docker-compose.local-overrides.yml \
  -f docker-compose.onion.yml"
```

```bash
# 0) back up the CURRENT key FIRST — it is still the only record of the old
#    identity. On the VPS that means the volume extraction in section 5
#    ("VPS-side extraction") followed by its sops-encrypt + shred, NOT section
#    5's workstation tar: .onion-keys/ does not exist here.
# 1) stop the sidecar; clearnet stays up.
$DC stop onion-tor
# 2) deliberately clear ONLY the hs dir (the import script refuses non-empty)
docker run --rm -v stashernews_onion_tordata:/tordata \
  debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc \
  sh -c 'rm -rf /tordata/hs'
# 3) import the new key (tor re-derives and proves it; stages 0700/0600)
./scripts/onion-import-key.sh ~/onion-key-staging/<new-address>.onion
# 4) update the address (or re-export it if the deploy shell supplies it)
sed -i 's/^ONION_HOST=.*/ONION_HOST=<new-address>/' .env.local
export ONION_HOST=<new-address>   # only if this shell exported the old value
# 5) recreate caddy with the new ONION_HOST, then recreate the sidecar into
#    caddy's fresh netns. onion-tor shares caddy's netns
#    (network_mode: "service:caddy"); compose does NOT auto-restart a dependent
#    when its netns owner is recreated, so the sidecar must be force-recreated
#    after caddy.
$DC up -d caddy
$DC up -d --force-recreate onion-tor
```

**Verify by value, not by presence.** A stale header is indistinguishable from a
fresh one unless the address is compared, so assert equality:

```bash
$DC ps onion-tor                      # healthy; first check may take ~10 min
addr=$(docker exec onion-tor cat /tordata/hs/hostname)
header=$(curl -sI https://stasher.news/ | grep -i '^onion-location:' | tr -d '\r')
printf 'expected: Onion-Location: http://%s/\nactual:   %s\n' "$addr" "$header"
printf '%s\n' "$header" | grep -qix "onion-location: http://$addr/" \
  && echo 'header OK' || echo "STALE HEADER — expected http://$addr/"
```

`Onion-Location` on the onion itself must stay absent (a bare `curl` to an
`.onion` does not route through Tor — run it inside the sidecar over SOCKS):
`docker exec onion-tor curl --socks5-hostname 127.0.0.1:9050 -sI http://<new-address>/ | grep -i onion-location` → no match.

**If caddy was not recreated**, the clearnet header still advertises the old
address — the usual cause is an `ONION_HOST` that only reached a *different*
shell, so the interpolation rendered the old value. A config reload cannot fix
it: `{$ONION_HOST}` is substituted from caddy's *process* environment at start,
and `docker exec caddy caddy reload …` inherits that stale environment — the
reload exits 0 while the header stays wrong. Put the new value in this shell's
env (or `.env.local`, which `--env-file` supplies) and **recreate** the
container:

```bash
export ONION_HOST=<new-address>
$DC up -d --force-recreate caddy
```

Then re-run the value assertion above and finish with section 8's verification
block before announcing the new address.

## 7. Ops notes

- **Rate limits and analytics see one client.** All onion visitors arrive with
  the tor container's address in `X-Forwarded-For` (Caddy overwrites it with
  the direct peer), so per-IP limits treat the entire onion population as a
  single bucket. Accepted for a small mirror; revisit if abused. The same
  applies to per-IP logs/metrics.
- **Monitoring is the docker-native healthcheck** on `onion-tor` (end-to-end,
  through the circuit). There is no external onion-ping monitor; alert on the
  container's health status like any other service. Container logs are
  `json-file`, capped at 10 MB × 3.
- **The overlay is additive.** It adds `onion-tor` + the `onion_tordata` volume
  and sets `ONION_HOST` on `caddy`. It must stay out of the live chain until
  key day (keys-first rule).
- **Never `--profile '*'` on the VPS** — it activates `onion-miner`.
- App outbound traffic never uses the tor SOCKS proxy (`SOCKSPort` is container
  loopback, for the healthcheck only). tor is an ingress source, nothing else.
- **Legacy `docker/tor/` is unrelated** — lnd-era, referenced by no compose
  file. Do not confuse it with `docker/onion/`.
- The Caddy onion listener is host-agnostic on purpose: the address never
  appears in Caddy config, so an address change needs no Caddyfile edit (only
  `ONION_HOST`, which feeds the clearnet `Onion-Location` header).
- **Recreating `caddy` orphans the sidecar's netns.** `onion-tor` runs with
  `network_mode: "service:caddy"`, and compose does **not** restart dependents
  when the netns owner is recreated. Cert renewals don't need this (Caddy
  renews in-process); any *config-driven* caddy recreation must be paired with
  `$DC up -d --force-recreate onion-tor` and a healthcheck check
  (`$DC ps onion-tor` → healthy).

## 8. Local end-to-end rehearsal + Tor Browser checklist

Rehearse on the workstation against the dev stack before key day. A throwaway
one-character prefix (`a`) finds a key in seconds; it is **not** the real
address.

```bash
# mine + import a throwaway key into the volume
# (ONION_HOST=unused.invalid satisfies the overlay gate; the miner never
# receives it and `run` starts nothing else)
mkdir -p ./.onion-keys && ONION_HOST=unused.invalid \
  CURRENT_UID=$(id -u) CURRENT_GID=$(id -g) \
  docker compose --env-file .env.development -f docker-compose.yml \
  -f docker-compose.onion.yml --profile onion-miner --profile domains-caddy \
  run --rm -T onion-miner -n 1 -d /out a
found=$(find .onion-keys -maxdepth 1 -name 'a*.onion' | head -1)
docker volume rm stashernews_onion_tordata >/dev/null 2>&1 || true
docker volume create stashernews_onion_tordata >/dev/null
./scripts/onion-import-key.sh "$found"

# up with the onion overlay + dev caddy
ONION_HOST=$(basename "$found") \
CURRENT_UID=$(id -u) CURRENT_GID=$(id -g) docker compose --env-file .env.development \
  -f docker-compose.yml -f docker-compose.onion.yml --profile domains-caddy \
  up -d --build

# MUST print the basename of $found
docker exec onion-tor cat /tordata/hs/hostname
# (ps/down only read the compose model; the inert value never reaches a container)
ONION_HOST=unused.invalid docker compose --env-file .env.development \
  -f docker-compose.yml -f docker-compose.onion.yml ps onion-tor
```

The dev Caddyfile has the same host-agnostic `http://:8081` onion listener, so
dev and prod exercise the same tor → Caddy → app hop. Descriptor publication
takes 1–5 minutes; watch `docker logs -f onion-tor`.

Two passes. **Docker-native checks** first (no Tor Browser needed):

```bash
# the key tor loaded is the one that was staged
docker exec onion-tor cat /tordata/hs/hostname      # == basename of $found
# the container's own healthcheck is the end-to-end SOCKS fetch
ONION_HOST=unused.invalid docker compose --env-file .env.development \
  -f docker-compose.yml -f docker-compose.onion.yml ps onion-tor           # STATUS … (healthy)
# the same fetch, by hand
docker exec onion-tor sh -c 'curl --socks5-hostname 127.0.0.1:9050 -sf \
  "http://$(cat /tordata/hs/hostname)/api/health"'
# Onion-Location: present on clearnet, absent on the onion. Dev's Caddyfile
# never emits it, so presence is a VPS check after key day. A bare curl to an
# .onion does not route through Tor — run it inside the sidecar over SOCKS.
curl -sI https://stasher.news/ | grep -i onion-location
docker exec onion-tor sh -c 'curl --socks5-hostname 127.0.0.1:9050 -sI \
  "http://$(cat /tordata/hs/hostname)/" | grep -i onion-location'  # expect no match
```

Then, in **Tor Browser**, open `http://<address>/` and confirm the eight human
checks:

1. The page loads **with styles** — `upgrade-insecure-requests` must not break
   same-origin subresources on the onion (the URIR `.onion` exemption). In dev
   (`NODE_ENV=development`) `proxy.js` omits the directive entirely; production
   emits it, and Tor Browser must be relied on to exempt the `.onion` origin.
   **Confirm this in the real Tor Browser before key day.** If styling breaks,
   strip the directive for the onion listener **only** (Caddy `header_down` on
   the `:8081` block, or a host check in `proxy.js`) and never for clearnet;
   record the change here. Do that remediation **immediately** when the
   rehearsal shows it: the fix must be written into this runbook (and
   committed) before key day — a contingency that exists only as an untested
   idea is not a contingency.
2. Login works and the session survives a reload (`Secure` cookie on the
   trustworthy onion origin).
3. Email login stays on the mirror end to end: submit an address on `/login`,
   land back on the **mirror's** `/email` with the code form enabled (not a
   disabled dead end), enter the magic code, and remain logged in on the
   mirror after the redirect. A deliberately wrong code must show the error
   page without leaving the onion.
4. Posting/commenting works.
5. An upload through `/uploads` succeeds.
6. `/admin` and `/api/admin` return 404.
7. `/api/monero/webhook` returns 404.
8. Invite-gate behavior matches clearnet (if `SITE_INVITE_CODES` is set).

Local dev parity is partial, and that is expected. The dev `http://:8081`
block imports only `deny_admin`, so `/admin` and `/api/admin` 404 through the
same edge, while `/api/monero/webhook` falls through to the app (a GET returns
405 — the prod edge guard that returns 404 lives in the `(ingress)` snippet).
`/uploads` uses the dev media routing rather than prod's `minio:9000` hop. The
prod-only guarantees — edge-404 webhook, `Onion-Location` on clearnet and never
on the onion, maintenance parity — are covered by
`test/config/onion-caddy.test.js` against the pinned Caddy binary
(`CADDY_BINARY=$(which caddy) npx jest test/config/onion-caddy.test.js`; skipped
when no `caddy` binary is installed) and must be re-checked on the VPS after key
day.

Teardown after the rehearsal (workstation only — never the VPS):

```bash
ONION_HOST=unused.invalid docker compose --env-file .env.development \
  -f docker-compose.yml -f docker-compose.onion.yml --profile domains-caddy down
docker volume rm stashernews_onion_tordata
rm -rf .onion-keys
```
