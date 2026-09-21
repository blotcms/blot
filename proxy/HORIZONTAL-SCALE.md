# Horizontally scaling and multi-regioning the OpenResty proxy

This is a design note, not a cutover checklist. It assumes the
containerisation in this directory (`proxy/`) is finished and has replaced
bare-metal `config/openresty` on the current host. The remaining
containerisation gaps that also matter for scaling are called out where they
do; they are not re-litigated here.

**Verdict:** nothing about customer-site certificates, or about independent
proxy caches, stops us running N proxy containers. Custom-domain certs are
already Redis-backed and served per-handshake via SNI; two valid Let's
Encrypt certs for the same hostname are not a TLS conflict. What actually
blocks a second *host* (let alone a second region) is that the generated
config still treats the proxy as a co-located process on the Node box:
loopback upstreams, a loopback purge listener, a host-file wildcard cert, and
customer DNS that can pin a single A record.

Independent disk caches are the right model. Do not share them.

---

## 1. What the proxy is today

Production is one EC2 host in `us-west-2`. Bare-metal OpenResty terminates
TLS, caches GET/HEAD responses on instance SSD, and load-balances to three
Node containers on the same machine (`127.0.0.1:8088–8090`). Redis lives on
a second EC2 instance in the same region. There is no AWS load balancer in
front of OpenResty; customer traffic hits the box directly. Bunny CDN sits
in front of `cdn.blot.im` (origin = this host), not in front of custom
domains.

The container fork keeps that topology on purpose: `--network host`,
hard-coded `127.0.0.1` upstreams, SO_REUSEPORT only so two containers can
share `:80`/`:443` during a same-host image swap. That is zero-downtime on
one box, not a multi-host fleet.

Two certificate systems:

| Name | How issued | Where the private key lives | Reload needed? |
| --- | --- | --- | --- |
| `blot.im` / `*.blot.im` | `acme-nginx` + Route53 DNS-01, daily cron | `/etc/ssl/private/letsencrypt-domain.{pem,key}`, copied to Redis as `blot:openresty:ssl:{pem,key}` for bootstrap | Yes (`openresty -s reload`) |
| Customer custom domains | `lua-resty-auto-ssl` → dehydrated → Let's Encrypt HTTP-01, on first HTTPS request | Redis `ssl:{host}:latest` (JSON with `fullchain_pem` + `privkey_pem`); shm cache `lua_shared_dict auto_ssl 100m` (~10k domains) | No. `ssl_certificate_by_lua` serves it on the handshake |

`*.blot.im` is a static `ssl_certificate` on the named vhosts (handle
subdomains, previews, CDN, dashboard). Custom domains are the
`default_server` and use auto-ssl. Those two never compete for the same SNI
on the same server block. `webhooks.blot.im` is the one overlap: it includes
auto-ssl *and* the wildcard fallback.

Allowlist: Blot writes `domain:{host}` in Redis from `app/models/blog/set.js`
(apex + www backup, plus `{handle}.blot.im`). `allow_domain` in
`proxy/config/init.conf` issues only when that key exists, or when a cert is
already in storage.

HTTP-01 tokens and the issuance lock also live in Redis
(`ssl:{domain}:challenge:{token}`, `ssl:{domain}:issue_cert_lock`, 30s TTL).
The library authors describe the lock as imperfect; it is a get-then-set,
not `SET NX`.

Caches: `proxy_cache_path` on local disk (`max_size=200g`, `inactive=1y`),
indexed by `cacher.lua` in `lua_shared_dict cacher_dictionary`. Purge is
`GET /purge?host=…` on the loopback (or private-IP `:8077`) listener. Node
already iterates `config.reverse_proxies` (`BLOT_REVERSE_PROXY_URLS`,
default `http://127.0.0.1:80`) in `app/helper/flushCache.js`.

`ssl_session_tickets` is off. Session resumption is per-process shm. That is
the correct default for a fleet; do not turn tickets on without a shared
ticket key.

---

