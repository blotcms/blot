# GitHub client — planning document

This is the plan for adding **GitHub** as a folder client: the user signs in with GitHub (OAuth), picks a repository as their site folder, optionally copies existing files into that repository, and Blot keeps the site in sync when they push.

It is a plan only. No client code has been written.

The dashboard name would be **GitHub**, registered as `github` in `app/clients/index.js`. That matches Dropbox / Google Drive / iCloud: GitHub holds the folder; Blot follows it.

Blot already has an unrelated blot.im-hosted Git remote (`app/clients/git`, documented as “Git”). People who want GitHub today add it as a second remote to that endpoint. This plan replaces that workaround with a real GitHub App client. The blot-hosted remote can stay for non-GitHub Git; it is not what this work implements.

The root `TODO` already records this as *“Make it possible to connect github repo via their API.”*

---

## Recommendation

Use a **GitHub App**, not a legacy OAuth App.

GitHub Apps still use OAuth so a user can sign in. They also add:

- A repo picker on GitHub’s own install screen (all repositories, or selected ones).
- Fine-grained permissions (`Contents: Read and write` instead of the OAuth App `repo` scope, which is far broader).
- One app-level webhook that receives `push` events for every installed repository. An OAuth App would have to create a webhook on each repository, and those hooks are not cleaned up if the user revokes access.
- Short-lived installation tokens (1 hour), minted from a private key. Blot does not need to store a long-lived token to sync.
- Rate limits that scale with the installation, rather than a flat 5,000 requests/hour user budget.

GitHub’s own docs prefer GitHub Apps for this shape of product. A separate OAuth App is not needed.

Register **two** GitHub Apps: one public production app (`Blot`), one private development app (`Blot Dev`). Dropbox already splits credentials this way (`config.dropbox.app` vs `config.dropbox.full`). A GitHub App has a single webhook URL, so production and local development cannot share one app the way a Dropbox webhook can be relayed after the fact — at least not without putting the production webhook URL behind `webhooks.blot.im` for every delivery. Two apps is simpler and is what GitHub recommends.

---

## How it fits Blot’s client model

Clients live under `app/clients/` and are registered in `app/clients/index.js` when their credentials exist in config. Each client must export:

| Property | Role for a GitHub client |
| --- | --- |
| `display_name` | `"GitHub"` |
| `description` | Short line for the folder picker on `/sites/:handle/client` |
| `disconnect(blogID, cb)` | Drop Redis state, clear `blog.client`. Do not uninstall the GitHub App if another Blot site still uses that installation. |
| `write(blogID, path, contents, cb)` | Write the file on disk **and** commit it to the selected GitHub repo (dashboard uploads, draft previews, templates written into the folder). |
| `remove(blogID, path, cb)` | Delete on disk **and** commit the deletion to GitHub. |
| `dashboard_routes` | Connect, OAuth callback, repo picker, transfer choice, status, disconnect. |
| `site_routes` | Public webhook + OAuth callback (same pattern as Dropbox). |
| `resync` (optional) | Full walk of the GitHub tree vs the local folder, used by `/client/reset`. |
| `init` (optional) | Nothing required at boot if webhooks are the only trigger. A periodic catch-up (compare `last_commit_sha` to the remote tip) would match Dropbox’s hourly validation. |

`app/clients/index.js` should register the client only when the GitHub App credentials are present, matching Dropbox and Google Drive.

Dashboard routes are already allowed to run before `blog.client` is persisted for `/`, `/connect`, `/setup`, `/set-up-folder`, `/redirect`, `/authenticate`, and `/create` (`app/dashboard/site/client.js`). A GitHub connect flow can reuse those paths.

Site routes are mounted at `https://blot.im/clients/<name>/…` (`app/site/index.js` → `app/clients/routes.js`). That is the production webhook and OAuth callback host.

`clients/util/shouldIgnoreFile` already ignores `.git`. If this client syncs files through the GitHub API rather than cloning, the blog folder will not contain a `.git` directory. That is an improvement on the existing Git client.

---

## GitHub App vs OAuth App (why not the latter)

