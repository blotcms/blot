# airlock

The single egress boundary for fetching **untrusted, user-supplied URLs** in
Blot's build pipeline.

Two callers in Blot are routed through it - both fetch a URL a user controls,
on Blot's own infrastructure, and show the result back to that user, which is
what makes them read primitives rather than just SSRF:

| Caller | User input | What it does |
| --- | --- | --- |
| [`app/build/plugins/linkScreenshot`](../../app/build/plugins/linkScreenshot) | `href` from an uploaded `.webloc` / `.url` bookmark file | screenshots the page, embeds the image in the post |
| [`app/helper/transformer/download`](../../app/helper/transformer/download) | `<img src>` / `![](…)` in a post | downloads the asset, caches it, rewrites to the CDN |

See "Known sinks not covered" below for other user-controlled fetches in the
app that aren't routed through `airlock` yet.

Without protection either one is a classic SSRF primitive: point it at
`http://169.254.169.254/…` (cloud instance metadata → credentials),
`http://10.x/…` (internal services, e.g. Redis on another instance), or
`http://localhost:8080/…` and the response comes back to the user.

`airlock` removes the whole class of problem by running those fetches inside a
container whose **network egress is filtered in the kernel**. The application
code does no IP classification.

## What's in the container

* **Chromium** (headless), DevTools bound to `127.0.0.1:9221`, attached to by
  `app/helper/screenshot` via `puppeteer.connect()`.
* **nginx** on **:9222** — a thin front for Chromium's DevTools endpoint.
  Alpine's Chromium ignores `--remote-debugging-address` and its `/json/*`
  endpoints reject a non-localhost `Host` header, so the app can't talk to it
  as `http://airlock:9222` directly. nginx forwards with `Host` reset to
  localhost, rewrites `webSocketDebuggerUrl` in the JSON back to the address
  the caller dialled, and carries the WebSocket upgrade. See
  [`nginx.conf`](nginx.conf).
* **tinyproxy** on **:8888** — an HTTP(S) forward proxy that
  `app/helper/transformer/download` points `node-fetch` at. It does no
  destination filtering itself (no `ConnectPort` allow-list either - see the
  comment in [`tinyproxy.conf`](tinyproxy.conf) for why that would just add a
  confusing failure mode without adding real protection); `egress.nft` is the
  only destination control.
* **[`egress.nft`](egress.nft)** — installed by
  [`entrypoint.sh`](entrypoint.sh) before any service starts. It `reject`s
  (fails fast, not a multi-second timeout per blocked destination) every
  RFC1918 / loopback / link-local / ULA / CGNAT / documentation / benchmark /
  6to4 / Teredo / NAT64 / multicast / reserved destination, v4 and v6. The
  cloud metadata address `169.254.169.254` is inside `169.254.0.0/16`.
  Loopback (`127.0.0.0/8`) is **not** blanket-allowed: Chromium and tinyproxy
  run as the unprivileged `airlock` user and handle user-supplied URLs, so if
  they could reach `127.0.0.1` freely, a bookmark or `<img src>` pointed at
  `http://127.0.0.1:9221/json/version` would reach this container's own
  unauthenticated DevTools endpoint. Only Docker's DNS resolver
  (`127.0.0.11`), nginx's own uid (the nginx → Chromium hop), and root (this
  entrypoint, the `HEALTHCHECK`) may use loopback - see the comment in
  [`egress.nft`](egress.nft).

`entrypoint.sh` runs all three services and exits (bringing the container
down for Docker to restart) if any of them stops.

Because the filter matches the **real destination IP at `connect()` time**,
in-kernel:

* DNS-rebinding doesn't help an attacker — the name is re-resolved by the
  kernel path and the *connection* is what's checked, not an earlier lookup.
* Redirects and sub-resources are covered — every hop is a fresh `connect()`.
* Non-HTTP egress (WebRTC, etc.) is covered too.

`--cap-add=NET_ADMIN` is required to install the ruleset. If it's missing the
entrypoint **exits non-zero** rather than coming up with no filter.

## Trust model

The DevTools endpoint and the proxy are **unauthenticated**. Network scope is
the access control: keep `airlock` on a Docker network shared **only** with the
Blot app containers. Nothing about `airlock` should be published to the host.

