# OneDrive client: plan

Add **OneDrive** as a folder client using OAuth 2.0 and Microsoft Graph. It is
shaped like the Dropbox client (`app/clients/dropbox`): the user consents, Blot
stores a refresh token, a webhook pings Blot, Blot pulls a delta and updates
the folder. It is not shaped like iCloud, which only exists to work around a
missing API.

Decisions so far:

- **App folder only.** Scope `Files.ReadWrite.AppFolder`; files live in
  `/Apps/<app name>/` in the user's OneDrive. No full-drive mode.
- **Personal Microsoft accounts only for v1.** Work/school support is
  deferred until Blot has a formal business entity and can be publisher
  verified (see "Publisher verification"). The code should use the
  `consumers` authority for now; switching to `common` later is a config
  change plus the admin-consent handling described below.
- Register **two** Entra apps: production (`Blot`) and development
  (`Blot Dev`), as Dropbox does.

## Getting the credentials (Microsoft Entra)

### 0. Create an Entra tenant (required, do this first)

Blot must own a **Microsoft Entra tenant** (a free directory) and register the
app inside it. Do not register the app under a personal Microsoft account:
apps registered that way cannot be publisher verified later, and moving to a
new registration would change the client ID and force every connected user to
reconnect. Owning a tenant now also means widening to work/school accounts
later is a settings change, not a migration.

1. Go to <https://entra.microsoft.com> and choose to create a new tenant (or
   sign up at <https://azure.microsoft.com/free>, which creates one). Use a
   Microsoft account that will remain the long-term owner, ideally a shared
   Blot address rather than one person's inbox.
2. Create the tenant as a standard **Microsoft Entra ID** workforce tenant with
   a name like `Blot`. Its default domain is `<name>.onmicrosoft.com`; that is
   fine for now (publisher verification later needs a custom domain such as
   blot.im, added under Entra > Custom domain names and verified via DNS).
3. Note the **tenant ID** (Entra > Overview). It isn't needed in config for v1
   (the `consumers` authority is used), but keep it with the credentials.
4. Make sure at least two people have the Global Administrator (or
   Application Administrator) role so the registration is not held by a single
   account, and turn on MFA for them (Microsoft requires it for portal admin
   access and for publisher verification later).
5. A free Azure account may ask for a card at sign-up; registering an app does
   not create billable resources.

### Register the app

Sign in to the portal as a user in that tenant with the Application
Administrator or Cloud Application Administrator role. A free tenant is
enough, and app registrations cost nothing.

1. Go to <https://entra.microsoft.com> > **Identity > Applications > App
   registrations > New registration**. (Same page as Azure portal > "App
   registrations".)
2. **Name:** `Blot` (this name is shown on the consent screen, and it becomes
   the app folder name in OneDrive, so pick it deliberately). Use `Blot Dev`
   for the development app.
3. **Supported account types:** "Personal Microsoft accounts only" for v1.
   When work/school support is added, change this to "Accounts in any
   organizational directory and personal Microsoft accounts" (Authentication
   blade); the client ID stays the same, which is why the app should be
   registered in an Entra tenant you own now (see above) even though v1 is
   personal-only.
4. **Redirect URI:** platform **Web**. Production:
   `https://blot.im/clients/onedrive/authenticate`. Development: the same path
   on your dev host, e.g. `http://localhost:8080/clients/onedrive/authenticate`
   (Microsoft allows `http` for `localhost` only). The exact path may change
   when the OAuth flow is built; it can be edited later.
5. Click **Register**. On the Overview page copy the **Application (client)
   ID**. This is `BLOT_ONEDRIVE_CLIENT_ID`.
6. **Certificates & secrets > Client secrets > New client secret.** Copy the
   secret **Value** immediately (it is shown once; do not copy the Secret ID).
   This is `BLOT_ONEDRIVE_CLIENT_SECRET`. Secrets expire (the portal offers
   presets and a custom date, up to 24 months), so put the expiry date in a
   calendar. Rotate without downtime by creating a second secret before the
   first expires, deploying it, then deleting the old one. Microsoft
   recommends a certificate over a secret; that is a possible later
   hardening, not needed for the skeleton. See "Secret expiry and user
   re-authentication" below.
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

## Publisher verification

Without it, the consent screen shows an "unverified publisher" warning.
Personal accounts are unaffected beyond that, so **v1 (personal only) does not
need verification.** It matters for work/school accounts:

