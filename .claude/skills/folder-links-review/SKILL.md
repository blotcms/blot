---
name: folder-links-review
description: Find blog-folder files that Blot still serves from the origin instead of the CDN, from the [folder-asset] log line (older logs have [folder-asset-origin] instead), trace each one to the link in an entry, template, local or menu that caused it, and fix the link. Pulls the app container logs over ssh, aggregates them with scripts/folder-links/analyze-logs.js, maps each kind of origin hit to a fix, and appends a short entry to this skill's findings log. Use when asked to review folder links, check how many folder files are still served from the origin, or re-run the folder-link log analysis.
---

# Folder-link review

## Background

Links to files in a blog's folder are baked into CDN URLs ahead of time, not
at request time (the request-time pass, `replaceFolderLinks`, is gone):

- **Entries:** at build time, by `app/build/plugins/folderAssets`, with
  `%%BLOT_CDN%%` tokens.
- **Template views:** when the full view is assembled, literal folder links
  are wrapped in `{{#cdn}}` by `app/models/template/util/resolveFolderLinks`,
  using the CDN manifest.

What reaches the origin by design:

- views that use `{{=` delimiters, which the wrapping skips;
- links built from variables (`{{base}}/x.jpg`, `{{{someLocal}}}/x.jpg`),
  because no literal path exists to wrap (`{{blog.url}}/x.jpg` is wrapped;
  entry metadata like `{{metadata.image}}` is not baked, so it is a plain
  path);
- menu `<a href>`s to files, which are data, not template text;
- relative links containing `..`;
- large files 302'd to the CDN (`served=cdn-redirect`): fine, but each one
  still costs an origin request.

Every blog-folder file (not an HTML page) or global static file the app
serves logs one line, from `app/blog/routes/assets.js`:

```
[folder-asset] blog=<id> handle=<h> served=origin|cdn-redirect|static path=<path> referer=<host><path>|-|invalid same_site=1|0
```

`served=origin` was sent by the app, `served=cdn-redirect` was a large file
302'd to the CDN, and `served=static` is one of Blot's own global files
(`/fonts`, `/katex`, …). `same_site=1` means the Referer is one of the blog's
own hosts, i.e. a link on the blog's pages reached the origin instead of the
CDN. It replaces `[folder-asset-origin]` (`blog= handle= path= referer_path=`,
same-site origin responses only); `analyze-logs.js` still reads the old line
as `served=origin same_site=1`, for logs from before it shipped.

## 1. Check the instrumentation is live

