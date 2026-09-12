---
name: nginx-log-review
description: Review recent production nginx/openresty access logs, identify scanner/exploit traffic not already blocked, and update config/openresty/conf/blot-blogs.conf accordingly. Use when asked to analyze prod nginx/access logs, find new paths to block, or audit openresty for scanner traffic.
---

# Nginx access log review → openresty blocklist update

This skill reproduces the workflow used in PR #1821 / issue #1822: pull real
production traffic, find scanner/exploit patterns that are falling through
existing rules, add narrowly-scoped blocks, and flag anything found that
isn't a block (e.g. app-level bugs inflating cache misses) as a separate
GitHub issue instead of bundling it into the openresty change.

## 1. Get the logs

SSH host is `blot` (production EC2 box, configured in `~/.ssh/config`).
Openresty access logs live at `/var/instance-ssd/logs/access.log` (current)
and `/var/instance-ssd/logs/access.log-YYYYMMDD` (yesterday's rotated file).
Combine both for a full ~24-48h window:

```bash
ssh blot "cat /var/instance-ssd/logs/access.log-$(date -d yesterday +%Y%m%d) /var/instance-ssd/logs/access.log > /tmp/combined_access.log; wc -l /tmp/combined_access.log"
```

Log line format (space-separated, so `cut -d ' ' -fN` / `awk '{print $N}'` work):

```
[time] request_id status request_time bytes_in:bytes_out url  cache=X ip=X st=X lrs=X ua=X
   1        2         3      4              5             6      (7 is empty due to double space before cache=)
```

Concretely: `$4` = status code, `$7` = full URL (scheme+host+path+query),
`ip=`, `ua=`, `cache=` are grep/`grep -oE` targets, not fixed fields.

**Always confirm with the user before running anything against production**,
and stick to read-only commands. Clean up `/tmp/combined_access.log` on the
remote host when done (`ssh blot "rm -f /tmp/combined_access.log"`).

## 2. Aggregate

Status code breakdown:

```bash
ssh blot "awk '{print \$4}' /tmp/combined_access.log | sort | uniq -c | sort -rn"
```

Top 404/403/444 paths (strip domain and query string so variants collapse):

```bash
ssh blot "grep ' 404 ' /tmp/combined_access.log | cut -d ' ' -f7 | sed -E 's|https?://[^/]+||' | sed -E 's/\?.*//' | sort | uniq -c | sort -rn | head -100"
```

Repeat for ` 403 ` and ` 444 ` to see what's already being caught (444s are
already blocked with a fast fail2ban ban; don't re-block those).

Check whether the traffic is IP-concentrated or diffuse — if a domain is
proxied through Cloudflare, `ip=` will be CF edge IPs, not the real client,
which makes IP/fail2ban blocking useless and confirms **path-based
blocking at the openresty layer is the right lever**:

```bash
ssh blot "grep -oE 'ip=[0-9.]+' /tmp/combined_access.log | sort | uniq -c | sort -rn | head -15"
```

## 3. Diff against existing blocks

Read the current rules before proposing new ones — don't duplicate or
narrow what's already covered:

- `config/openresty/conf/blot-blogs.conf` — path/extension-based `location`
  blocks (`.env`, `.git`, wp-*, php extensions, sensitive JSON files, etc.)
  This is the file that's actually deployed to production (see
  `proxy/README.md` — `proxy/` is a separate work-in-progress
  containerization fork, **not yet wired to production**; don't edit it for
  a live-traffic fix).
- `config/openresty/conf/server.conf` — the `$bad_bot` user-agent map
  (`restrict-bot-uas.conf` returns 403 for matches). Scanner traffic
  usually spoofs a real browser UA, so this rarely helps for the paths
  found here — check `ua=` values for the offending paths before assuming
  a UA-based rule would work.
- `config/openresty/fail2ban/jail.local` — IP-banning jails keyed off
  404/403/429/444 rates. Complementary to path blocks, not a substitute.

For each candidate pattern, grep its current count and check whether it's
already caught by an existing regex (e.g. anything ending in `.php` is
already 403'd by the generic extension rule — no need for a `shell.php`-
specific rule).