| | GitHub App | Legacy OAuth App |
| --- | --- | --- |
| Sign-in | OAuth 2.0 user-to-server token (`ghu_`), 8-hour expiry, 6-month refresh token | OAuth 2.0 token, optionally expiring |
| Repo selection | Install on chosen repos | `repo` scope grants every repo the user can access |
| Webhooks | One URL on the app, GitHub delivers for every installation | Must `POST` a hook per repository; leftover hooks if the token dies |
| Sync auth | Installation token from a private key, 1 hour, not stored | Must store the user token |
| Revocation | `installation` / `github_app_authorization` webhooks | Silent; next API call is 401 |
| Permissions shown to the user | `Contents: Read and write`, `Metadata: Read` | `repo` (contents, issues, PRs, settings, …) |

The OAuth a GitHub App offers is enough to identify the GitHub user and list installations. After a repository is chosen, **sync and `write`/`remove` should use installation tokens**, not the user token. Then:

- Sync keeps working if the user later revokes “Sign in with GitHub” but leaves the app installed.
- Commits Blot makes (template files, draft previews, dashboard uploads) appear as `blot[bot]`, so they are distinguishable from the user’s own pushes.

---

## Credentials GitHub issues, and where they live

A GitHub App produces several values. They are **not** interchangeable.

| Value | Where it appears | Used for |
| --- | --- | --- |
| App ID | Top of the app settings page (integer) | JWT `iss` claim when minting installation tokens |
| App slug | URL `github.com/apps/<slug>` | Install URL |
| Client ID | “About” / client credentials on the settings page. **Different from the App ID.** | OAuth authorize + token exchange |
| Client secret | Generated on the settings page; shown once | OAuth `POST /login/oauth/access_token` |
| Private key (PEM) | “Private keys” → Generate a private key; downloaded once | Sign JWTs to get installation tokens |
| Webhook secret | Chosen when registering the app (or later) | HMAC of `X-Hub-Signature-256` |
| Webhook URL | Chosen when registering the app | Where GitHub POSTs events |

Follow the existing secret style in `config/index.js` and `config/environment.sh`:

```
BLOT_GITHUB_APP_ID
BLOT_GITHUB_APP_SLUG
BLOT_GITHUB_CLIENT_ID
BLOT_GITHUB_CLIENT_SECRET
BLOT_GITHUB_PRIVATE_KEY          # PEM, base64-encoded (same idea as BLOT_GOOGLEDRIVE_SERVICE_ACCOUNT_*)
BLOT_GITHUB_WEBHOOK_SECRET
```

A development app would use the same names in the local environment, with different values.

`config/index.js` would parse these into `config.github`, and `app/clients/index.js` would set `clients.github` only when they are all present.

---

## Exact steps on GitHub to create the app and OAuth credentials

Do this twice: once for production, once for development. GitHub’s current UI (documented in [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)):

### 1. Decide who owns the app

Register it under an organization, not a personal account. The root `TODO` already includes “Move Blot’s GitHub repo to its own organization.” The app should live on that org so it is not tied to one person’s GitHub user. Until the org exists, it can be registered under the account that owns `davidmerfield/Blot` and transferred later (GitHub supports transferring app ownership).

You need org owner (or GitHub App manager) permission.

### 2. Open the registration form

1. Sign in to GitHub.
2. Profile photo → **Settings** (personal) or **Your organizations** → **Settings** (org).
3. Left sidebar → **Developer settings**.
4. **GitHub Apps** → **New GitHub App**.

### 3. Identify the app

| Field | Production | Development |
| --- | --- | --- |
| GitHub App name | `Blot` (must be unique on GitHub; add a suffix if taken, e.g. `Blot Sync`) | `Blot Dev` |
| Description | “Sync a GitHub repository with your Blot site.” | Same, plus “Development only.” |
| Homepage URL | `https://blot.im` | `https://blot.im` or `https://github.com/davidmerfield/Blot` |

The name becomes the slug (lowercase, spaces to `-`). Note the slug; it is used in the install URL `https://github.com/apps/<slug>/installations/new`.

