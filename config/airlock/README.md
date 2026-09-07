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

`airlock` itself only ever holds a rendered screenshot or a downloaded asset
in `/tmp` and `/home/airlock/profile` — no secrets, no data mount, no cloud
identity.

## Configuration (the app side)

`config/index.js` reads two env vars; both unset ⇒ the app fetches directly
with **no SSRF protection** (fine for local dev; production sets both real
values, see "Production" below):

| Env var | Example | Used by |
| --- | --- | --- |
| `BLOT_AIRLOCK_BROWSER_URL` | `http://airlock:9222` | `app/helper/screenshot` |
| `BLOT_AIRLOCK_PROXY_URL` | `http://airlock:8888` | `app/helper/transformer/download` |

## Local development

Wired into [`scripts/development/docker-compose.yml`](../../scripts/development/docker-compose.yml)
as the `airlock` service, with the two env vars set on `node-app`. Just:

```
docker compose -f scripts/development/docker-compose.yml up
```

Comment out the two `BLOT_AIRLOCK_*` lines to bypass it.

## Rollout history

This landed in two PRs on purpose, so a mistake in the (untestable-without-a-
real-host) deploy plumbing couldn't take down blue/green/yellow:

* **The infrastructure PR** built and deployed the `airlock`
  image/container/network in production and connected the app containers to
  it, but didn't route any real traffic through it yet -
  `helper/screenshot`/`helper/transformer/download` still fetched directly.
  A temporary post-boot probe (`app/helper/airlock/probe.js`, since deleted)
  opened a real connection to the deployed airlock, took a real screenshot
  through it, made a real fetch through its proxy, and confirmed the
  metadata address was blocked on both paths - logging the result so a few
  days of production deploys gave a real signal, not just a local one,
  before anything depended on it.
* **This PR is the cutover**, made once that probe had been green in
  production for a while: `generateDockerCommand.js` now sets the real
  `BLOT_AIRLOCK_BROWSER_URL`/`BLOT_AIRLOCK_PROXY_URL` (mechanically the same
  way the temporary `BLOT_AIRLOCK_PROBE_*` vars were set before), and the
  probe module, its call site in `app/setup.js`, and `config.airlockProbe`
  are gone. Nothing about the airlock container or network itself changed
  for this PR.

## Production (implemented in `scripts/deploy`)

Everything below already runs as part of `npm run deploy-node` (see
[`scripts/deploy/index.js`](../../scripts/deploy/index.js),
[`constants.js`](../../scripts/deploy/constants.js) and
[`generateAirlockCommand.js`](../../scripts/deploy/util/generateAirlockCommand.js)).
Every step is **non-fatal to the app deploy**: a problem deploying or
connecting the airlock is logged but never fails, blocks, or rolls back
blue/green/yellow - see the comment above `deployAirlockIfNeeded` in
`index.js`. The airlock itself *does* get rolled back on a bad deploy (see
step 2) - "non-fatal" only ever means "can't take the app deploy down with
it".

