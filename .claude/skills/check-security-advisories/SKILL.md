---
name: check-security-advisories
description: Daily cheap check that no runtime or OS Blot depends on (Node.js, Alpine, OpenResty/nginx, Pandoc, Amazon Linux 2 on the app/proxy host, Amazon Linux 2023 and redis6 on the Redis host, the macserver's Node) is behind on a security release or past end-of-life. Runs scripts/security/check-advisories.js, which reads the version pins from the repo and compares them with nodejs.org, endoflife.date, nginx.org, GitHub and the Amazon Linux security bulletins; only if something is flagged does it verify against official sources, judge real exposure, optionally (with the operator's approval, one command at a time) check what is actually running in production, and propose a pin-bump PR. Designed to be run by a small model or a scheduled routine. Appends a one-line dated entry to this skill's findings log. Use when asked to check security advisories, whether a Node/nginx/OpenResty/Alpine/Amazon Linux security release is out, whether we are behind or end-of-life, or when a third-party email (e.g. from Stripe) says one of our dependencies is vulnerable.
---

# Check security advisories

Goal: hear about a security release or an end-of-life date before a vendor
email tells us. Prompted by the Node.js security release of 2026-10-21
(CVE-2026-111497, Brotli decoder RCE, fixed in 22.23.4 / 24.22.1 / 26.12.1)
that we only learned about from a Stripe email.

This is designed to be cheap: run it daily with a small model (Haiku) or as a
scheduled routine. The script does all the fetching and comparing; the model
only reads a short report. Most days the answer is "all clear" and you stop
after step 1.

## Step 1: run the script

```bash
node scripts/security/check-advisories.js            # report
node scripts/security/check-advisories.js --json     # machine output
node scripts/security/check-advisories.js --days 7 --npm --dependabot
```