### 4. OAuth / callback URLs

Under **Identifying and authorizing users**:

1. **Callback URL** — GitHub allows up to 10. Set:

   - Production app: `https://blot.im/clients/github/authenticate`
   - Development app: `https://webhooks.blot.im/clients/github/authenticate`

   The development URL matches Dropbox: production’s webhook relay host (`config.webhooks.relay_host`) 302s `/clients/github/authenticate` to `local.blot`. Add that redirect next to the existing Dropbox/Google Drive redirects in `app/clients/webhooks.js`.

2. Leave **Expire user authorization tokens** checked. User tokens then last 8 hours and come with a 6-month refresh token (`ghr_`). GitHub recommends this.

3. Check **Request user authorization (OAuth) during installation**. After the user installs the app (and picks repositories), GitHub immediately runs the OAuth authorize redirect. That is one GitHub round-trip instead of “install, then sign in.”

   Trade-off: with this box checked, GitHub always uses the first callback URL and ignores Setup URL. That is fine if the production and development apps each have one callback.

4. Do **not** enable Device Flow.

5. Leave **Setup URL** blank if step 3 is checked. If we later uncheck “Request user authorization during installation,” Setup URL would be `https://blot.im/sites` (the dashboard will recover the blog from a cookie, same as Dropbox’s `blogToAuthenticate`).

### 5. Webhook

1. Leave **Webhook** → **Active** checked.
2. **Webhook URL**:
   - Production: `https://blot.im/clients/github/webhook`
   - Development: `https://webhooks.blot.im/clients/github/webhook`
3. **Webhook secret**: generate a long random string (e.g. `openssl rand -hex 32`). Store it as `BLOT_GITHUB_WEBHOOK_SECRET`. GitHub will send `X-Hub-Signature-256: sha256=<hmac>`.
4. Leave **SSL verification** enabled.

### 6. Permissions

Under **Repository permissions**, grant the minimum:

| Permission | Level | Why |
| --- | --- | --- |
| **Contents** | Read and write | Read the tree and blobs on push; commit files from `write`/`remove`; required even to *receive* `push` webhooks |
| **Metadata** | Read-only | Always required; repo name, default branch, etc. |

Everything else stays **No access** (Issues, Pull requests, Actions, Administration, …).

No organization or account permissions.

### 7. Subscribe to events

Once Contents is granted, subscribe to:

| Event | Why |
| --- | --- |
| **Push** | User (or Blot) updated the branch we track |
| **Installation** | App installed, uninstalled, or suspend/unsuspend |
| **Installation repositories** | Repos added or removed from the installation |
| **Repository** | Renamed, transferred, or deleted |

`github_app_authorization` (user revoked OAuth) is delivered automatically; GitHub Apps cannot unsubscribe. Handle it by dropping stored user tokens for that GitHub user. Do not disconnect the site if an installation token can still sync.

Optionally later: **Create** / **Delete** (branches, tags) if we want to notice the tracked branch disappearing without waiting for a failed fetch.

### 8. Installation visibility

- Production: **Any account**. Otherwise customers cannot install it.
- Development: **Only on this account**, so only Blot developers can install the dev app.

Then **Create GitHub App**.

### 9. Generate the OAuth client secret

On the app’s settings page after creation:

1. Copy **App ID** (integer) → `BLOT_GITHUB_APP_ID`.
2. Copy **Client ID** → `BLOT_GITHUB_CLIENT_ID`.
3. Under **Client secrets**, click **Generate a new client secret**. Copy it immediately → `BLOT_GITHUB_CLIENT_SECRET`. GitHub will not show it again.

### 10. Generate the private key

Still on the settings page, under **Private keys**:

1. **Generate a private key**.
2. A `.pem` file downloads. GitHub keeps only the public half.
3. Base64-encode the PEM (single line) and store it as `BLOT_GITHUB_PRIVATE_KEY`, same pattern as Google Drive service-account JSON.
4. Store the file in the same secrets mechanism used for Dropbox keys (`/etc/blot/secrets.env` in production, local env for development). Do not commit it.