The `[folder-asset]` line shipped in [#2182](https://github.com/blotcms/blot/pull/2182).
Check it is merged (`gh pr view 2182 --repo blotcms/blot --json state,mergedAt`)
and deployed; until then, logs only have `[folder-asset-origin]`.

**Always confirm with the user before running anything against production**,
even read-only commands, and stick to read-only commands. The SSH host is
`blot`.

```bash
ssh blot "docker ps --format '{{.Names}}\t{{.Status}}'"
```

Container logs only go back to the last deploy or restart. That uptime
bounds the window: use it as `--since`, and note it in the report.

## 2. Collect and aggregate

Pull the logs once into the scratchpad, filtered to the marker, and
analyse locally. The script is plain Node with no dependencies and reads
stdin, so it doesn't need to run on the host. `$SCRATCH` is your
scratchpad directory, or any local temp directory.

```bash
for c in blue green; do
  ssh blot "docker logs --since 24h blot-$c 2>&1 | grep -F '[folder-asset'"
done > "$SCRATCH/folder-assets.log"

node scripts/folder-links/analyze-logs.js --top 20 < "$SCRATCH/folder-assets.log"
node scripts/folder-links/analyze-logs.js --json < "$SCRATCH/folder-assets.log" > "$SCRATCH/folder-assets.json"
```

`same_site=1` rows are the blog's own pages. `same_site=0` and no referer
are other sites, feed readers, bookmarks and so on, which no change to the
blog's pages will fix. To drill into one blog, grep the raw lines locally:

```bash
grep -F 'handle=<handle> ' "$SCRATCH/folder-assets.log" | head
```

## Investigating an origin-served folder file

Take a row from "Top referer pages" in the summary (a `same_site=1` one) and
fetch that page. It is public, so no prod access is needed:

```bash
curl -s https://<host><path> | grep -n -F '<file name>'
```

Find the link to the file and classify it:

| What the link looks like | Why it reached the origin | Fix |
|---|---|---|
| Inside the post body, as a plain `/file.jpg` | Unbaked entry: not rebuilt since baking shipped, or a dependency never fired | Rebuild the entry; if the file exists, check the dependents-key gaps (case-sensitive keys, percent-encoded `poster`/`srcset` paths) |
| In a view or partial as a literal `/file.jpg` or `src="file.jpg"` | View not wrapped: `{{=` delimiters, the file missing from the CDN manifest when the view was assembled, or a `..` relative link | Fix the cause in `resolveFolderLinks` or the manifest; for `{{=` or `..`, edit the template |
| In a template local (`locals` in the template's package.json) | Locals are resolved only where used via `{{#asset}}`, not wrapped in place | Use `{{#asset}}`/`{{#cdn}}` on the local in the view, or resolve it in `resolveFolderLinks` |
| Assembled in the template, e.g. `{{blog.url}}/x.jpg` or `{{{metadata.image}}}` | Built from a variable, so no literal path exists | Change the template to a literal link, or resolve it where the variable is set |
| In the menu | Menu URLs are data, not template text | Wrap the menu URL in the view with `{{#cdn}}`, or resolve menu URLs when the view is assembled |
| No leading slash, e.g. `img/a.jpg` | Relative link: the browser resolves it against the page URL, so it only works from the right page | Make it root-relative in the source |
| `served=cdn-redirect` | Large file 302'd to the CDN | Nothing; fine |

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

## 3. Report

In chat (blog handles, templates and paths are fine there), give:

- the window and containers;
- totals by `served`, and same-site vs other vs no referer;
- what the top referer pages turned out to be, and the link that caused each;
- which fix each cause points to, ranked by share of origin-served hits.

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
### <date> — <window, e.g. 24h across blue/green>
- Served: origin x%, cdn-redirect y%, static z%
- Referer: same-site x%, other site y%, none z%
- Top causes: <generic description of the biggest causes of origin hits>
- Since last run: <what fixes landed, how the shares moved>
```

### 2026-10-22 — 2h across blue/green/yellow (since the last deploy)
- Pass hit: ~97% of HTML/CSS renders logged a [folder-links] line; misses outnumbered rewrites ~3.6:1; mean ~5ms per render in the pass
- Rewrites by source: template ~95%, entry ~0.3%, metadata <0.1%, other ~4.5%
- Forms: root ~81%, static ~14%, host ~4%, relative ~1.5%
- Notable: one blog-owned template accounted for ~48% of rewrites, through favicons and scripts linked literally in its views. Copies of one bundled magazine theme rewrite /plugins/katex font URLs in their CSS view. "Other" is mostly own-host URLs from locals or {{blog.url}}-built links. Every rewrite came from a blog-owned template.
- [folder-asset-origin] (old line, same-site only): ~0.2% of renders
- Since last run: none of the migration has landed yet. #2035 is being split into smaller PRs; this run's job is the baseline
- Next: wrap literal template links in {{#cdn}} (the template bucket), then locals/{{#asset}}

### 2026-10-23 — 9h across blue/green/yellow (first night after the request-time pass was removed)
- Served: origin ~46%, cdn-redirect ~17%, static ~37%
- Referer: same-site ~69%, other site ~11%, none ~21%
- Top causes: (1) bundled-theme CSS views linking `/plugins/katex/...` fonts, about a dozen blogs at identical volume, all `served=static` (global files, not folder files); (2) absolute own-host links in a custom template (font preloads); (3) a few blogs whose folder has a double-encoded path (`%25xx`), so the link never matches the CDN manifest; (4) a custom template with literal image/script links in a preview host's views; (5) a long tail of jpg/webp/json from entry bodies and data files on a few blogs. Origin hits are mostly images (~45%) and json (~25%).
- Health: no restarts, no OOM kills, no fatal/unhandled errors in any app container.
- Since last run: the pass is gone; no signs of broken pages or a restart storm. Next: absolute own-host links in templates, double-encoded folder paths, and whether katex fonts should be a CDN/static path.