It reads the pins from `Dockerfile` (Node, Pandoc), `proxy/Dockerfile`
(OpenResty, nginx) and `config/airlock/Dockerfile` (Alpine), fetches public
sources (each independently, 15s timeout; a failure shows as "source
unavailable" and the rest continue), and prints three sections: **ACTION
NEEDED**, **WATCH**, **OK**. Exit code 1 if anything is in ACTION NEEDED.
`--days N` widens the Amazon Linux bulletin window (default 2; use 7 after a
gap in daily runs). `--npm` adds `npm audit --omit=dev`; `--dependabot` adds
open Dependabot alerts via `gh`.

What it covers: Node (security releases newer than the pin, EOL), Alpine EOL,
Amazon Linux 2 / 2023 EOL and recent critical/important bulletins (watched
packages: kernel, docker, containerd, runc, openssh, openssl, glibc, sudo,
redis6, systemd, curl), nginx advisories against the pinned nginx version,
newest OpenResty tag, newest Pandoc. The Redis host (AL2023 + `redis6`, see
`config/redis/host/setup.sh`) is not version-pinned, so only the bulletin feed
covers it.

Compare with the last findings-log entry. If exit code is 0 **and** WATCH has
nothing new, append a one-line "all clear" entry and stop.

Known standing items (so they don't count as "new"): nginx advisories listed
against the OpenResty-bundled nginx (the report says "check whether the bundle
is patched": judge, don't just bump), the OpenResty/Pandoc/Alpine versions
trailing the newest release, and anything already noted in the log.

## Step 2: verify and judge (only if flagged)

Verify against the official source, never a third-party email or its links:

- Node: https://nodejs.org/en/blog/vulnerability/
- nginx: https://nginx.org/en/security_advisories.html
- OpenResty: https://openresty.org/en/ (release notes) and the GitHub tags
- Amazon Linux: https://alas.aws.amazon.com/ (open the bulletin linked in the report)

Then judge actual exposure for Blot:

- **Node app containers** fetch untrusted URLs with global `fetch`, which
  decodes `br`/`gzip` responses, so decoder bugs (zlib/Brotli) are reachable
  from attacker-controlled servers. HTTP/TLS/crypto/permission-model bugs
  depend on what the app uses; read the advisory's affected-API list.
- **OpenResty** is the internet-facing edge: nginx core and module advisories
  matter if we compile the module in or use the feature (HTTP/3, AIO, alias +
  rewrite, ...). Check `proxy/config/` before deciding a "Vulnerable" range is
  a real hit.
- **App/proxy host** (Amazon Linux 2): kernel, docker, containerd, runc,
  openssh, sudo, glibc. Host patching is manual (see below).
- **Redis host** (AL2023): not internet-facing; kernel/redis6/openssl matter
  less, but patch on the normal cadence.
- **macserver** runs Node under pm2 on a Mac, outside the repo pins; it has
  its own Node version (`ssh macserver "node -v"`) and needs its own bump.

## Step 3: what is actually running (optional, production)

Only to confirm a flagged item. **Ask the operator before every production
command, even read-only, stating the exact command; an earlier approval does
not cover the next one.** If auto mode blocks an ssh read, give the operator
the command to paste instead of retrying. Keep any output with addresses in
the terminal only.

```bash
ssh blot "docker exec blot-green node -v"     # and blot-blue
ssh blot "cat /etc/os-release; uname -r; docker version --format '{{.Server.Version}}'"
ssh blot "docker ps --format '{{.Names}}'"              # the proxies are blot-blue and blot-green
ssh blot "docker exec blot-blue openresty -v"           # and blot-green
ssh redis "cat /etc/os-release; redis6-server --version; dnf -q check-update --security | head"
ssh macserver "node -v; sw_vers"
```

## Step 4: what to do

- **Runtime pin bump**: open a PR bumping the pin everywhere it lives:
  `Dockerfile`, `proxy/Dockerfile` (OpenResty/nginx ARGs, with the new
  `OPENRESTY_SHA256`), `config/airlock/Dockerfile`, the `node-version` pins in
  `.github/workflows/*.yml`, `BLOT_NODE_VERSION` in `config/environment.sh`,
  and `config/node/scripts/setup-ec2-user.sh`. Follow the PR rules in
  `CLAUDE.md`: if hosts or the macserver need manual steps (re-run Node setup
  on the host, `npm i -g`/nvm on the macserver, deploying the proxy), add a
  **Deployment plan** section and the `manual-deploy` label.
- **Host OS patches** (AL2/AL2023 `yum`/`dnf update`, reboot for a kernel) are
  manual and need the operator's approval for each command; see
  `config/host/README.md` and `.claude/skills/redis-host/SKILL.md`.
- **EOL**: put a compact line in the root `TODO` and tell the operator. Amazon
  Linux 2 and Alpine 3.20 are already past EOL; migrations are tracked there,
  not re-raised daily.
- Third-party "your X is vulnerable" emails (Stripe, etc.): never follow their
  links; verify with the official sources above and treat the email only as a
  prompt to run this skill.
- **Privacy**: this repo is public. Never put IPs, instance IDs or infra size
  numbers in the findings log.

## Findings log

Newest last. One short dated line per run; fuller entry when something was
flagged. Public repo: no IPs, instance IDs, account IDs or infra sizes.

- 2026-10-23: Node 22.23.4 security release (CVE-2026-111497, Brotli decoder
  RCE) reported to us via a Stripe email, not by us; prod image pinned from
  floating `node:22-alpine` to `22.23.4`. First script run: Node pin is the
  latest 22.x, Node 22 EOL 2027-04-30. ACTION NEEDED: Amazon Linux 2 (EOL
  2026-06-30, app/proxy host) and Alpine 3.20 (EOL 2026-04-01, airlock image)
  are past end-of-life. WATCH: Pandoc 3.6.1 behind 3.12.x, OpenResty 1.25.3.1
  behind 1.31.x, nginx 1.25.3 inside many advisory ranges (needs judgment
  against the OpenResty bundle and enabled modules). No watched-package
  critical/important bulletins in the 2-day window.