### 11. Note the slug and install URL

The public install URL is:

```
https://github.com/apps/<slug>/installations/new
```

Optional query `state` can carry a CSRF token / blog handle, analogous to Dropbox’s `blogToAuthenticate` cookie. Prefer the cookie plus OAuth `state` (see flow below) rather than putting a blog handle in a public query string.

### 12. Production secrets and deploy

After both apps exist:

1. Put the production values in the production secrets file.
2. Put the development values in the local environment / `config/environment.sh` placeholders.
3. Restart / redeploy so `config.github` is populated and the client appears on the dashboard.

No extra GitHub “marketplace” listing is required. A public GitHub App can be installed by anyone with the install URL. A marketplace listing can wait.

### 13. Optional later: App Manifests

GitHub App Manifests let a self-hosted Blot register an app with one click. Useful if self-hosting documentation ever tells people to run their own GitHub App. Not needed for blot.im.

---

## User flow (dashboard)

Goal: as few GitHub screens as possible, then a Blot screen to pick **one** repository (and confirm file transfer).

```
Dashboard “Folder”
  → Choose GitHub
  → “Sync with GitHub” (explain: Blot will only see the repos you pick)
  → Redirect to GitHub install + OAuth
  → GitHub: sign in, pick account, pick repositories, authorize
  → Callback /clients/github/authenticate
  → Dashboard: list of accessible repos → pick one
  → If both sides have files: choose how to reconcile
  → Transfer + first sync (progress bar)
  → Status page (account, repo, branch, disconnect)
```

### Step-by-step

1. **Connect page** (`GET /sites/:handle/client/github` or `/setup`). Copy tone from Dropbox’s `views/authenticate.html`: Blot will only access repositories the user selects; they can switch clients later.

2. **Redirect** (`GET .../redirect`).
   - Set `blogToAuthenticate` cookie (Dropbox already does this; `sameSite: Lax`, 15 minutes, host-only).
   - Put a random `state` in the session.
   - 302 to `https://github.com/apps/<slug>/installations/new` if we want the install screen first, or to `https://github.com/login/oauth/authorize?client_id=...&redirect_uri=...&state=...` if the app is already installed.
   - With “Request user authorization (OAuth) during installation” checked, the install URL is enough: GitHub shows repo selection, then OAuth, then hits the callback with `code` and `installation_id`.

3. **Public callback** (`GET /clients/github/authenticate`).
   - Same problem Dropbox solved: this URL is not inside the dashboard session until we know which blog it is for.
   - Read `blogToAuthenticate`, verify `state`, redirect to `/sites/:handle/client/github/authenticate?code=...&installation_id=...`.
   - In development, `webhooks.blot.im` 302s here to `local.blot` first (`app/clients/webhooks.js`).

4. **Dashboard callback** exchanges `code` at `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `code`, `redirect_uri`.
   - Response: `access_token` (`ghu_`), `refresh_token` (`ghr_`), `expires_in` (28800).
   - `GET https://api.github.com/user` for login / id / email (display only).
   - `GET /user/installations` and `GET /user/installations/{id}/repositories` (paginate).

5. **Repo picker**. Show `owner/name`, private/public, default branch. Disable repos already linked to another Blot site. Optional: “Create a new repository” via `POST /user/repos` (nice-to-have, not required for v1).

   Selecting a repository is a Blot UI step even though GitHub already asked which repos the app may access. Installation is a *permission grant*; the site still needs exactly one folder.

6. **Branch**. Default to `default_branch` (`main` or `master`). Store it. Unlike the existing Git client, do not hard-code `master`.

7. **File transfer** (see next section).

8. **Persist** `blog.client = "github"` and the Redis record. Run the chosen transfer under `sync()` so the folder lock is held. Use `clients/util/resyncProgress` so the dashboard progress bar matches Google Drive / iCloud / Dropbox.

9. **Status page**. Account login, `owner/repo` link to GitHub, branch, last sync. Reconnect if the installation was removed. Disconnect.

