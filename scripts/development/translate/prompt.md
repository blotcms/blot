# Build a Blot template that reproduces a website's design

You are working inside a Blot site's folder. The content is already here. Your job
is the **design**: edit the template so this site looks like the target site.

## The job

1. **Read the content you have.** Do not design for a generic blog — design for
   this folder. How many posts are there? Are they dated? Is there a `Pages/`
   directory? Which tags are in use? Is there a page with `Link: /`, meaning the
   homepage is a bespoke landing page rather than a list of posts?

2. **Study the target.** Fetch the target URL and work out its structure: layout
   and grid, typography, colour, navigation, how the index presents posts, what a
   single post looks like, header and footer, spacing and rhythm.

3. **Build the template.** Edit the files in the template directory until the
   rendered site matches. Rebuild the visual layer rather than nudging what you
   inherited — see *Do not anchor* below.

4. **Check your work.** Screenshots of both sites are in `.verification/`, named
   `input-*.png` (the target) and `output-*.png` (what you built). Compare them,
   fix what is wrong, and say what you changed.

## How Blot templates work

Every file in the template directory is a **view**, rendered with
[Mustache](https://mustache.github.io/mustache.5.html) regardless of extension —
so `style.css` and `script.js` are rendered too, and can use template variables.

`package.json` holds the configuration: `locals` (variables for every view),
`views` (per-view `url` routing and inline string `partials`), and
`enabled: true` (installs the template when the folder is added to a site — leave
it alone).

### Views and their routes

| View | Renders |
|---|---|
| `entries.html` | homepage, `/page/2`… |
| `entry.html` | a single post |
| `archives.html` | archives |
| `tagged.html` | `/tagged/:tag` |
| `search.html` | `/search?q=` |
| `error.html` | 404 and render errors |
| `feed.rss`, `sitemap.xml`, `robots.txt` | as named |

**A view's default URL keeps its extension**: `archives.html` serves at
`/archives.html` unless `package.json` maps it. This catches everyone once:

```json
"views": { "archives.html": { "url": "/archives" } }
```

`{{> header}}` includes the view `header.html`. `{{> /Pages/About.txt}}` includes
the rendered HTML of a file in the site's folder.

### Variables you can use

Only these are fetched. A name not on this list renders as empty.

**Site**: `title`, `avatar`, `roundAvatar`, `menu` (each with `id`, `label`,
`url`, `active`, `first`, `last`), `siteURL`, `feedURL`, `sitemapURL`, `timezone`,
`cacheID`, `updated`.

**Lists**: `posts` (the paginated page of entries — what `entries.html` uses),
`all_entries`, `recent_entries`, `latest_entry`, `archives` (grouped by year and
month), `all_tags`, `popular_tags`, `tagged`, `search_results`, `search_query`,
`total_posts`, `pagination` (`current`, `next`, `previous`, `total`).

**Inside an entry**: `title`, `url`, `absoluteURL`, `html`, `body`, `titleTag`,
`summary`, `teaser`, `teaserBody`, `more`, `date`, `dateStamp`, `slug`, `tags`
(each with `tag`, `slug`, `url`), `tagged.<Tag>`, `thumbnail.{small,medium,large,
square}.{url,width,height}`, `metadata.<key>`, `page`, `draft`, `backlinks`,
`formatDate`/`formatUpdated` (moment tokens in the block body).

**Helpers**: `cdn`, `css_url`, `script_url`, `feed_url`, `avatar_url`, `plugin`,
`app_css`, `app_js`, `encode_xml`, `encode_json`, `encode_uri_component`,
`absolute_urls`, `rgb`, `is`, `active`.

Append `?json=true` to any page on the local site to see the exact data it was
rendered with. Use it — it is faster and more reliable than guessing.

### Locals that become dashboard controls

Naming conventions turn `locals` into point-and-click controls for the site's
owner, at no extra cost. Prefer them:

| Pattern | Control |
|---|---|
| `*_color` | colour picker |
| `font`, `*_font` | font picker |
| `*_url` | file upload |
| a boolean | toggle |
| `<key>` + `<key>_options: []` | select menu |
| `<key>` + `<key>_range: [min,max]` | slider |
| `date_display`, `hide_dates` | date format and visibility |

## Rules

These are hard constraints of the platform, not preferences:

- **No subdirectories** for view files. Everything in the template root.
- **No Sass, SCSS, or any build step.** Plain CSS. Nothing compiles it.
- **No server-side logic.** Mustache has no conditionals beyond sections
  (`{{#x}}`) and inverted sections (`{{^x}}`), and no loops beyond iterating a
  list. If the design needs logic that Mustache cannot express, solve it with CSS
  or a little plain JavaScript.
- **Escaping**: `{{value}}` escapes HTML. Use `{{{value}}}` for `url`, `html`,
  `body`, `avatar` and anything else containing markup or slashes.
- **No duplicate basenames** — `feed.xml` and `feed.rss` collide.
- **2 MB per view** maximum.
- **Client-side frameworks are not available.** A target built on React or Vue
  must be reimplemented as plain HTML and CSS.

## Portability

This template will be handed to someone else and used on their site. So:

- Never hardcode a hostname, a CDN address, or a site ID. Not `blot.localhost`, not
  `cdn.blot.localhost`, not the blog's ID.
- Template assets: `{{#cdn}}/style.css{{/cdn}}`.
- Folder assets: ordinary relative paths.
- `{{{cdn}}}` on its own gives the CDN origin, for `preconnect`.

## Do not anchor

The template you are starting from is a working copy of Blot's default `blog`
template. It is there for its **plumbing** — a correct RSS feed, sitemap,
robots.txt, error page and social meta tags, all of which are fiddly and invisible
when wrong.

It is **not** a design to nudge toward the target. Treat it as scaffolding:

- Rewrite `style.css` from scratch, against the target, rather than editing the
  inherited rules.
- Restructure the markup in `entries.html`, `entry.html` and the header/footer
  partials freely to match the target's structure and semantics.
- Keep `feed.rss`, `sitemap.xml`, `robots.txt` and the meta tags in `head.html`
  working.

If the result still looks recognisably like Blot's default template, you have
anchored, and the design is wrong.

## You may edit the content

Some mismatches are content problems wearing a design costume:

- The target's homepage is a bespoke landing page → add `Link: /` to a page's
  metadata, so the post list moves to `/page/1`.
- The target groups posts into sections → tag the content, so `/tagged/…` works.
- A post needs a teaser or summary → add `Summary:` metadata, or a `{{more}}` tag.

Editing metadata and front matter is in scope. Rewriting the author's prose is
not.

## Finishing

Say what you changed and why, and note anything about the target you could not
reproduce and the reason — that goes in the folder's `README` under *Notes from
the translation*.

**If you are blocked** — the target cannot be fetched, the content is not what
you were told, the design needs something Blot cannot do — say so plainly and
stop. Do not improvise around a broken premise.
