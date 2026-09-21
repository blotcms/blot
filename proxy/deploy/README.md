# Deploying the proxy container

Two scripts, both run **on the production host** (copy the directory over, no
checkout needed there):

```sh
scp -r proxy/deploy blot:~/proxy-deploy
```

| Script | When |
| --- | --- |
| [`cutover-from-baremetal.sh`](cutover-from-baremetal.sh) | Once. Moves `:80`/`:443` from the bare-metal `openresty` systemd unit to the first container. Not zero-downtime (a few seconds), and built to be reversible at every step. |
| [`blue-green.sh`](blue-green.sh) | Every image change after that. Container to container, zero-downtime. |
| [`reload-config.sh`](reload-config.sh) | Not for these containers: it needs the conf directory bind-mounted, which `blue-green.sh` does not do. Ship config changes as a new image. |

Both read the host's settings from `/etc/blot/proxy.env`
([`proxy.env.example`](proxy.env.example)) and share [`common.sh`](common.sh).
Paths default to the ones bare-metal uses (`/var/instance-ssd/cache`,
`/var/instance-ssd/logs`, `/etc/ssl/private`), so the cache stays warm across
the cutover and a rollback loses nothing. `bash tests/run.sh` exercises both
against fake `docker`/`systemctl` (CI runs it).

## Before the first cutover

1. **An image.** `.github/workflows/proxy-image.yml` publishes
   `ghcr.io/blotcms/blot-proxy:<sha>` (multi-arch, built with
   `LOG_TO_STDOUT=false` because `fail2ban`, `logrotate` and the `.bashrc`
   helpers read `/var/instance-ssd/logs/access.log` and the container has no
   ban layer of its own; both scripts refuse an image that logs to stdout).
   It only runs when `proxy/`, `config/openresty/` or the generator's inputs
   change, so pick a SHA from a run of it. Pass the SHA to either script;
   anything containing `/` or `:` is used as a full image reference.
2. **`/etc/blot/proxy.env`** from the example. `PROXY_PRIVATE_IP` and
   `PROXY_REDIS_HOST` (both required, the scripts refuse empty values) must equal what bare-metal uses today
   (`OPENRESTY_INSTANCE_PRIVATE_IP`, `REDIS_IP`), and `BLOT_REVERSE_PROXY_URLS`
   in `/etc/blot/secrets.env` must point at `http://<PROXY_PRIVATE_IP>:8077`,
   because Node purges the cache from a Docker bridge that cannot see the
   host's `127.0.0.1`. The scripts read the value from the running Node
   container, so recreate the Node containers (a normal deploy) after editing it.
3. **Ship the certificate-renewal change.** `config/openresty/scripts/renew-wildcard-ssl.sh`
   now reloads the container when there is one. Run
   `config/openresty/deploy-config.sh` from this branch so the host has it;
   the cutover refuses to run until it does, because otherwise the container
   would keep serving the old wildcard certificate after the next renewal.
4. Optionally run the scripts with `PROXY_CUSTOM_DOMAIN=<a real custom domain>` set:
   it adds a domain whose certificate comes from Redis to every before/after
   comparison. This is in addition to the sweep below, which always runs.
5. `redis-cli` must be on the host (the renewal scripts already use it).

## Custom-domain certificates

Custom domains are not among the checked hosts and their certificates come from
Redis, not the wildcard file, so a container that could not read or serve them
would pass every other check. Both scripts therefore record the certificate the
running proxy presents for **every** `ssl:<domain>:latest` key in Redis (looked
up by SNI on `127.0.0.1`), and require every one to be unchanged: on the
rehearsal port before the cutover, and on the real ports after the swap
(`blue-green.sh` rolls back, the cutover restores bare-metal). A domain that
presented no certificate beforehand is not held against the replacement. A
certificate that legitimately renews in the seconds between the two sweeps
would fail the check; rerun the script.

The scripts refuse to go on if `redis-cli` is missing or no certificate could
be read from the running proxy. `PROXY_SKIP_CERT_SWEEP=1` skips the comparison.

This does not cover *issuing* or *renewing* certificates: the `proxy-image`
workflow checks that the image trusts the public CAs and has its ACME tooling,
and the `cert-issuance` job issues against Pebble, but nothing yet exercises
dehydrated 0.7.2 against Let's Encrypt.

## Cutover

```sh
ssh blot
tmux new -s proxy-cutover
~/proxy-deploy/cutover-from-baremetal.sh --dry-run <commit-sha>   # preflight + rehearsal only
~/proxy-deploy/cutover-from-baremetal.sh <commit-sha>             # asks you to type "cutover"
```

The dry run is safe at any time. The header of the script lists everything
checked. In short, the image is run on `127.0.0.1:18443` against the real Node
containers, Redis and certificate and must answer exactly as bare-metal does,
*before* anything is stopped. Then bare-metal stops, the container starts, the
same checks run over the real ports, and any failure (or Ctrl-C, or a dropped
connection) puts bare-metal back. The bare-metal unit stays enabled, and the
container has no restart policy, until a two-minute soak passes, so a reboot
during the cutover also lands on bare-metal.

Afterwards bare-metal OpenResty stays installed but disabled. To go back by hand:

```sh
docker rm -f blot-proxy-blue && sudo systemctl enable --now openresty
```

## Known gaps

- **Purge during a blue/green overlap.** Node now purges each proxy
  independently and retries ones that were down (#1936), but the two
  containers share `127.0.0.1` and the private address, so for the few seconds
  both listen a purge is accepted by only one of them, which counts as
  delivered. `cacher.lua` tracks keys in per-process memory, so keys the other
  cached in that window are not purged. Deploy when few edits are happening.
- **`:8999` ACME hook** during the overlap (see the root `TODO`).
- The container has no `fail2ban` of its own; it relies on the host's reading
  the shared log directory (hence the log-mode guard above).