## 4. Identify unambiguously blockable patterns

A pattern is safe to add only if it has **no plausible legitimate use** on
a Blot blog. Before adding any pattern, sample its actual matched URLs and
check for false positives — a substring that's too generic will catch real
blog content:

```bash
ssh blot "grep -E 'PATTERN' /tmp/combined_access.log | cut -d ' ' -f7 | sort | uniq -c | sort -rn | head -15"
```

Known trap from prior review: a bare `geoserver` substring match caught a
real blog's post slugs (`/geoserver-1-7-2-continues-improvements...`) —
had to anchor to `^/geoserver/` instead. Apply the same scrutiny to any
short/generic word (`passwd`, `cmd=`, `admin`, `login`, `console`, `info`,
`about`, `proxy`) — these are common real blog paths/slugs and should
generally NOT be blocked outright.

Categories worth checking each time (volumes shift, but these have
recurred): `.env` in any position (not just as a suffix — scanners try
hundreds of prefix/suffix permutations), `.git` anywhere in the path,
`/@fs/` and `/proc/self/` (dev-server/path-traversal probes), cloud
credential/key JSON filenames (`service-account.json`,
`firebase-adminsdk.json`, `gcp-*`, `application_default_credentials.json`),
SSH keys / `.npmrc` / `.htpasswd` / `.s3cfg` / `terraform.tfstate` /
`.dockerenv`, `.svn/`, Spring Boot `/actuator/`, `phpinfo` in any form,
Kubernetes serviceaccount tokens, and CVE-specific RCE probe paths
(`/_ignition/`, `/geoserver/`, etc. — check what's currently trending).

## 5. Update the openresty config

Edit `config/openresty/conf/blot-blogs.conf`. Follow the existing
convention in that file:

- `return 444;` for requests that are **clearly malicious** (faster
  fail2ban ban than a 403 — see the comment at the top of the file's
  block-rules section).
- `return 403 '403';` for requests that are only **plausibly** malicious.
- Every block includes `limit_req zone=bots;` before the return.
- Add new broad/generic rules near the top of the file and specific
  exact-path rules can stay further down — nginx evaluates regex
  `location` blocks in file order and stops at the first match, so a broad
  rule placed early will shadow (and can make redundant) a narrower rule
  for the same pattern later in the file. Remove any rule that becomes
  fully shadowed rather than leaving dead code.

## 6. Validate

There's no local nginx/openresty binary and the full mustache-based build
needs network access (fetches BunnyCDN IPs) and repo secrets, so don't try
to run the real build pipeline locally. Instead, sanity-check just the new
`location` block syntax against a real openresty binary in Docker:

```bash
docker run --rm -v /path/to/snippet-nginx.conf:/etc/nginx/nginx.conf:ro \
  openresty/openresty:alpine openresty -t
```

Wrap the new/changed `location { ... }` blocks in a minimal
`events{} http { limit_req_zone $binary_remote_addr zone=bots:10m rate=1r/s; server { listen 8080; ...; location / { return 200; } } }`
skeleton for this check. This catches syntax errors but not deployment
behavior — the repo's `proxy` GitHub Actions workflow (a separate,
not-yet-production fork) does full build+boot validation; per this
project's convention, prefer letting GitHub CI do heavier validation over
elaborate local Docker setups.

## 7. Ship it

- Commit only `config/openresty/conf/blot-blogs.conf` (and this skill file
  if it's being updated).
- Push a branch and open a PR. In the PR description: state the log window
  analyzed, a table of pattern → approximate daily request count, note
  which existing rules already covered adjacent cases (so reviewers see
  what's genuinely new), call out any false-positive traps you checked for
  and how the regex was anchored to avoid them, and confirm whether
  IP-based blocking would or wouldn't help (Cloudflare-fronted domains
  usually mean it wouldn't).
- If the log review surfaces something that **isn't** an openresty block —
  e.g. an app/template bug generating a pathological amount of traffic, a
  slow endpoint, a caching gap — don't fold it into the openresty PR. File
  it as a separate `gh issue create`, referencing the PR for the
  underlying data.
