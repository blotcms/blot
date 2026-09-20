# OneDrive client: plan

Add **OneDrive** as a folder client using OAuth 2.0 and Microsoft Graph. It is
shaped like the Dropbox client (`app/clients/dropbox`): the user consents, Blot
stores a refresh token, a webhook pings Blot, Blot pulls a delta and updates
the folder. It is not shaped like iCloud, which only exists to work around a
missing API.

Decisions so far:

- **App folder only.** Scope `Files.ReadWrite.AppFolder`; files live in
  `/Apps/<app name>/` in the user's OneDrive. No full-drive mode.
- **Personal and work/school accounts**, via the `common` authority.
- Register **two** Entra apps: production (`Blot`) and development
  (`Blot Dev`), as Dropbox does.

## Getting the credentials (Microsoft Entra)

You need a Microsoft account to sign in to the portal. A free Azure account is
enough; app registrations cost nothing.

1. Go to <https://entra.microsoft.com> > **Identity > Applications > App
   registrations > New registration**. (Same page as Azure portal > "App
   registrations".)
2. **Name:** `Blot` (this name is shown on the consent screen, and it becomes
   the app folder name in OneDrive, so pick it deliberately). Use `Blot Dev`
   for the development app.
3. **Supported account types:** "Accounts in any organizational directory
   and personal Microsoft accounts". This is what allows both work/school and
   consumer OneDrive.
4. **Redirect URI:** platform **Web**. Production:
   `https://blot.im/clients/onedrive/authenticate`. Development: the same path
   on your dev host, e.g. `http://localhost:8080/clients/onedrive/authenticate`
   (Microsoft allows `http` for `localhost` only). The exact path may change
   when the OAuth flow is built; it can be edited later.
5. Click **Register**. On the Overview page copy the **Application (client)
   ID**. This is `BLOT_ONEDRIVE_CLIENT_ID`.
6. **Certificates & secrets > Client secrets > New client secret.** Copy the
   secret **Value** immediately (it is shown once; do not copy the Secret ID).
   This is `BLOT_ONEDRIVE_CLIENT_SECRET`. Secrets expire (24 months maximum),
   so put the expiry date in a calendar; an expired secret silently breaks
   token refresh for every connected site.
7. **API permissions > Add a permission > Microsoft Graph > Delegated
   permissions**, add `Files.ReadWrite.AppFolder`, `offline_access` and
   `User.Read` (sign-in profile). None of these require admin consent for
   personal accounts; some organisations may still restrict user consent.
8. **Authentication > Advanced settings:** leave "Allow public client flows"
   off.
9. `BLOT_ONEDRIVE_WEBHOOK_SECRET` is not from Microsoft: generate it with
   `openssl rand -hex 32`. It is sent to Graph as the subscription
   `clientState` and must be echoed back on every notification.
10. Set the three variables in the environment (`config/environment.sh` lists
    them). The client stays hidden on the dashboard until all three are set.

Later, before real users connect: complete Microsoft **publisher
verification** (Entra > the app > Branding & properties > Publisher domain,
plus a Microsoft Partner Network account). Until then the consent screen shows
an "unverified" warning. This has a business-process lead time, so start early.

Notification URLs must be public HTTPS, so local development needs a tunnel
(or the existing `webhooks.blot.im` relay) to receive Graph webhooks.

## How it fits Blot's client model

Same contract as the other clients (`app/clients/README`): `display_name`,
`description`, `disconnect`, `write`, `remove`, `dashboard_routes`,
`site_routes`; `resync`, `init` and `getHealth` are optional. Site routes are
mounted at `https://blot.im/clients/onedrive/...`.

## Suggested order

1. **Skeleton** (this PR): registration gated on config, stub pages, webhook
   that handles the validation handshake and `clientState`.
2. **OAuth**: `/authenticate` callback exchanging the code at
   `https://login.microsoftonline.com/common/oauth2/v2.0/token`, refresh
   token handling, `database.js` for account state. Port of
   `dropbox/routes/setup`.
3. **Folder setup and transfer**: create/locate the app folder
   (`/me/drive/special/approot`), choose whether to copy existing files up or
   pull down, as Dropbox does.
4. **Delta sync**: `GET /me/drive/special/approot/delta`, store the
   `deltaLink`, apply deletions/dirs/downloads, handle `410 resyncRequired`
   with a full resync. Port of `dropbox/delta.js`. Handle case-only renames
   (OneDrive is case-insensitive).
5. **Webhook + subscriptions**: `POST /subscriptions` on the app folder,
   renew via `PATCH /subscriptions/{id}` before the ~30-day maximum expiry,
   with a scheduled job (shape borrowed from Google Drive's
   `watchChanges.js`) and a polling fallback in `init.js`. Note that delta
   changes are notified on the drive root for personal accounts; confirm
   subscription scope for `approot` against a real account.
6. **write/remove**: upload (simple PUT up to 4 MB, upload session above),
   delete, suppressing the resulting webhook echo.
7. **Throttling and errors**: 429 + `Retry-After` backoff (see
   `dropbox/util/retry.js`), `getHealth`, disconnect/revoke handling.
8. **Docs and publisher verification.**

## Data to store (Redis, per blog)

Account id and type (personal vs work/school), refresh token, delta cursor
(`deltaLink`), subscription id and expiry, app folder item id, and a
subscription-id -> blog index for webhook lookup. Details to be settled in
step 2.

## Open questions

- Confirm `Files.ReadWrite.AppFolder` works for OneDrive for Business
  (work/school) accounts end to end; app folders are documented mainly for
  personal accounts. If not, work/school users may need `Files.ReadWrite`.
- Confirm delta and subscription behaviour on `approot` versus the drive root.