A user with several Blot sites uses one GitHub installation and a different repository per site. Reuse the stored user token / installation id when a second site is connected, and skip OAuth if the token is still refreshable — same idea as Dropbox listing blogs by `account_id`.

---

## Transferring files into the repository

Blot must not silently clobber a non-empty repo, and must not silently drop the files already on the site (welcome post, template files, dashboard uploads). Dropbox’s setup does **reset from Blot** (upload local files) after creating a folder. Google Drive uploads local files into the newly shared empty folder. The Git client’s `create.js` copies the existing blog folder into a new repo and commits it.

GitHub folders are often **not** empty (an existing Jekyll/Hugo site, a README, a license). Offer an explicit choice.

### Detect

After the repo is selected, compare:

- Local: recursive list of the blog folder, minus `shouldIgnoreFile`.
- Remote: `GET /repos/{owner}/{repo}/git/trees/{default_branch}?recursive=1` (or “empty” if GitHub returns 409 Git Repository is empty).

### Choices

| Local | Remote | Default |
| --- | --- | --- |
| Empty | Empty | Nothing to copy. Done. |
| Has files | Empty | **Upload Blot → GitHub** (one commit from `blot[bot]`). No prompt required beyond “Blot will copy your site folder into `owner/repo`.” |
| Empty | Has files | **Download GitHub → Blot**. No prompt required beyond “Blot will use the files in `owner/repo`.” |
| Has files | Has files | **Ask**: (a) GitHub wins — replace the Blot folder with the repo; (b) Blot wins — commit the Blot folder, replacing the repo contents; (c) Cancel and pick another repo. |

Do **not** try to three-way merge in v1. Dropbox does not merge either.

### How to upload (Blot → GitHub)

Do not `git clone` into the blog folder.

Use the Git Database API so one setup produces **one commit**:

1. For each local file, `POST /repos/{owner}/{repo}/git/blobs` (base64). Skip ignored paths. Skip files over GitHub’s 100 MB blob limit; record them as a setup error / placeholder, consistent with Dropbox’s 100 MB cap.
2. `POST /git/trees` with those blobs (and `base_tree` if we are replacing an existing tree).
3. `POST /git/commits` with a message like `Add files from Blot`.
4. `PATCH /git/refs/heads/{branch}` (or `POST` the ref if the repo was empty).

The Contents API (`PUT /repos/.../contents/{path}`) is simpler per file but creates one commit per file, is limited to 1 MB per request, and is a poor fit for a whole folder.

For very large sites, batch blobs and show progress (`(n/total) Transferring /Posts/Hello.txt`), matching Dropbox `reset-from-blot.js`.

### How to download (GitHub → Blot)

1. Recursive tree at the branch tip.
2. Skip `shouldIgnoreFile`, gitlinks (mode `160000`, submodules), and symlinks (mode `120000`). The existing Git client rejects both; do the same rather than materializing them.
3. `GET /repos/{owner}/{repo}/git/blobs/{sha}` for each blob; write under `localPath(blogID, path)`.
4. Delete local files that are not on GitHub (only when the user chose “GitHub wins”).
5. `folder.update(path)` for each changed path so entries rebuild.

If `truncated: true` (tree larger than 100,000 entries or 7 MB of metadata), walk directories without `recursive=1`.

### `.gitignore`

The Git Database API returns committed files only. A `.gitignore` does not hide committed files and does not need special handling for sync. Honoring `.gitignore` as an extra ignore list is a later enhancement; `shouldIgnoreFile` is the v1 filter.

---

## Webhook listening

### Delivery

GitHub POSTs JSON to the single webhook URL, with headers:

- `X-GitHub-Event` — `push`, `installation`, …
- `X-GitHub-Delivery` — delivery GUID (idempotency)
- `X-Hub-Signature-256` — `sha256=` + HMAC-SHA256 of the raw body with the webhook secret
- `User-Agent: GitHub-Hookshot/...`

Respond **200 quickly**, then sync asynchronously. GitHub retries failed deliveries. Dropbox’s webhook does the same: verify, `200`, then sync.