## 2. Competing certificates — the actual behaviour

The worry is: N proxies each try to issue for `example.com`, we end up with
two certs, browsers break. That is not what happens.

### Serving is already a shared-store read

On handshake, `ssl_certificate_by_lua` loads `ssl:example.com:latest` from
shm, then Redis. Any proxy with that Redis can terminate TLS for that
hostname without issuing anything. CI already proves a cert survives a
container recreate because it lives in Redis, not on the container
filesystem. No nginx reload. No shared filesystem of PEMs.

Two Let's Encrypt certificates covering the same name are both valid. A
browser does not pin the serial. Cloudflare Full (strict) accepts either as
long as the name and dates match. Last writer to Redis wins; the loser
becomes garbage that expires. Shm on the losing instance may keep serving
the old cert until it ages out — also fine, both are valid.

What *does* hurt is burning Let's Encrypt's duplicate-certificate limit
(5 identical names per week) and failing HTTP-01. Those are issuance
problems, not serving problems.

### Same region, shared Redis, one public VIP (N proxies behind one LB)

This is the design lua-resty-auto-ssl's Redis adapter is for.

1. First HTTPS request for a new hostname: both proxies may enter
   `ssl_certificate()`. Local `resty.lock` plus Redis `issue_cert_lock`
   usually serialise it. The second waits, then reads `ssl:{host}:latest`.
2. The get-then-set lock can let both through. Then two ACME orders run.
   Challenge tokens are in Redis, so Let's Encrypt can hit *either* proxy
   and the challenge succeeds — **if both terminate the same public
   address**. Last write wins in Redis. Risk: rate limit, wasted orders,
   a few failed handshakes during the race.
3. The `:8999` dehydrated hook is loopback per instance. On separate hosts
   that is correct and *easier* than today's same-host SO_REUSEPORT overlap
   (the known blue/green hook-secret flake). Do not share `:8999` across
   hosts.

So: competing issuance is a rate-limit/race, not a correctness failure, as
long as Redis and the public HTTP-01 endpoint are shared. For a same-region
fleet this is acceptable. It is not a reason to keep a single proxy.

### Multi-region, still one Redis

HTTP-01 still works if **every public IP Let's Encrypt might land on** runs
a proxy that reads the same Redis. Let's Encrypt validates from multiple
network perspectives. Geo-DNS that returns different A records is fine only
if each of those addresses serves the Redis-backed challenge. If a region is
down, *new* issuance can fail multi-perspective validation; existing certs
keep serving.

Anycast (one IP, routed to the nearest proxy) is simpler for ACME than
geo-DNS, because every validator hits the same address.

Do not give each region its own Redis for certs. Independent Redis means
independent locks, independent challenges, independent keys, and Let's
Encrypt seeing a challenge that the other region started. That is the
failure mode that looks like "competing certificates."

### Wildcard `*.blot.im`

This is the cert that is *not* multi-instance ready.

It is a file on disk. Redis holds a copy only so `setup.sh` can bootstrap a
**new** host once. Renew writes local files, pushes Redis, and reloads
**that** openresty. A second host will keep serving the old wildcard until
someone copies the files and reloads.

Two regions both running the daily Route53 renew cron will fight over
`_acme-challenge.blot.im` TXT records. One winner must own DNS-01.

### What not to worry about

- **www vs apex.** Two Redis `domain:*` keys, two certs. Intended.
- **Cloudflare-proxied custom domains.** Origin TLS is still this cert.
  HTTP-01 has to reach origin on `:80` (Flexible / Full, or a grey-cloud
  challenge). That is today's constraint; extra proxies do not change it.
- **Non-SNI clients.** They already get the default_server fallback
  (wildcard, wrong name). `forceSSL` is left off on domain connect for this
  reason. Unrelated to replica count.
- **Sharing `/etc/resty-auto-ssl`.** Do not. That volume is dehydrated
  account state and hook working files, per instance. Multiple ACME
  accounts are allowed. Issued certs are in Redis.