- Microsoft recommends tenants allow user consent only for apps from verified
  publishers, and the built-in policy for that
  (`microsoft-user-default-low`) blocks unverified apps for users. Tenants on
  it will block Blot's users from connecting.
- Microsoft's documented default, where a user can consent to any permission
  that doesn't need admin consent, would likely allow
  `Files.ReadWrite.AppFolder` (narrow, unlike "all files"), but many schools
  and companies tighten this or disable user consent entirely, in which case
  an admin has to approve regardless of verification.
- With risk-based step-up consent enabled, users can't consent to unverified
  multi-tenant apps requesting more than basic sign-in.
- Where users can't consent, an **admin consent workflow** lets them request
  approval, and an admin can approve via an admin-consent URL. Work/school
  support should link to that flow instead of dead-ending.

**Cost:** none. Microsoft states there is no charge and no licence required.

**Requires a formal business.** Partner Center business verification confirms
"your business is legally registered with an active registration at the
stated address". It asks for formation documents (articles or certificate of
incorporation, business licence or registration certificate) whose name and
address match the account exactly, current domain-registration documents, a
government-ID identity check of a user, and an employee business email (not a
free or personal address). Microsoft says this typically takes three to five
business days. Microsoft's profile guidance says a sole proprietor should use
their company name as the legal name, so a registered sole proprietorship
with a business licence or DBA may qualify, but the docs don't spell out
eligibility and an unregistered informal project would not have registration
records to submit. Treat "form the US entity first" as the plan; check
eligibility with Partner Center before relying on any other route.

Prerequisites (all from Microsoft's "Publisher verification overview"):

1. A **Partner One ID** for a CPP account that has completed verification
   (enrol at <https://partner.microsoft.com/membership>). It must be the
   organisation's **partner global account (PGA)**, not a location ID.
2. The app registered with an **Entra work or school account** (see above).
3. The Entra tenant that holds the app must be associated with the PGA.
4. The app needs a **publisher domain** (Branding & properties) that is not
   `*.onmicrosoft.com`.
5. The domain of the email address used to verify the CPP account must match
   the app's publisher domain, or be a DNS-verified custom domain on the
   tenant.
6. The person doing it needs Application Administrator or Cloud Application
   Administrator in Entra **and** CPP Partner Admin or Account Admin in Partner
   Center, and must sign in with **MFA**.
7. Accept the Microsoft identity platform for developers Terms of Use.

Then: Entra admin center > App registrations > the app > **Branding &
properties** > **Add Partner ID to verify publisher** > enter the Partner One
ID > **Verify and save**. A blue verified badge should appear on the consent
screen shortly after (test with `prompt=consent`, never hard-code it).

Do this for **each** app (`Blot` and, if wanted, `Blot Dev`). Not supported in
national clouds or Azure AD B2C tenants.

## Secret expiry and user re-authentication

Expiry of the app's client secret does **not** force users to re-authenticate.
Refresh tokens are bound to the user and client, and a secret expiring is not
among Microsoft's documented revocation causes; a new secret works with
existing refresh tokens. What an expired secret does do is stop every token
refresh and code exchange until the new secret is deployed, so sync and new
connections fail for everyone until then. Hence the calendar reminder and the
overlapping-secret rotation above.

The real re-authentication risk is refresh token age: Microsoft documents a
90 day default lifetime for these flows, replaced with a fresh token on each
use. A connection whose refresh token isn't used for 90 days will need the user
to reconnect. The polling fallback in `init.js` (step 5 of the order below)
keeps tokens in use, and the client should surface "reconnect OneDrive" via
`getHealth` when a refresh fails with `invalid_grant`. Users can also revoke
access, or an admin can, which has the same effect.

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
2. **OAuth** (done in this PR): `/authenticate` callback exchanging the code at
   `https://login.microsoftonline.com/common/oauth2/v2.0/token`, refresh
   token handling, `database.js` for account state. Port of
   `dropbox/routes/setup`.
3. **Folder setup and transfer** (done): create a per-blog folder inside the
   app folder (`/me/drive/special/approot`) and upload the blog's files, as
   Dropbox does (we always create a fresh folder, so there is nothing to pull
   down and no upload/download choice). Includes `resync`
   (`reset-to-blot`), `reset-from-blot`, `getHealth`, and `write`/`remove`
   pushing to OneDrive.
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