Verify the signature against the raw body **before** `JSON.parse`, using a constant-time compare. Reject 401/403 on mismatch. Dropbox’s `POST /clients/dropbox/webhook` is the template (`crypto.createHmac("SHA256", secret)`).

### `push`

Payload includes `ref`, `before`, `after`, `repository.full_name`, `installation.id`, `commits[]` (added / removed / modified paths, truncated after a point), `forced`, `pusher`, `sender`.

Handle:

1. Look up the Blot site by `repository.id` (stable across renames) or `installation.id` + full name.
2. Ignore if no site, or `ref` is not `refs/heads/{stored_branch}`.
3. Ignore if `sender` is the GitHub App’s bot (`sender.type === "Bot"` and the app id matches) **and** `after` equals the SHA we just pushed from `write`/`remove`. That breaks the loop: Blot commits a draft preview → GitHub fires `push` → Blot would otherwise re-download the same files. Still process the event if `after` does not match (the user pushed at the same time).
4. If `after` is all zeros, the branch was deleted — surface an error on the dashboard, do not wipe the folder.
5. If `forced` or the payload’s `commits` list is truncated, fall back to `GET /repos/{owner}/{repo}/compare/{before}...{after}` or a full tree diff against `last_commit_sha`.
6. Acquire `sync(blogID)`, download added/modified blobs, delete removed paths, `folder.update`, store `last_commit_sha = after`.

### `installation`

- `deleted` / `suspend`: mark affected sites as needing reconnect (do not delete the blog folder).
- `created`: useful if the user installed without coming through OAuth first; the dashboard can still wait for the callback.

### `installation_repositories`

If the selected repo was **removed** from the installation, same as disconnect-needed.

### `repository`

If `renamed` or `transferred`, update stored `owner`/`name`; keep `repo_id`. If `deleted`, mark reconnect.

### Development relay

`app/clients/webhooks.js` already forwards POSTs that hit `webhooks.blot.im` to a connected local server, and special-cases Dropbox’s webhook *challenge* GET.

For the development GitHub App:

- Webhook URL is `https://webhooks.blot.im/clients/github/webhook`, so deliveries go through the existing SSE relay. No extra GitHub feature needed.
- OAuth callback GET must be added next to Dropbox/Google Drive so GitHub’s browser redirect reaches `local.blot`.

Production deliveries go to `https://blot.im/clients/github/webhook` and never through the relay.

### OpenResty

`/clients` is already reverse-proxied with a 100 MB body limit (`proxy/config/blot-site.conf`). GitHub webhook payloads are small. No new vhost is required. Do not send GitHub webhooks to the `webhooks.blot.im` in-memory subscriber map in production — that host is only the development relay, and it is pinned to the green container.

---

## Ongoing sync model

Treat GitHub like Dropbox (webhook + delta), not like the existing Git client (bare repo + `git fetch`).

**Why not clone the GitHub repo into the blog folder**

- The blog folder would contain `.git`, which `shouldIgnoreFile` already excludes from publishing but which complicated the existing Git client (nested repo detection, handle renames, gc, large pushes taking down the server — all listed under “Improve git sync” in `TODO`).
- `write` would need `git add && commit && push` with credentials in the remote URL.
- Disk use doubles (objects + working tree).

**Why not poll without webhooks**

- Possible via `GET /repos/{owner}/{repo}/commits/{branch}` every N minutes, as a safety net.
- GitHub Apps are built around the single webhook; polling should be backup only (Dropbox has hourly `reset-to-blot`; Google Drive polls Drive Activity). A daily or hourly “is `last_commit_sha` still HEAD?” check in `init` is enough for v1.

**Delta**

`before`/`after` on the push event, or `GET /repos/{owner}/{repo}/compare/{base}...{head}`, yields file-level added/removed/modified. Download only those blobs. Store `last_commit_sha` so a missed webhook can still diff.

**Concurrency**

One sync per blog via `require("sync")`, same as every other client. Webhooks for the same repo can pile up; coalesce while a sync is running (Dropbox uses `ongoingSyncs`).

**Conflicts**

If the user edits on GitHub and someone uses the Blot dashboard to upload the same path, last writer wins. Same as Dropbox/Google Drive. Commits from `blot[bot]` make the dashboard-originated change visible in `git log`.