- **Independent proxy caches.** A HIT on proxy A and a MISS on proxy B is
  expected. Purge must hit every instance (already a list). Do not NFS the
  cache directory.

### Preferred end state for certs

Keep Redis as the source of truth. Make proxies **read-mostly**: serve from
Redis/shm; do not issue on the hot path from every replica.

`proxy/README.md` already lists the two replacements worth a spike, and they
are the right ones for a fleet:

1. **Issue from the Blot app** (or a tiny cert-manager job) when a domain is
   connected, after DNS actually points at us (the stale-resolver race in
   the root `TODO`). Write `ssl:{host}:latest`. Proxies only read. HTTP-01
   can still be answered by every proxy via Redis tokens, or move to DNS-01
   if we ever control a challenge CNAME.
2. **`lua-resty-acme`** in autossl mode, still in OpenResty, dropping
   dehydrated / sockproc / `:8999`. Same Redis layout is an open question;
   the Pebble `cert-issuance` job is the acceptance test.

Until one of those lands, shared Redis + the existing lock is enough for
same-region N proxies behind one VIP. It is the main thing to tighten
before a second *region* starts issuing.

Wildcard stays a single DNS-01 job. Distribute PEMs from Redis (or a secret
store) to every proxy and reload; do not renew in every region.

---

## 3. What actually blocks N proxies, then a second region

Ranked. "Fine as independent" is marked as such.

### Already safe across replicas (given shared Redis)

- Custom-domain cert **serving**
- `domain:*` allowlist
- Node sessions (`connect-redis`)
- Blog metadata
- `ssl_session_tickets off`
- Cache purge protocol (the *list* of URLs is the gap, not the mechanism)
- `Blot-Server` / `SERVER_LABEL` (already a per-instance label)

### Must change for a second host, even in one region

1. **Upstreams are `127.0.0.1`.** `NODE_SERVER_IP` is required by the
   generator and assigned to `node_ip`, then never interpolated. `webhooks.`
   is pinned to `127.0.0.1:8089` because green holds an in-memory SSE
   subscriber map (`app/clients/webhooks.js`). A proxy on another machine
   cannot use host networking to reach those ports. The generator needs
   real upstream addresses (or DNS names) for `blot_node` /
   `blot_blogs_node` / `blot_dashboard_node`, and the webhook pin needs to
   be "the master Node," not loopback.

2. **`--network host` is load-bearing.** Same cause. A fleet behind an LB
   should use bridge/VPC networking; host mode is a same-box shortcut.

3. **Purge is loopback and unauthenticated.** Node in Docker already needs
   `OPENRESTY_INSTANCE_PRIVATE_IP:8077` because it cannot see `127.0.0.1:80`
   on the host. N proxies need each instance reachable on a private
   address, a shared secret on `/purge`, and a way to *discover* the list.
   `BLOT_REVERSE_PROXY_URLS` is a static CSV. That is fine for two named
   hosts; it is not an autoscaling group. Register-in-Redis-on-boot, or
   publish purge over Redis pub/sub, rather than NFS or a shared cache.

4. **Wildcard PEM distribution.** Pull from Redis (or secrets) on a timer /
   SIGHUP; one elected renewer. The container today expects a read-only
   bind-mount of host files.

5. **Redis is reached with no auth or TLS, port 6379.** Opening that to a
   proxy subnet — let alone a second region's VPC — makes Redis the store
   of every custom-domain private key. Auth, TLS, and network policy have
   to land before the second listener. Timeouts too: `resty.redis` defaults
   to 60s, which on a TLS handshake is a user-visible stall; `allow_domain`
   currently fails *open* on Redis errors (can issue for arbitrary SNI).

6. **Config is still a same-host generator.** Build-time `REDIS_IP`,
   `BLOT_HOST`, ACME directory, resolver. A regional fleet needs runtime
   config (or at least per-region generate) for Redis endpoint, upstreams,
   `SERVER_LABEL`, and the wildcard mount.

