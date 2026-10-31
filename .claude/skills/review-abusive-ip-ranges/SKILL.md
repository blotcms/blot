---
name: review-abusive-ip-ranges
description: Analyze the production openresty access log for IP ranges (IPv4 /24, IPv6 /48) that cost a lot of egress and are broadly abusive (scraping with rotating user agents, repeat scanning, hammering the CDN hostname), set aside CDN edges and legitimate crawlers, classify the candidates, and recommend ranges for the permanent manual-permaban fail2ban jail. Bans only with the operator's go-ahead, one command at a time. Appends a short, IP-free entry to this skill's findings log. Use when asked to look for abusive ranges or scrapers, review egress by client, find IPs to permaban, or re-run the range review.
---

# Review abusive IP ranges

Goal: find the few ranges that cost real egress *and* behave abusively, and
permanently ban them in the `manual-permaban` fail2ban jail
(`config/host/README.md`, "Permanent bans"). Not a bytes threshold and not a
hunt for every bot: someone running `curl` against a few blogs, a feed
reader, a search crawler that sends readers our way, or a person on a
residential connection is not a target. A range qualifies when **egress is
large and the behaviour is abusive** (see Criteria).

Egress context: issue #2107. A full TLS handshake alone is ~5 KB, and
`manual-permaban` drops packets in the kernel, so a banned range costs nothing
more. The proxy already 403s a long list of user agents (`$bad_bot` in
`proxy/config/server.conf`), rate-limits per IP (`limit_req`, 6 r/s) and bans
scanners that earn three 444s for an hour (`proxy/config/ban.lua`) and 30-60
minutes in the `nginx-*` jails. This skill is for what those miss: slow,
high-volume, rotating-user-agent scrapers, and ranges that scan on a long
cycle.

## Production access and privacy

Host `ssh blot`. **Ask the operator before every production command**,
quoting the exact command and saying whether it is read-only, and wait for a
yes. An earlier broad approval does not cover a later command. Everything
until the ban step is read-only (log reads, `fail2ban-client status`). The ban
(`banip`) and any `unbanip` change production.

**The output holds client IPs and hostnames. Keep it in the terminal and chat
only.** The repo, issues and PRs are public: never write an IP, range,
hostname or customer domain to a file in the repo, an issue, a PR or this
skill's findings log. Scratch copies of the access log go in the session
scratchpad and get deleted afterwards. The ranges themselves live only in
fail2ban's database on the host.

## Method

### 1. Pull the log

Logs are in `/var/instance-ssd/logs/`. `access.log` is the current day;
rotation (~03:24 UTC) leaves `access.log-YYYYMMDD` for the day before the
date in its name (the file named for the 22nd holds the 21st), uncompressed
for yesterday and `.gz` for older days. Use whole days: a partial day skews
shares.

```bash
S=<scratchpad>
ssh blot "ls -la /var/instance-ssd/logs/"
ssh blot "gzip -c /var/instance-ssd/logs/access.log-<YYYYMMDD>" > $S/day1.gz
```

(`gzip: file size changed` is harmless on the live log.) Two or three days is
better than one: abuse that comes and goes shows up across days, a one-day
spike doesn't. Log format is in
`.claude/skills/investigate-slow-upstream-responses/SKILL.md`; the field that
matters here is `<req>:<bytes>` (bytes sent), plus `ip=`, `cache=`, `ua=`.

### 2. Rank the ranges

```bash
node .claude/skills/review-abusive-ip-ranges/ranges.js $S/day1.gz [$S/day2.gz …] --top 20
```

It groups by IPv4 /24 and IPv6 /48 and prints, per range: MB and share of the
log, requests, average KB, distinct IPs / user agents / hosts, and the % of
requests that were 200/206, 404, blocked (403/429/444) and cache HITs. Two
tables: by bytes, and by 404/blocked count (repeat scanning). Then user
agents, hosts and paths for the top six by bytes.

It sets aside private addresses and the Bunny CDN edge list
(`proxy/build/data/latest/cdn-ips.conf`; run
`FETCH_CDN_IPS=true bash proxy/build/build.sh` first if that file is missing
or stale, or pass `--cdn-ips <file>`). The proxy never rate-limits or bans
those, and neither should you. If a top range is a CDN edge the list missed,
you'll see it in the classification step below.

### 3. Classify each candidate

For each range in the top few by bytes, and each in the scanning table with a
large share of blocked/404 responses:

1. **Who owns it.** `whois <ip> | grep -iE 'netname|orgname|descr|country'`.
   Hosting, VPS, proxy and datacenter providers are the usual abusers;
   residential ISPs usually mean a person; a CDN or cloud edge that pulls from
   us is not a scraper.
2. **What does it fetch?** Hosts and paths from the detail block. The CDN
   hostname (`cdn.blot.im`, folder files) and large media/zip/PDF are where
   egress goes; many different blog hosts means a crawler, one host means a
   fan or an owner.