---

## `write`, `remove`, disconnect

`write` is used for draft previews (`app/sync/update/preview/write.js`), templates written into the folder (`app/models/template/writeToFolder.js`), and dashboard folder uploads. Those files **must** land in GitHub or they vanish on the next push.

Per file, prefer the Contents API (`PUT` / `DELETE /repos/{owner}/{repo}/contents/{path}` with the current file SHA) so each dashboard action is one commit. For files over 1 MB, fall back to blob + tree + commit + update-ref.

Ignore `shouldIgnoreFile` paths, same as other clients.

`disconnect`:

1. Take the sync lock.
2. `Blog.set(blogID, { client: "" })`.
3. Drop Redis keys for that blog.
4. Remove the blog id from the installation → blogs index.
5. Do **not** call `DELETE /app/installations/{id}` unless this was the last Blot site on that installation **and** we decide uninstalling is worth the surprise. Safer v1: leave the GitHub App installed; the user uninstalls from GitHub’s settings if they want.

If the GitHub user later uninstalls, the `installation` webhook clears remaining state.

---

## Data to store (Redis)

Per blog, e.g. hash `blog:{blogID}:github`:

| Field | Purpose |
| --- | --- |
| `installation_id` | Mint installation tokens |
| `github_user_id` / `github_login` | Status page |
| `user_access_token` / `user_refresh_token` / `user_token_expires` | Repo listing, second-site connect. Not used for sync. |
| `owner` / `repo` / `repo_id` | Identity (`repo_id` survives renames) |
| `branch` | Tracked branch |
| `last_commit_sha` | Delta cursor |
| `last_sync` | Status page |
| `error` | Reconnect banner (installation gone, 401, repo deleted) |
| `preparing` | Setup / transfer in progress |

Indexes:

- `clients:github:repo:{repo_id}` → blog ID (unique: one site per repo).
- `clients:github:installation:{installation_id}` → set of blog IDs (webhook fan-out is usually 1:1 but a future subfolder feature might change that).
- `clients:github:user:{github_user_id}` → set of blog IDs (token refresh / revocation).

Tokens at rest should be treated like Dropbox tokens: plain in Redis, never logged. Blot has no existing helper for encrypting stored credentials — Dropbox and Google Drive tokens are not encrypted at rest either — so this plan does not invent one either; encryption-at-rest is a broader secrets project, not GitHub-specific.

Installation tokens are **not** stored; mint from the private key when needed (`iss` = App ID, `iat`/`exp`, RS256) then `POST /app/installations/{id}/access_tokens`.

---

## Dashboard, docs, and switching clients

- Icon: `app/views/images/sync/github.svg` (the picker uses `/images/sync/{{name}}.svg`).
- Brochure page: `app/views/how/sync/github.html`, linked from `app/views/how/sync/index.html`. The current Git page (`app/views/how/sync/git.html`) documents the blot.im-hosted remote and the “add GitHub as a second remote” workaround; once this client ships, that workaround section should point people at GitHub instead.
- Switching away: `disconnect` as above; the folder on disk stays, the next client uploads or downloads it. Same contract as `app/clients/README` (“Switching between clients should be seamless”).

---

## Limits, abuse, and things that will go wrong