7. **Production CDN vhost reads `blog_static_files_dir` off local disk**
   (`config/openresty/conf/server.conf`), then falls through to Node. A
   proxy without that filesystem will miss and proxy; Bunny already absorbs
   most of this. Do not copy EBS to every proxy. The container fork already
   proxies `cdn.` instead of `try_files` — keep that.

### Acceptable to leave independent (do not "fix" by sharing)

- Disk cache + `cacher.lua` shm index. More origin load on a cold replica;
  purge all of them. `proxy_cache_lock` stays local, which is what you want.
- `limit_req` / `limit_conn` zones. N proxies ≈ N× the published rates.
  Worth knowing (scanner budget grows); not a reason to introduce shared
  rate-limit state in v1. fail2ban is host iptables and does not travel;
  path blocks in `blot-blogs.conf` do.
- OpenResty worker shm in general (`auto_ssl`, `SSL` session cache).

### Extra for a second region (proxies only; Node can stay in `us-west-2`)

8. **Customer DNS.** Docs and the dashboard tell people to CNAME or ALIAS to
   `blot.im`, with an A-record fallback to `config.ip` (`BLOT_IP`). CNAMEs
   follow whatever `blot.im` becomes. A records pin one address.
   `app/dashboard/site/domain/verify.js` **rejects** extra A/AAAA records
   (`MULTIPLE_ADDRESS_BUT_ONE_IS_CORRECT`). So "publish two regional A
   records" fights the verifier. Prefer one anycast/Global Accelerator IP
   (or keep a single origin IP and CNAME everything). IPv6 is still a
   `TODO`; `config.ipv6` is optional.

9. **HTTP-01 + multi-perspective validation.** Shared Redis challenges on
   every regional listener, or stop issuing on the proxy (section 2). Do
   not run independent ACME in each region.

10. **Redis RTT on a shm miss.** 100m shm is sized for ~10k custom domains.
    Warm proxies should not hit Redis on every handshake. A remote Redis
    is fine for issuance, lock, and cold start; it is not fine as a 60s
    `connect()` inside `ssl_certificate_by_lua`. Set a short timeout
    before a second region exists.

11. **HTTP/3.** Production listens `443 quic` (reuseport only on the
    default server). Connection-ID routing across N L4 backends is messy.
    Terminate h3 at the anycast/LB layer or pin UDP 443 to one backend
    until that is designed. Not a v1 blocker if we stay on TCP 443.

12. **Cross-region cache MISS.** HTML for custom domains is not on Bunny
    today; it is this proxy. A regional HIT is the whole point. A MISS
    goes to Node in `us-west-2`. That is a good first multi-region shape
    (TLS + cache at the edge, origin in one place). It does not require
    stateless Node.

### Not required to scale the proxy (Node work; do not block on it)

The root `TODO` pairs "Get proxy horizontally scalable" with "Get node
container horizontally scalable" (S3 storage, git on SSD cache, Redis
locks instead of `proper-lockfile`). That is the path to **multi-host
Node**. It is not a prerequisite for **multi-host proxy** in front of the
current single Node box.

Things that stay single-writer even with N proxies:

- Blog folders on one EBS mount
- Sync folder locks
- Green-only webhook relay and `/clients` / rebuild routes
- Airlock sidecar
- Git bare repos

Webhooks still have to reach *one* Node process. That is an upstream
setting on the proxy, not a reason to run only one proxy.

---

## 4. Target shapes

### A. Same region, N proxies, one Node host

```
customers ──► NLB / anycast IP :80/:443
                 ├─ proxy-a  (cache A, shm A) ──┐
                 ├─ proxy-b  (cache B, shm B) ──┤──► Node blue/green/yellow
                 └─ proxy-c  (cache C, shm C) ──┘         (us-west-2)
                                │
                                ▼
                         Redis (certs, domain:*, sessions)
```

This is the first useful scale-out: TLS and cache CPU off the origin box,
rolling proxy deploys without touching Node, capacity for scanner traffic
without failing customer HTML.

