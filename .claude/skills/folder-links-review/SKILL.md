---
name: folder-links-review
description: Review what Blot's request-time folder-link rewrite (app/blog/render/replaceFolderLinks) still does in production, from the [folder-links] and [folder-asset] log lines (older logs have [folder-asset-origin] instead), to decide what has to move to entry build time or template save time before the runtime pass can be deleted. Pulls the app container logs over ssh, aggregates them with scripts/folder-links/analyze-logs.js, maps each finding to the next piece of migration work, and appends a short entry to this skill's findings log. Use when asked to review folder links, check progress on removing replaceFolderLinks, or re-run the folder-link log analysis.
---

# Folder-link rewrite review

## Background

`app/blog/render/middleware.js` runs `replaceFolderLinks/html.js` (HTML
views) and `replaceFolderLinks/css.js` (CSS views) over every rendered page,
rewriting links to files in the blog's folder into versioned CDN URLs with a
disk lookup (`lookupFile.js`). The goal is to delete that pass and do the
work earlier instead:

- **Entries:** already baked at build time by
  `app/build/plugins/folderAssets` (#1896), with `%%BLOT_CDN%%` tokens.
- **Templates:** to be baked when a view is saved (`Template.setView`).

The pass is instrumented ([#2032](https://github.com/blotcms/blot/pull/2032))
so production traffic tells us what it still rewrites. Two `req.log` lines:

```
[folder-links] blog=<id> handle=<h> template=<id> view=<name> kind=html|css rewrites=N enoent=N ms=N sources=template:2,entry:1 forms=root:2,relative:1 sample=ok:template:root:/a.jpg,enoent:entry:relative:b.jpg
[folder-asset] blog=<id> handle=<h> served=origin|cdn-redirect|static path=<path> referer=<host><path>|-|invalid same_site=1|0
```

- `[folder-links]`: one per request where the pass rewrote a link or found
  no file for one. Format documented in `replaceFolderLinks/stats.js`.
- `[folder-asset]`: every blog-folder file (not an HTML page) the app
  serves, whatever the Referer. `served=origin` was sent by the app,
  `served=cdn-redirect` was a large file 302'd to the CDN (so it still cost
  an origin request), and `served=static` is one of Blot's own global files
  (`/fonts`, `/katex`, …). `same_site=1` means the Referer is one of the
  blog's own hosts, i.e. a link on the blog's pages reached the origin
  instead of the CDN. Logged by `app/blog/routes/assets.js`. It replaces
  `[folder-asset-origin]` (`blog= handle= path= referer_path=`, same-site
  origin responses only); `analyze-logs.js` still reads the old line as
  `served=origin same_site=1`, for logs from before it shipped.

Field meanings:

- `source`: where the original link text was found.
  - `template`: the view or partial source.
  - `entry`: `entry.html` of an entry on the page.
  - `metadata`: an entry's metadata.
  - `other`: none of those, e.g. menu URLs, template locals, or links
    assembled from variables like `{{blog.url}}/x.jpg`.
  - Partials pulled in from the folder (`{{> /file.html}}`) count as
    `template`.
- `form`:
  - `root`: starts with `/`.
  - `relative`: no leading slash. These break if the pass is removed,
    because browsers resolve them against the page URL.
  - `host`: an absolute URL on one of the blog's own hosts.
  - `static`: a reserved global path (`/fonts`, `/katex`…).

Removing the pass is safe for `root`, `host` and `static` links in the sense
that `app/blog/routes/assets.js` still serves them from the origin. The page
only loses CDN caching for those files. `relative` links are the
correctness risk.

## 1. Check the instrumentation is live

The `[folder-links]` lines only exist once #2032 is deployed. Check the PR
is merged (`gh pr view 2032 --repo blotcms/blot --json state,mergedAt`).
The `[folder-asset]` line shipped later: until it is deployed, logs only
have `[folder-asset-origin]`.

**Always confirm with the user before running anything against production**,
even read-only commands, and stick to read-only commands. The SSH host is
`blot`.

```bash
ssh blot "docker ps --format '{{.Names}}\t{{.Status}}'"
```

Container logs only go back to the last deploy or restart. That uptime
bounds the window: use it as `--since`, and note it in the report.

## 2. Collect and aggregate

Pull the logs once into the scratchpad, filtered to the markers, and
analyse locally. The script is plain Node with no dependencies and reads
stdin, so it doesn't need to run on the host. `$SCRATCH` is your
scratchpad directory, or any local temp directory.

```bash
for c in blue green yellow; do
  ssh blot "docker logs --since 24h blot-container-$c 2>&1 | grep -F -e '[folder-links]' -e '[folder-asset'"
done > "$SCRATCH/folder-links.log"

node scripts/folder-links/analyze-logs.js --top 20 < "$SCRATCH/folder-links.log"
node scripts/folder-links/analyze-logs.js --json < "$SCRATCH/folder-links.log" > "$SCRATCH/folder-links.json"
```

For the share of all HTML/CSS requests that hit the pass, compare against
the `Replacing folder links with CDN links` lines. Every non-preview HTML or
CSS render logs one:

```bash
for c in blue green yellow; do
  ssh blot "docker logs --since 24h blot-container-$c 2>&1 | grep -cF 'Replacing folder links with CDN links'"
done
```

## 3. Interpret

Map each bucket from the source × form table (built from sampled links) and
the per-line totals onto the migration work.

| Finding | What it means | Work it points to |
|---|---|---|
| `template` + `root`/`host` | Literal folder links in a view or partial | Bake at template save time in `Template.setView`, with template→file dependencies so file changes re-bake the view and regenerate the `{{#cdn}}` manifest |
| `template` + `relative` | Template links without a leading slash; **would break** if the pass were removed | Same as above, resolving relative to the view; list affected templates explicitly |
| `entry` (any form) | Entry HTML not baked: built before #1896, or a missing-file dependency never fired | Build-version stamp plus a throttled rebuild of unstamped entries; check the dependency gaps below |
| `entry` with `enoent` | Entry links to a file that doesn't exist | Expected for genuinely broken links. If the file *does* exist under a different case or encoding, it's the dependents-key gap (case-sensitive keys, percent-encoded `poster`/`srcset` paths) |
| `metadata` | `{{metadata.image}}` and friends in attributes (og:image etc.) | Decide whether to bake eligible metadata path values at entry build time |
| `other` | Menu URLs, template locals, variable-assembled links | Bake menu/locals at save time; for assembled host links, find the template pattern |
| `static` | `/fonts`, `/katex`… in entries or templates | Bake reserved static paths at build/save time (global file if present, else blog file) |
| High `enoent` with low `rewrites` | Pass doing disk lookups for nothing | Pure cost; note which blogs/templates |
| `ms` | Time the pass adds, including lookups | The performance case for removal |
| `[folder-asset]` | Folder files still reaching the origin, or a large file bouncing through it to the CDN | See "Investigating an origin-served folder file" below. `same_site=1` rows are the blog's own pages; `same_site=0` and no referer are other sites, feed readers, bookmarks and so on, which no change to the blog's pages will fix |

To drill into one blog or template, grep the raw lines in the scratch file.
It's local, so no further prod access is needed:

```bash
grep -F 'handle=<handle> ' "$SCRATCH/folder-links.log" | head
grep -F 'template=<templateID> ' "$SCRATCH/folder-links.log" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^sample=/) print $i}' | sort | uniq -c | sort -rn | head
```

For an `entry` finding, confirm by fetching the public page and checking
whether the rewritten link sits inside the post body. If the entry's file was
last modified before #1896 shipped, it was simply never rebuilt.

## Investigating an origin-served folder file

Take a row from "Top referer pages" in the `[folder-asset]` summary (a
`same_site=1` one) and fetch that page. It is public, so no prod access is
needed:

```bash
curl -s https://<host><path> | grep -n -F '<file name>'
```

Find the link to the file and classify it:

| What the link looks like | Why it reached the origin | Fix |
|---|---|---|
| Inside the post body, as a plain `/file.jpg` | Unbaked entry: built before #1896, or a dependency never fired | Rebuild the entry; if the file exists, check the dependents-key gaps in the table above |
| In a view or partial as a literal `/file.jpg` or `src="file.jpg"` | Template literal link, not baked at save time | Bake at save time in `Template.setView`; a relative one needs resolving against the view |
| In a template local (`locals` in the template's package.json) | The save-time pass doesn't read locals | Bake locals at save time |
| Assembled in the template, e.g. `{{blog.url}}/x.jpg` or `{{{metadata.image}}}` | Built from a variable, so no literal path exists at save time | Change the template to a literal link, or resolve it where the variable is set |
| In the menu | Menu URLs are data, not template text | Bake menu URLs at save time |
| No leading slash, e.g. `img/a.jpg` | Relative link: the browser resolves it against the page URL, so it only works from the right page | Make it root-relative in the source |

If the page has no such link, the request may come from a script, a CSS
`url()` or a `srcset` the page builds in the browser. Check the page's CSS
and scripts for the file name too.

Optional cross-check against openresty: its access log also sees requests
Node never logs (for example when the proxy answers from cache). The
location, line format and the ssh and read-only rules are in
`.claude/skills/nginx-log-review/SKILL.md`; confirm with the user before
running anything. For one file, find how it was answered and what referred it:

```bash
ssh blot "grep -F '<host><path>' /var/instance-ssd/logs/access.log | awk '{print \$4, \$6}' | sort | uniq -c | sort -rn | head"
ssh blot "grep -F '<host><path>' /var/instance-ssd/logs/access.log | grep -oE 'cache=[A-Z-]+|ref=[^ ]+' | sort | uniq -c | sort -rn | head"
```

A `cache=HIT` request never reached Node, so it has no `[folder-asset]` line.
Read `cache=-` with `up=` as described in that skill. `$6` is
`bytes_in:bytes_out`, which tells a 302 to the CDN from the file itself.

## 4. Report

In chat (blog handles, templates and paths are fine there), give:

- the window and containers;
- the share of HTML/CSS renders that produced a `[folder-links]` line;
- the source × form breakdown;
- the top blogs and templates per bucket, with a sample link each;
- `relative` cases, called out separately;
- the `[folder-asset]` summary: totals by `served`, same-site vs other vs no
  referer, and what the top referer pages turned out to be;
- which migration work each bucket points to, ranked by share of rewrites.

Then append an entry to the findings log below. Delete the scratch files when
done.

## Findings log

Read this first: earlier runs show the trend and which work has already
landed. Newest entries last.

**Privacy: this file is committed to the repo, so entries must contain no
customer information.** Leave out blog IDs, handles, domains, template IDs,
file names and paths. Describe things generically ("a handful of custom
templates link `/favicon.ico` literally"). Also leave out absolute request,
blog or line counts, because they reveal userbase scale. Use percentages
and shares only.

Entry template:

```
### <date> — <window, e.g. 24h across blue/green/yellow>
- Pass hit: <share of HTML/CSS renders with a [folder-links] line>
- Rewrites by source: template x%, entry y%, metadata z%, other w%
- Forms: root …, relative …, host …, static …
- Notable: <generic description of the biggest buckets and any relative cases>
- [folder-asset]: <generic summary: share by served, share same-site>
- Since last run: <what migration work landed, how the shares moved>
- Next: <the work the biggest bucket points to>
```

### 2026-10-22 — 2h across blue/green/yellow (since the last deploy)
- Pass hit: ~97% of HTML/CSS renders logged a [folder-links] line; misses outnumbered rewrites ~3.6:1; mean ~5ms per render in the pass
- Rewrites by source: template ~95%, entry ~0.3%, metadata <0.1%, other ~4.5%
- Forms: root ~81%, static ~14%, host ~4%, relative ~1.5%
- Notable: one blog-owned template accounted for ~48% of rewrites, through favicons and scripts linked literally in its views. Copies of one bundled magazine theme rewrite /plugins/katex font URLs in their CSS view. "Other" is mostly own-host URLs from locals or {{blog.url}}-built links. Every rewrite came from a blog-owned template.
- [folder-asset-origin] (old line, same-site only): ~0.2% of renders
- Since last run: none of the migration has landed yet. #2035 is being split into smaller PRs; this run's job is the baseline
- Next: wrap literal template links in {{#cdn}} (the template bucket), then locals/{{#asset}}