3. **How does it identify itself?** Many distinct user agents from one range,
   bare `Mozilla/5.0`, fake Googlebot/Baiduspider/browsers, or old/impossible
   browser versions mean evasion. One honest user agent that fits the range
   (a named crawler on its operator's network) is different.
4. **Verify claimed crawlers.** Googlebot, Bingbot, Applebot and the like are
   confirmed by reverse DNS (`host <ip>` then forward-resolve the name), not
   by user agent. A "Googlebot" outside Google's network is a fake and counts
   *against* the range.
5. **Is it all the range?** `ranges.js` shows distinct IPs and user agents.
   If the traffic is from one address in a /24 that also carries ordinary
   browsing to normal blog pages, ban the single address, not the /24.
6. **Is it already handled?** Check the current jail before recommending:
   `ssh blot 'sudo fail2ban-client status manual-permaban'`. If a range there
   still appears in the log, the ban isn't working (wrong chain, Cloudflare in
   front of the client, an IPv6 range) and that is the finding.

### Criteria

Recommend a permanent ban when the range is **a hosting/datacenter/proxy
network** (or otherwise clearly not people) **and** at least two of:

- a large share of egress (rule of thumb: ≥2% of the log's bytes in a day, or
  tens of MB per day sustained across days, from one range);
- rotating or spoofed user agents (many UAs, fake crawlers, bare
  `Mozilla/5.0`);
- mostly 404s and probes, or sweeping across many files/hosts;
- no sign of a human (no cache HITs on ordinary pages, no referrers, no
  mixed ordinary browsing);
- it recurs across days.

Do **not** recommend a ban for:

- CDN edges (Bunny, Cloudflare, CDN77, Fastly…), the macserver, private and
  loopback ranges, or anything in `cdn-ips.conf`;
- verified search and social crawlers that send readers or previews
  (Google, Bing, Apple, Meta and the like): cap them with a block on the user
  agent only if the operator decides they cost more than they return;
- residential and small-ISP ranges unless the behaviour is plainly abusive;
  someone's own script (curl, feed polling, uptime probes against their own
  site) is the case this skill must leave alone. Mention it as "leave alone";
- a range you only saw for one short burst.

A UA-only bad actor (a monitoring probe, a named crawler) is a different
fix (`$bad_bot` or a rate limit in `proxy/config/`), not a range ban. Note it
for the operator.

### 4. Report and ban

Report in chat (IPs are fine in chat): window, the top ranges with owner,
share of egress, what they fetch, how they identify, a verdict per range
(ban / leave alone / UA fix) and why. Say what the total bandwidth saving
would be (sum of the banned ranges' share).

If the operator agrees to a ban, show the exact commands and wait for a yes
before running them:

```bash
ssh blot 'sudo fail2ban-client set manual-permaban banip <range>'
ssh blot 'sudo fail2ban-client status manual-permaban && sudo iptables -S | grep manual-permaban'
```

A /24 (`a.b.c.0/24`), an IPv6 /48, or a single address all work as the
argument. Unban with `unbanip`. Bans persist across fail2ban restarts
(`dbpurgeage` is set long in `config/host/fail2ban/fail2ban.local`, and the
jail turns off ban-time increment); this was not true before that fix, when a
restart ended a ban a week after it was added. Only
restart fail2ban to test that if the operator asks. Moving hosts: see "Moving
to a new host" in `config/host/README.md`.

### 5. Follow up

The next time the skill runs, check the earlier bans worked: a banned range
should have (near) zero requests in a new day's log. Re-running step 2 on a
fresh log is the check. If there are still requests, the packets are getting
through (check the iptables rules, and for Cloudflare-fronted traffic the
real client IP is only visible in the log, not at the TCP layer: that needs a
different block).

Then append an entry to the findings log and delete scratch copies of the
logs.

## Findings log

Read this first: a recorded outcome tells you what has been tried and what
shares looked like before. Newest last.

**Privacy: this file is committed to a public repo.** No IP addresses, ranges,
hostnames, domains, customer or blog information. Describe ranges generically
("a hosting-provider /24 scraping the CDN hostname with rotating user
agents"), give shares of the log's egress and request counts rather than raw
sizes, and record the action ("1 range banned"), never the range. Keep out
userbase and infrastructure size numbers; percentages are fine.

Entry template:

```
### <date> — <days of log reviewed>
- Headline: <largest range's share of egress>; <how many ranges recommended / banned / left alone>
- <class of range>: <what it fetched, how it identified itself, share> — <verdict>
- Checked earlier bans: <still seeing requests? how many>
- Follow-up: …
```

### 2026-10-22 — one day of log (skill created)

- Headline: one hosting-provider /24 was ~19% of logged bytes, nearly all of
  it from the CDN hostname: a few hundred 200s of large folder files and
  thousands of 404s, rotating between curl, bare `Mozilla/5.0` and fake
  Baiduspider/Googlebot-Image user agents. Banned (1 range, permanent).
- Three of the next four ranges were CDN edges already in the allowlist
  (origin pulls, not scrapers): left alone.
- A residential-ISP range ran `curl` against one blog ~3k times a day (~2% of
  bytes): an owner's own script. Left alone, as the case this skill must not
  catch.
- A cloud monitoring probe hit one custom-domain homepage every ~35s (~3%):
  a user-agent matter, not a range ban. Left alone for now.
- The `$bad_bot` 403s are working: a blocked crawler's thousands of requests
  cost almost nothing. Its remaining bytes arrived through the banned range
  under spoofed user agents.