Same-host SO_REUSEPORT blue/green can stay as the *deploy* mechanism for
each VM, or be replaced by LB target registration. Do not keep host
networking once upstreams are real addresses.

### B. Multi-region proxy edge, Node still `us-west-2`

```
eu-west-1 proxies ──┐
ap-southeast-1     ──┼──► us-west-2 Node (+ Redis)
us-west-2 proxies  ──┘
```

DNS: `blot.im` (and therefore customer CNAMEs) to anycast or latency-based
routing. One shared Redis (primary in `us-west-2`; a replica is optional
for reads, not for `issue_cert_lock` or challenge writes unless we move
issuance off the proxy). Cache HIT never leaves the region. Cache MISS and
dashboard/sync still cross the ocean.

### C. Multi-region Node — later, not this project

Needs `app/storage`, Redis distributed locks, git-on-S3, and a decision
that one-region S3 plus SSD cache is enough (`app/storage/README` §4.3).
Out of scope here.

---

## 5. Proposed process

Do not start with a second region. Almost all of the work is "the config
stops assuming localhost." A second region is DNS + Redis policy on top of
that.

### Phase 0 — finish the container cutover (already in flight)

Tracked under "Proxy container (OpenResty)" in the root `TODO`. For scaling,
the pieces that cannot slip past cutover:

- One source of config (`proxy/config` vs `config/openresty/conf`). The
  fork still omits rate-limit and bot-restriction partials.
- Redis auth/TLS and a ~2s Redis timeout; `allow_domain` fail-closed.
- Wire `proxy/deploy/*` into real deploy; drop the stats/netdata host path.
- Decide whether to replace lua-resty-auto-ssl now or after the first
  multi-host proxy. Replacing it is easier *before* a fleet exists, because
  the hook-server and dehydrated volume are the awkward parts. It is not a
  hard gate for Phase 1 if Redis stays shared.

Do not invent a shared cache or shared rate-limit layer as part of
cutover.

### Phase 1 — one host, but the image is multi-host capable

Work that can land while still running a single proxy next to Node:

1. **Interpolate upstreams.** Use `NODE_SERVER_IP` (or better: three
   explicit upstream addresses / DNS names) in `upstream` blocks. Keep
   loopback as the default so same-host compose still works. Point
   `webhooks.` at the master Node by config, not `127.0.0.1` in the vhost.
2. **Runtime vs build-time config.** Redis host, upstreams, `SERVER_LABEL`,
   resolver, ACME directory should not require rebuilding the image.
3. **Wildcard from Redis.** On boot (and periodically) write
   `blot:openresty:ssl:{pem,key}` to the well-known paths and reload if the
   hash changed. One job remains the Route53 renewer (can stay on the Node
   host or become a scheduled task).
4. **Purge over the private network, authenticated.** Token in
   `X-Blot-Purge-Token` or a query secret; listen on the instance private
   IP only. Node's `BLOT_REVERSE_PROXY_URLS` should be constructible from a
   Redis set the proxy registers in at start (key TTL + refresh).
5. **E2E without `--network host`.** A compose file where the proxy
   reaches Node by service name is the acceptance test that Phase 2 will
   not rediscover loopback. Extend `cert-issuance` with two proxy
   containers sharing Redis and one Pebble, asserting a single Redis cert
   and HTTP-01 succeeding no matter which proxy Let's Encrypt (Pebble)
   hits.

Exit: we *could* run the container on a second VM in `us-west-2` pointing
at the existing Node ports, even if we have not done so yet.

### Phase 2 — same-region horizontal scale

1. Put an NLB (TCP 80/443; UDP 443 only if we keep h3) or equivalent in
   front of 2+ proxy tasks. Health check the per-container Unix socket
   translated to a private TCP `/health`, not reuseport `:80`.
2. Keep Node where it is. Set `BLOT_REVERSE_PROXY_URLS` (or the Redis
   registry) to both proxies. Confirm a blog update purges both (HIT →
   MISS on each).