1. **Build & push.** `.github/workflows/build.yml` has a second matrix job,
   `build-airlock`, alongside the app's `build` job: builds `config/airlock`
   per-arch, pushes `ghcr.io/davidmerfield/blot-airlock:<sha>-<arch>`, then
   `manifest-airlock` creates the multi-arch `<sha>` (and `latest` on
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
   for the target commit before deploying anything - not just the app
   one. `deployAirlockIfNeeded()` treats a missing airlock manifest as a
   non-fatal skip *for that run*, and nothing else ever retries it, so
   deploying while `build-airlock` is still running (or has failed on its
   own) would otherwise ship the app image for a commit whose airlock
   update silently never happened.

2. **Network + sidecar.** `deployAirlockIfNeeded()` runs before the
   blue/green/yellow loop: creates the `blotnet` Docker network if it
   doesn't exist, and pulls/(re)starts `blot-airlock` if it isn't already
   running the target commit's image **and** healthy - both conditions, not
   just the image tag, since a container that's merely present with the
   right tag but stopped or wedged unhealthy would otherwise be mistaken
   for "already deployed" and left broken until some later commit happened
   to change the tag. If deploying the new image fails (bad build, failed
   health check), it rolls back to whatever image was running before -
   mirroring the rollback `main()` already does for blue/green/yellow, so a
   bad airlock build can't leave nothing running at all.

3. **Connecting app containers.** Deliberately **not** `--network blotnet`
   on the app containers at creation - that would move them off the default
   `bridge` network entirely, changing their gateway from `172.17.0.1` to
   `blotnet`'s gateway, which could silently break a hardcoded
   `BLOT_REDIS_HOST` or `BLOT_REVERSE_PROXY_URLS` on the live host (neither
   is visible from this repo). Instead, after each app container starts (or
   is confirmed already up to date), `connectToAirlockNetwork()` checks
   `blotnet`'s membership first and only runs `docker network connect
   blotnet <container>` if it isn't already a member - Docker's supported
   way to give a running container a *second* network interface. Checking
   membership first (rather than attempting the connect and swallowing
   "already exists" with `|| true`) means a genuine attach failure - a
   missing network, a renamed container - surfaces in the deploy log
   instead of looking identical to success. The container keeps its
   original bridge network and gateway untouched, and gains the ability to
   resolve and reach `blot-airlock` via `blotnet`'s embedded DNS.
   `generateDockerCommand.js` sets `BLOT_AIRLOCK_BROWSER_URL` /
   `BLOT_AIRLOCK_PROXY_URL` to `http://blot-airlock:9222` / `:8888` on
   every app container - see "Configuration" above.

4. **Harden the instance metadata service** while you're here — defence in
   depth for any other fetch in the app, independent of all of this:

   ```sh
   aws ec2 modify-instance-metadata-options --instance-id i-xxxx \
     --http-tokens required --http-put-response-hop-limit 1 --http-endpoint enabled
   ```

## Known sinks not covered

Besides [`app/templates/screenshots.js`](../../app/templates/screenshots.js)
(template-gallery previews - **no** user input, its URLs are built entirely
from `config.host`; deliberately left on a locally-launched Chromium, don't
set `BLOT_AIRLOCK_BROWSER_URL` for that job), two more places take a
user-controlled hostname and fetch it from the app container, not routed
through `airlock`:

* [`app/dashboard/site/domain/verify.js`](../../app/dashboard/site/domain/verify.js)
  — a hostname the user typed into the dashboard, `fetch("http://" + hostname + "/verify/domain-setup")`.
* [`app/documentation/featured/verifySiteIsOnline.js`](../../app/documentation/featured/verifySiteIsOnline.js)
  — same shape, `https://<host>/verify/domain-setup`.

Both are **blind**: the response body is compared against the blog's handle,
never echoed back to the user, so they're not a read primitive the way
`linkScreenshot` and `transformer/download` are. They can still reach an
internal address from a user-supplied hostname, though, so routing them
through `airlock`'s proxy is worth doing - just not done in this PR. Treat
this list as "known and accepted for now," not exhaustive; grep for
user-controlled `fetch`/`request` calls in `app/build` and `app/dashboard`
before relying on it.

## Verifying

Run these against a real deployed `blot-airlock` (a real host, where
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
docker exec blot-airlock sh -c 'curl -fm3 -sS http://169.254.169.254/ ; echo exit=$?'
docker exec blot-airlock sh -c 'curl -fm3 -sS http://10.0.0.1/       ; echo exit=$?'
# the public internet still works
docker exec blot-airlock sh -c 'curl -m5 -sS -o /dev/null -w "%{http_code}\n" https://example.com'
# the proxy path works end to end
docker exec blot-airlock sh -c 'curl -m5 -sS -x http://127.0.0.1:8888 -o /dev/null -w "%{http_code}\n" https://example.com'
# the container's own DevTools endpoint is NOT reachable through the proxy
# (this is the loopback confinement above - it must fail, not return 200,
# and -f matters here too: tinyproxy answers with its own valid HTTP error
# page when it can't reach an upstream, which -sS alone would count as a
# "successful" response)
docker exec blot-airlock sh -c 'curl -fm3 -sS -x http://127.0.0.1:8888 http://127.0.0.1:9221/json/version ; echo exit=$?'
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
  ssh blot "docker logs blot-container-green 2>&1 | grep 'BLOT_AIRLOCK_BROWSER_URL'"
  ```

* **The env vars are set but the airlock isn't reachable** (most likely
  `docker network connect blotnet <container>` didn't happen or didn't take
  for that container - check the `Connecting … to blotnet` line in the
  deploy log). This is *not* a security regression - there's no fallback to
  an unprotected fetch, the connection attempt itself just fails - but
  screenshots/downloads on that container fail outright until it's
  redeployed or reconnected. Look for `helper/screenshot`'s own
  `Screenshot failed after retries` log line, or a callback error out of
  `helper/transformer/download` in whatever build step invoked it, rather
  than the config warning above (which won't fire in this case).

## Limitations

* **Only one screenshot at a time, across the whole fleet, when airlock
  mode is on.** Chromium deadlocks in `Page.captureScreenshot` if two tabs
  of the *same instance* capture at once - `helper/screenshot`'s own
  Bottleneck limiter already prevents that within one process, but it can't
  stop blue, green and yellow from each independently taking a screenshot
  against the one shared airlock Chromium at the same time. Fixed with a
  cross-container mutex: a `proper-lockfile` lock on a file in the data
  directory every container already mounts (the same dependency/mechanism
  `app/sync` already uses to coordinate across containers). It only
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
  `docker stats` on the host. The app containers can shed some of their
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
  `alpine:3.20`'s `chromium` apk floats with the base image and is a
  different release train. The Dockerfile records the version it shipped
  with in `/etc/airlock/chromium-version` (also logged at container start)
  precisely so a drift shows up there before it shows up as bookmark
  screenshots silently failing in production after an image rebuild.
* In production, `config/index.js` only **warns** (`console.warn`, on
  startup) if `BLOT_AIRLOCK_BROWSER_URL` / `BLOT_AIRLOCK_PROXY_URL` are
  unset - it does not refuse to start. After this PR the warning is *not*
  expected to fire; if it does, the deploy set the vars on some containers
  but not this one (see "Verifying" above). A hard failure was rejected on
  purpose: a bad deploy or a crashed airlock shouldn't be able to take every
  app container
  down over a feature this size - if you do tighten it, make it fail closed
  only after confirming the airlock, not unconditionally.
