# Dashboard (server)

Routes and loaders for `https://local.blot/sites`. Views are in `app/views/dashboard` (see the AGENTS.md there for CSS and client JS).

## Shape of a page

- `index.js` mounts the session, CSRF, user and blog loading, then `/account`, the sites list (`GET /`) and `/:handle` (`site/index.js`).
- `site/index.js` builds each site page from small loaders, one per thing the view shows (`site/load/*.js`, `site/folder`, `site/template/templates.js`). A route only runs the loaders its view renders; `setView()` sets the flags the template uses to pick what to render.
- `site/template` is the template editor, rendered with `app/views/dashboard/template/layout.html`.

## Performance rules

- Aim for ~10 ms server time at p50. Before optimising, measure: wrap the route's middleware with a timer and log it, and count Redis commands for one request (`redis-cli MONITOR` filtered to the container's IP).
- Read only what the page shows: page through long Redis lists and stop once there is enough (`load/recent-activity.js`), fetch one template's metadata rather than the whole list when only the live template is shown (`templates.current`), and never call a third-party API on a page view if a short-lived cache will do (`account/index.js` and the Stripe balance).
- Cache derived data with `lru-cache`, keyed on a value stored in Redis so blue and green agree:
  - `blog.cacheID` changes when a sync finishes, a scheduled post publishes or the template changes (`load/posts.js`).
  - The blog's latest status changes whenever the status log does (`load/recent-activity.js`).
  - The blog's plugin settings (`load/plugins.js`).
  Cache raw data, and add per-request bits (relative times such as "3 days ago") after reading from the cache.
- Don't put user-specific or request-specific data into shared cached objects, and never mutate a cached object while rendering.

## Template screenshots

`site/template/screenshots.js` screenshots a blog's own templates, customized defaults and live template, in the background, only when a page lists them and the stored one is stale (the template changed, or the posts changed and it is over a day old). A failed screenshot is not tried again for 30 minutes, so a page that times out doesn't start Chromium on every view of the list. Never take a screenshot while a request waits for it. Images load through `/sites/:handle/template/:slug/screenshot`, which redirects to the current file; `app/views/js/template-screenshots.js` asks again while one is pending. In preview slots, `BLOT_SCREENSHOT_HOST_RULES` (in `scripts/development/docker-compose.worktree.yml`) points the browser at the main stack's proxy.

## Specs

There are deliberately no UI or route specs here. Keep `tests/index.js` (broken links) and the specs that guard security, billing, data loss and importers; don't add new UI specs.