**Units (#2119).** The exception is the per-unit airlocks. Each unit
(`blot-blue`, `blot-green`) runs on the host network, which cannot join
`blotnet` or resolve its names, so it has its own airlock, `blot-blue-airlock`
and `blot-green-airlock`, deployed with it by `proxy/deploy/blue-green.sh`.
They stay on `blotnet` (for Docker's DNS) and publish their two ports on
**127.0.0.1 only**, at a distinct host port per unit (`AIRLOCK.units` in
`scripts/deploy/constants.js`, 19222/18888 for blue and 19223/18889 for green);
the unit's `BLOT_AIRLOCK_BROWSER_URL` and `BLOT_AIRLOCK_PROXY_URL` point at
them. The egress boundary does not change: `egress.nft` is in the airlock's
own network namespace and rejects by the real destination of each connection,
whoever the client is, and tinyproxy's client ACL already allows the bridge
gateway address that a published port presents. What does change is *who may
use* the airlock: nothing on a Docker network is a client any more, but any
process on the host can reach a loopback port, the proxy in each unit and
the host's shell users included. They could drive the airlock's browser, which
can still only reach public addresses. Treat the host's loopback as inside the
trust boundary, as it is for the Redis and purge listeners.

`airlock` itself only ever holds a rendered screenshot or a downloaded asset
in `/tmp` and `/home/airlock/profile` — no secrets, no data mount, no cloud
identity.

## Configuration (the app side)

`config/index.js` reads two env vars. `app/helper/airlock` is the single
app-side entry point that consumes them: it builds the proxy agent and
enforces **fail-closed** in production. Outside production (`config.environment
!== "production"`), or with an explicit local override, nothing is required
and fetches go direct — fine for local dev.

| Env var | Example | Used by |
| --- | --- | --- |
| `BLOT_AIRLOCK_BROWSER_URL` | `http://airlock:9222` | `app/helper/screenshot` (via `helper/airlock`) |
| `BLOT_AIRLOCK_PROXY_URL` | `http://airlock:8888` | `app/helper/transformer/download` and every other user-controlled fetch, via `helper/airlock` |

**Fail-closed:** in production, a caller that hands `helper/airlock` a
user-controlled URL when the airlock is not configured gets an **error**, not
a direct fetch. `helper/screenshot` likewise refuses to fall back to a
locally-launched Chromium for a screenshot flagged `untrusted` (the
bookmark-link plugin sets it). The affected operation fails and its caller
degrades gracefully — the app still boots and serves. `config/index.js` still
only **warns** on startup when the vars are missing: that is the signal that
this container missed the deploy and those features are down until it is
redeployed, not that anything is fetching unprotected.

## Local development

Wired into [`scripts/development/docker-compose.yml`](../../scripts/development/docker-compose.yml)
as the `airlock` service, with the two env vars set on `node-app`. Just:

```
docker compose -f scripts/development/docker-compose.yml up
```

Comment out the two `BLOT_AIRLOCK_*` lines to bypass it.

## Production

Each unit has its own airlock, `blot-blue-airlock` and `blot-green-airlock`, on
`blotnet`, deployed with the unit by `proxy/deploy/common.sh` (`ensure_airlock`;
settings from [`constants.js`](../../scripts/deploy/constants.js) via
`units.sh`). A problem with an airlock never goes unnoticed by a deploy: the
unit is not created if its airlock does not come up.

1. **Build & push.** `build-airlock` in `.github/workflows/build.yml` builds
   `config/airlock` per-arch, pushes `ghcr.io/blotcms/blot-airlock:<sha>-<arch>`,
   then `manifest-airlock` creates the multi-arch `<sha>` (and `latest` on
   master) tag - same shape as the app image. It also runs a "Verify egress
   filter" step, so a regression in `egress.nft`/`entrypoint.sh` fails the
   build - **not** the same commands as this file's own Verifying section
   below, on purpose: `169.254.169.254` and `10.0.0.1` have no route at all
   from a GitHub-hosted runner, filter or not, so testing against them
   there would pass identically whether or not `egress.nft` is doing
   anything. The CI step instead spins up a plain sibling container on the
   test network as a live target (its IP lands in `172.16.0.0/12`, the
   exact range the filter blocks), confirms an *unfiltered* sibling can
   reach it first, then asserts the airlock cannot - a check that only
   passes if the filter actually did something.

   [`deploy.yml`](../../.github/workflows/deploy.yml)'s own
   `wait-for-build` job waits for **both** the app and airlock manifests
   for the target commit before deploying anything. A commit whose airlock
   image never published still deploys: each airlock keeps running the image
   it has.

2. **Network + sidecar.** Before a unit is created, `ensure_airlock` creates
   the `blotnet` Docker network if it doesn't exist, and pulls/(re)starts the
   unit's airlock if it isn't already running the target commit's image
   **and** healthy - both conditions, not just the image tag, since a
   container that's merely present with the right tag but stopped or wedged
   unhealthy would otherwise be mistaken for "already deployed" and left
   broken until some later commit happened to change the tag. The unit it
   serves is stopped (or new) at that moment, and the other unit has its own
   airlock, so nothing is mid-screenshot. If the new image fails (bad build,
   failed health check), the image that was running before is started again.

3. **Reaching it.** The unit is on the host network, so it reaches its airlock
   on `127.0.0.1` at its own ports: `BLOT_AIRLOCK_BROWSER_URL` and
   `BLOT_AIRLOCK_PROXY_URL` are set by `run_args` in `proxy/deploy/common.sh`
   (see "Configuration" above).

4. **Harden the instance metadata service** while you're here - defence in
   depth for any other fetch in the app, independent of all of this:

   ```sh
   aws ec2 modify-instance-metadata-options --instance-id i-xxxx \
     --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled
   ```

## Also routed through the airlock

Beyond the two read primitives above, these user-controlled fetches go
through the proxy via `helper/airlock` (`.fetch`, which applies the proxy
agent and the fail-closed assertion). Most are **blind** — the response is
compared against a handle, or discarded — so not read primitives, but they
can still reach an internal address from a user-supplied host:

* [`app/dashboard/site/domain/verify.js`](../../app/dashboard/site/domain/verify.js)
  — connects to an A-record it resolved itself (authoritative nameservers +
  public fallback resolvers), `Host:` the dashboard-entered domain. Uses
  `helper/airlock.getViaIP`, not `.fetch`: the proxied request line targets
  `http://<ip>/verify/domain-setup` so the exact resolved IP is kept (the
  egress filter still re-checks it) instead of the proxy re-resolving the
  name, which would defeat the point of resolving it here.
* [`app/documentation/featured/verifySiteIsOnline.js`](../../app/documentation/featured/verifySiteIsOnline.js)
  and [`fetchSubscriptionDuration.js`](../../app/documentation/featured/fetchSubscriptionDuration.js)
  — `https://<blog.domain>/verify/*`.
* [`app/dashboard/site/domain/index.js`](../../app/dashboard/site/domain/index.js)
  `triggerAutoSSL()` and
  [`app/dashboard/account/create-site.js`](../../app/dashboard/account/create-site.js)
  — fire-and-forget SSL warmups against a user-set domain.

The `featured` scripts run via `docker exec … node app/documentation/featured/build`
inside an app container, so they inherit `BLOT_AIRLOCK_PROXY_URL` — no extra
wiring.

## Deliberately not routed

* [`app/templates/screenshots.js`](../../app/templates/screenshots.js) —
  template-gallery previews, **no** user input (URLs built from `config.host`);
  left on a locally-launched Chromium, don't set `BLOT_AIRLOCK_BROWSER_URL`
  for that job.
* `app/build/plugins/videoEmbeds/{vimeo,youtube}.js`,
  `app/build/plugins/bluesky/index.js`, `app/build/plugins/flickr/index.js`,
  `app/build/plugins/videoEmbeds/bandcamp.js` — fetch a **fixed third-party
  host** (an oEmbed endpoint, or bandcamp.com); only a query string / path is
  user-controlled, not the destination host.
* `app/documentation/build/tools.js` — `link` comes from a repo YAML file at
  doc-build time, not runtime user input.
* [`app/dashboard/site/import/sources/arena/parse.js`](../../app/dashboard/site/import/sources/arena/parse.js)
  — `image.original.url` from the are.na API is pinned to are.na's own image
  hosts (`d2w9rnfcy7mm78.cloudfront.net`, `*.are.na`), so the destination
  host isn't user-controlled. The generic imported-HTML image/PDF
  downloaders (`app/dashboard/site/import/helper/download_{images,pdfs}.js`)
  do fetch arbitrary URLs from imported content and are **not** yet routed
  or pinned — a known gap across all importers.

Treat this as "known", not exhaustive; grep for user-controlled
`fetch`/`request` calls in `app/build` and `app/dashboard` before relying on
it.

## Verifying

Run these against a real deployed unit airlock (`blot-blue-airlock`) (a real host, where
`169.254.169.254` is a real, live metadata service and `10.0.0.1` may well
be a real address on your VPC - unlike in CI, where neither is routable at
all and would "fail" identically whether or not the filter is doing
anything; that's why `build.yml`'s own check tests against a real sibling
container instead, see the "Production" section above). `-f`, not just
`-sS`: a service that answered (even with an error status - IMDSv2 returns
a real 401 to an unauthenticated GET) reached the airlock and got a real
HTTP response, which is a fail, not a "no output" pass:

```sh
# metadata + private ranges are unreachable from inside the container
docker exec blot-blue-airlock sh -c 'curl -fm3 -sS http://169.254.169.254/ ; echo exit=$?'
docker exec blot-blue-airlock sh -c 'curl -fm3 -sS http://10.0.0.1/       ; echo exit=$?'
# the public internet still works
docker exec blot-blue-airlock sh -c 'curl -m5 -sS -o /dev/null -w "%{http_code}\n" https://example.com'
# the proxy path works end to end
docker exec blot-blue-airlock sh -c 'curl -m5 -sS -x http://127.0.0.1:8888 -o /dev/null -w "%{http_code}\n" https://example.com'
# the container's own DevTools endpoint is NOT reachable through the proxy
# (this is the loopback confinement above - it must fail, not return 200,
# and -f matters here too: tinyproxy answers with its own valid HTTP error
# page when it can't reach an upstream, which -sS alone would count as a
# "successful" response)
docker exec blot-blue-airlock sh -c 'curl -fm3 -sS -x http://127.0.0.1:8888 http://127.0.0.1:9221/json/version ; echo exit=$?'
```

The Jasmine spec [`app/build/plugins/linkScreenshot/tests.js`](../../app/build/plugins/linkScreenshot/tests.js)
stubs `helper/screenshot` and asserts, per URL, whether it was called - so it
pins the actual boundary between refused and allowed (including that the
metadata address is deliberately *not* refused at that layer), not just "the
HTML wasn't rewritten," which a plugin that rejected everything would also
satisfy.

**In production**, after a deploy, two different things can go wrong and
they look different in the logs - only one is a security regression:

* **The env vars are missing entirely** (e.g. a stale container from before
  this PR that hasn't been redeployed). `config.airlock.browser_url`/`.proxy`
  are `null`, so the code takes the direct-fetch branch - bookmark
  screenshots and remote-image downloads work, but with **no SSRF
  protection**. `config/index.js`'s startup warning catches this:

  ```sh
  ssh blot "docker logs blot-green 2>&1 | grep 'BLOT_AIRLOCK_BROWSER_URL'"
  ```

* **The env vars are set but the airlock isn't reachable** (most likely the
  unit's airlock is down or unhealthy - `docker ps` for
  `blot-<unit>-airlock`, and the `ensure_airlock` lines in the deploy log).
  This is *not* a security regression - there's no fallback to
  an unprotected fetch, the connection attempt itself just fails - but
  screenshots/downloads on that container fail outright until it's
  redeployed or reconnected. Look for `helper/screenshot`'s own
  `Screenshot failed after retries` log line, or a callback error out of
  `helper/transformer/download` in whatever build step invoked it, rather
  than the config warning above (which won't fire in this case).

## Limitations

* **Only one screenshot at a time per airlock when airlock mode is on.** Chromium deadlocks in `Page.captureScreenshot` if two tabs
  of the *same instance* capture at once - `helper/screenshot`'s own
  Bottleneck limiter already prevents that within one process, but it can't
  stop a unit's node-a and node-b from each independently taking a screenshot
  against the one airlock Chromium at the same time. Fixed with a
  cross-container mutex: a Redis lock keyed by the airlock's URL (the same
  mutex `app/sync` uses for blog folders). It only
  activates when `BLOT_AIRLOCK_BROWSER_URL` is set - in launch mode every
  process has its own private Chromium, so there's nothing to serialize,
  and taking the lock anyway would only add unnecessary contention (a real
  regression for `app/templates/screenshots.js`'s
  `screenshot.configure({ concurrency: N })` batch use, which never sets
  that env var). See `AIRLOCK_LOCK_PATH` in `app/helper/screenshot/index.js`.

* **Always run it on a user-defined Docker network**, never the default
  bridge. On a user-defined network DNS is Docker's embedded resolver at
  `127.0.0.11` (reached over loopback, which the filter allows). On the
  default bridge `/etc/resolv.conf` points at a private address that the
  filter drops, so name resolution fails. Dev compose and the production
  steps above both use a named network.
  * `127.0.0.11` only proxies DNS - it forwards cache misses to the host's
    upstream nameservers, which on a cloud host are themselves at a private
    or link-local address the filter would otherwise reject (on the prod
    EC2 host it's the VPC resolver at `172.30.0.2`). `egress.nft` allows
    **uid 0** (the dockerd-owned forwarding socket) to reach port 53
    anywhere so that forward can complete; untrusted uid 1001 code still
    can't, and still resolves only via `127.0.0.11`. Without that rule
    every lookup inside the container returns `SERVFAIL`.
* `airlock` becomes a build-pipeline dependency: if it's down, bookmark
  screenshots and remote-image transforms fail (they already degrade
  gracefully — the post builds without the image). Give it a restart policy
  and watch the healthcheck.
* **Memory** (`AIRLOCK.memory` in
  [`scripts/deploy/constants.js`](../../scripts/deploy/constants.js)) is
  `512m`, and it's paid for out of the three app containers, not on top of
  them — `~512/3` is taken off each so the host's total is unchanged. `512m`
  held up in testing to three back-to-back full 1200×1200 @2× screenshots
  with no OOM (peak well under the cap, and Chromium released it right
  after) — but a very JS-heavy page could still push higher, so watch
  `docker stats` on the host. Near the cap the container doesn't get
  OOM-killed so much as stall (the kernel evicts code pages until nothing
  answers), the healthcheck times out, and the host's
  [`check_docker_health.sh`](../host/scripts/check_docker_health.sh)
  cron restarts it — 13 times on 6–7 Oct 2026 during entry rebuilds. To keep
  one page from doing that, `entrypoint.sh` caps each renderer's JS heap at
  128m and turns off site isolation so a page's iframes share its renderer;
  the script logs the failing probes before each restart. The app containers can shed some of their
  own overhead — the half of it that covered running Chromium locally — in
  the follow-up PR that drops the Chromium binary from the app image;
  `helper/screenshot`'s `puppeteer.launch()` path (dev and the macOS
  `screenshots.yml` job) still needs it until then.
* The `172.16.0.0/12` drop also stops `airlock` reaching sibling containers on
  a Docker bridge — intended.
* `app/templates/screenshots.js` (the template-gallery build tool) has **no**
  user input and is left on a locally-launched Chromium; don't set
  `BLOT_AIRLOCK_BROWSER_URL` for that job.
* **Chromium/Puppeteer version drift.** `package.json` pins `puppeteer`;
  `alpine:3.24`'s `chromium` apk floats to receive security updates. As of
  2026-10-25, it ships Chromium 155.0.8059.84, matching Puppeteer 25.15.0's
  [supported Chrome version](https://pptr.dev/supported-browsers). The airlock
  GitHub Actions workflow checks the browser major against Puppeteer's target
  and captures a PNG through the nginx DevTools front before publishing the
  manifest. Changes to `package.json` also run that workflow. The image
  records its exact version in `/etc/airlock/chromium-version` and logs it at
  startup. Chromium is in Alpine's `community` repository, whose
  [support ends at the next stable Alpine release](https://alpinelinux.org/releases/);
  update the base image and Puppeteer together when that release ships.
* In production, `config/index.js` only **warns** (`console.warn`, on
  startup) if `BLOT_AIRLOCK_BROWSER_URL` / `BLOT_AIRLOCK_PROXY_URL` are
  unset - it does not refuse to start. A hard startup failure was rejected
  on purpose: a bad deploy or a crashed airlock shouldn't take every app
  container down. Instead the failure is **per operation and fail-closed**:
  `helper/airlock` throws when a user-controlled fetch/screenshot would
  otherwise go direct, so the bookmark screenshot / remote image / domain
  check fails and its caller degrades gracefully, while the rest of the app
  keeps serving. The startup warning is not expected to fire after a clean
  deploy; if it does, the deploy set the vars on some containers but not
  this one (see "Verifying"), and those features are down on it until it is
  redeployed.
