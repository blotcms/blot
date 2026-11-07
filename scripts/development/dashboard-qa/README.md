# Dashboard QA tools

Checks for dashboard work against a preview slot (`scripts/development/preview.sh up`) or, with `--slot main` / `SLOT=main`, the main stack at `https://local.blot`. Each logs in as the local test user with a one-time token. They need the Docker stack running and use the repository's `puppeteer` and `postcss`.

- `node qa.js [--slot a] [--width 1280|390] [--shots DIR] [--before "js"] [--eval "expr"] /sites /sites/local ...`
  Loads each page in headless Chrome and prints its status, final URL, time to first byte, the bytes of HTML/CSS/JS it downloaded, console errors and failed requests, then saves a full-page screenshot. `--eval` prints the result of a JS expression on each page; `--before` runs one before the screenshot, e.g. to open a menu. Shoot a set of pages before and after a CSS change and compare the screenshots.

- `node css-usage.js [--slot a] [--max 150] > report.json`
  Crawls the dashboard (following safe GET links on the `local` site at 1280px and 390px) and reports, per CSS file under `app/views/css`, `app/views/partials` and `app/views/dashboard`, which selectors matched a page and which never did. Selectors whose classes appear in JS are listed separately, as classes added by scripts. Use it to find dead CSS, and check a candidate's classes against the views and server code before deleting it: the crawl can't reach every state.

- `SLOT=a ./redis-per-request.sh /sites /sites/local`
  Counts the Redis commands each page sends (after a warm-up request), which is a steadier measure than local timings. `VERBOSE=1` lists them by command.

- `node axe.js [--slot a] [/path,/path]`
  Runs the axe-core accessibility checks (loaded from cdnjs) on dashboard pages and prints each violation with the elements it found.

The in-app browser pane blocks `cdn.<slot>-local.blot`, so pages load there without CSS or JS; use `qa.js` for visual checks.