3. Confirm a brand-new custom domain: one cert in Redis, no duplicate
   ACME orders under load (siege HTTPS to the hostname through the LB).
   If duplicates show up, that is the cue to pull issuance off the
   request path (Phase 3), not to revert to one proxy.
4. Wildcard renew: run once, both proxies pick up the new PEM without a
   deploy.
5. Operational: `SERVER_LABEL` distinct per instance; logs already
   stdout. Rate limits stay per-instance; watch scanner 444s rather than
   trying to share fail2ban.

This delivers most of the operational value (capacity, deploy isolation)
without DNS product changes.

### Phase 3 — issuance out of the request path (before a second region)

Do this before geo-DNS, not after.

- App (or one elected worker) issues after `verify.js` succeeds, writes
  Redis, HEAD-probes `https://{host}` only to populate shm.
- Proxies: `ssl_certificate_by_lua` reads only; if missing, serve the
  fallback and let the app retry — do not start dehydrated on a random
  edge.
- Optionally keep Redis-backed HTTP-01 on every proxy so the issuer can
  still use HTTP-01 globally.
- Tighten `verify.js` so we do not request a cert while our resolver still
  sees the old A record (existing `TODO`).

If lua-resty-acme is chosen instead, still treat "any replica may issue"
as a bug: one writer, many readers.

### Phase 4 — multi-region proxy edge

1. **Front door:** AWS Global Accelerator or equivalent anycast onto
   regional NLBs, *or* latency-based DNS for `blot.im`. Do not ask
   customers to change records if they CNAME to `blot.im`. Leave the A
   record in the docs as "the anycast IP" (`config.ip`), not a list of
   regional IPs, unless `verify.js` is taught a set of acceptable
   addresses.
2. Run Phase 1 images in the new region with `SERVER_LABEL=eu` (etc.),
   upstreams = private connectivity back to `us-west-2` Node (peering /
   PrivateLink), Redis = the same logical store (TLS, auth, short
   timeout).
3. Do not replicate Redis for certs. Do not run the wildcard cron in the
   new region. Do not share cache volumes.
4. Acceptance: existing custom domains handshake in the new region
   without issuing (Redis read + shm fill). A *new* domain issues once.
   Cache HIT stays in-region (`Blot-Server` header). Dashboard/sync still
   origin-region.
5. Cloudflare-proxied sites: origin IP may become the anycast address;
   Full (strict) should keep working because the cert is the same Redis
   object.

### Phase 5 — only if origin MISS cost or Node CPU demands it

Stateless Node (`app/storage`, git, locks). Regional Node is a different
project; the proxy fleet does not have to wait for it.

---

## 6. Suggested order of code changes (once cutover is done)

Small, reviewable diffs, each shippable to the single-host setup:

1. Generator: actually emit `server` lines from upstream config; webhook
   vhost uses that master address.
2. Redis: auth, TLS, connect timeout, `allow_domain` fail-closed; e2e with
   Redis down.
3. Wildcard: boot/reload from Redis keys; cron stays one-shot.
4. Purge: auth + private listen; registry or documented multi-URL env.
5. Compose/e2e: two proxies, one Redis, one Node, no host network.
6. Issuance: app-driven or lua-resty-acme, with "one writer" as the test.
7. DNS/verify: anycast IP as `config.ip`; only then a second region.

---

## 7. Direct answers

**Anything stopping horizontal scale?** Not certificates and not caches.
Loopback upstreams, loopback purge, host networking, and an undistributed
wildcard file. Those are config/deploy work, not a new TLS architecture.

**Anything stopping multi-region?** The same, plus DNS (A records and
`verify.js`) and the rule that HTTP-01 / issuance must see one Redis and
every public listener. Cross-region Node and S3 are not required to put
proxies in a second region.

**Competing customer certs?** Harmless at the TLS layer if Redis is shared;
harmful if each region issues into its own store. Make replicas readers.
Keep one DNS-01 owner for `*.blot.im`. Independent caches are correct.