- **File size.** GitHub rejects blobs over 100 MB; warns at 50 MB. Mirror Dropbox: skip / placeholder, tell the user.
- **Git LFS.** Pointer files would sync as tiny text files; the real binaries would not. The existing Git client already has an LFS TODO. Out of scope for v1; document the limitation.
- **Rate limits.** Installation tokens start at 5,000 req/hour and scale. A push that changes 200 files is ~200 blob fetches — fine. A full transfer of a huge repo should throttle and resume.
- **Large first transfer.** Same operational risk as Git client setup (`TODO`: “large pushes overwhelm the main server”). Hold the sync lock, stream blobs, bound concurrency, make setup resumable.
- **Default branch `main` vs `master`.** Store whatever GitHub reports. The existing Git client’s `master`-only rule is a frequent footgun for GitHub users; do not copy it.
- **Submodules and symlinks.** Skip; do not fail the whole sync if we can skip the entry and record it.
- **Empty commits / tag pushes.** Ignore `ref` that is not the tracked branch.
- **Force push / history rewrite.** Treat as a full diff against `after`, not as a sequence of `commits[]`.
- **Private org repos.** Installing on an org repo needs org owner or repo admin. If org owners restrict apps, the user will see GitHub’s request-to-install screen; Blot just waits for a successful callback.
- **SAML SSO orgs.** GitHub may require an active SAML session before the user token can see org repos. Surface GitHub’s error; ask the user to SSO and reconnect.
- **Two Blot sites, one repo.** Refuse at picker time. Webhook fan-out to two blogs would fight over the same folder contents.
- **Webhook loop.** Filter `blot[bot]` pushes we originated.
- **Deleted files on GitHub vs placeholders.** There is an existing `TODO` about placeholder files being lost when switching clients. A GitHub download of an “empty” placeholder should not overwrite a real file without a content check; follow whatever Dropbox/iCloud do once that bug is fixed.
- **GitHub outage.** Dashboard error, retry webhook deliveries (GitHub retries), periodic SHA check.

---

## Suggested implementation order

None of this is code; it is a sequence so the work can be split.

1. **GitHub App registration** (production + dev) and secrets in config, following the steps above. Client hidden on the dashboard until this exists (`app/clients/index.js` gate).
2. **Skeleton client**: `display_name`, no-op `write`/`remove`/`disconnect`, dashboard connect page, site webhook that verifies signatures and 200s.
3. **OAuth + install + repo picker**, Redis model, cookie/`state` plumbing, webhook relay redirect.
4. **Transfer**: empty-repo upload, empty-local download, conflict chooser, progress bar.
5. **Push webhook → delta sync** with folder lock and `folder.update`.
6. **Real `write`/`remove`** (Contents API / Git Database API) and loop suppression.
7. **Disconnect, revoke, rename, uninstall** webhook handling and dashboard errors.
8. **Resync**, hourly SHA check, tests (nock GitHub HTTP; no live network in CI).
9. **Docs** (how/sync/github.html), icon, news note. Tell the customers named in `TODO`.

---

## Open questions

1. **Create-repo in the picker?** Convenient for people with no existing repo, but `POST /user/repos` needs the `Administration` repository permission on the GitHub App (or a user token with `repo`/`public_repo` scope) — broader than the `Contents`/`Metadata` permissions this plan otherwise grants. Safer v1: only attach an existing repo; the user creates it on GitHub in 10 seconds.
2. **Subfolder of a repo** (e.g. `/blog` in a monorepo). Not requested. Add later as an optional path prefix on the same GitHub APIs.
3. **GitHub Enterprise Server.** Out of scope; would need a configurable API origin.
4. **GitLab / Bitbucket.** Separate clients. This plan is GitHub-only.
5. **Uninstall on last disconnect?** See disconnect section. Recommend no.
6. **Should draft preview files be committed?** The Git client commits them today. Matching that keeps client behavior uniform, at the cost of preview-file commits on GitHub. Revisit globally rather than special-casing GitHub.

---

## References (current GitHub docs)

- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)
- [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Git trees API](https://docs.github.com/en/rest/git/trees)
- [Choosing permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

Blot code this plan is based on:

- Client contract: `app/clients/index.js`, `app/clients/README`
- Dropbox OAuth + webhook: `app/clients/dropbox/routes/dashboard.js`, `app/clients/dropbox/routes/site.js`, `app/clients/dropbox/routes/setup/`
- Google Drive transfer + progress: `app/clients/google-drive/sync/resetToDrive.js`, `app/clients/google-drive/routes/setup.js`
- Existing Git remote: `app/clients/git/`
- Webhook relay: `app/clients/webhooks.js`, `config/index.js` (`webhooks.*`)
- Dashboard mounting: `app/dashboard/site/client.js`
- Config secrets pattern: `config/index.js`, `config/environment.sh`
