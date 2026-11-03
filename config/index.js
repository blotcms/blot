const { resolve } = require("path");

const environment =
  process.env.NODE_ENV === "production" ? "production" : "development";

const BLOT_DIRECTORY =
  process.env.BLOT_DIRECTORY || resolve(__dirname + "/../");
const BLOT_DATA_DIRECTORY =
  process.env.BLOT_DATA_DIRECTORY || BLOT_DIRECTORY + "/data";
// The app's scratch space, on the host's instance store in production
const BLOT_TMP_DIRECTORY =
  process.env.BLOT_TMP_DIRECTORY || BLOT_DATA_DIRECTORY + "/tmp";
const BLOT_HOST = process.env.BLOT_HOST || "localhost";
// Unix socket the server also listens on, for the reverse proxy; empty for none
const BLOT_SOCKET = process.env.BLOT_SOCKET || "";
// Set by helper/workerChild on the worker it forks: it serves on a socket only
const BLOT_WORKER_CHILD = process.env.BLOT_WORKER_CHILD === "true";
// Which unit (blue or green) this process runs in, when it shares a container
// with a proxy and a second Node process (#2119); empty otherwise
const BLOT_UNIT = process.env.BLOT_UNIT || "";
// The TCP port to serve on. A unit runs on the host's network, where two
// units would both want 8080, and everything that talks to a unit's node-a
// (the proxy, the image's health check, the deploy) uses its socket, so in a
// unit the process serves on the socket alone unless BLOT_PORT asks for a port.
const BLOT_PORT = process.env.BLOT_PORT || (BLOT_UNIT ? "" : "8080");
const BLOT_PROTOCOL = process.env.BLOT_PROTOCOL || "https";
const BLOT_IPV6 = process.env.BLOT_IPV6 || null;

const BLOT_CDN = BLOT_PROTOCOL + "://cdn." + BLOT_HOST;

// The private IP addresses of the proxies which point to this server
// we need to know this to flush the cache on each proxy when a blog is updated
const reverse_proxies = process.env.BLOT_REVERSE_PROXY_URLS
  ? process.env.BLOT_REVERSE_PROXY_URLS.split(",")
  : environment === "production"
  ? ["http://127.0.0.1:80"]
  : [];

// See the "egress" and "sandbox" config blocks below. This is a warning, not a
// thrown error: a unit deployed without the sandbox must not crash on boot. It
// does NOT mean user-controlled URLs are fetched directly - sandbox/fetch
// and helper/screenshot fail those operations closed in production (the post
// builds without the image or screenshot, the domain check errors) rather
// than falling back to an unprotected fetch. The warning just flags that this
// container was deployed without BLOT_SANDBOX=1 (proxy/deploy/common.sh), so
// those features are broken until it is redeployed with it.
if (
  environment === "production" &&
  !(process.env.BLOT_EGRESS_PROXY_URL && process.env.BLOT_SANDBOX_SOCKET)
) {
  console.warn(
    "WARNING: this production container has no sandbox (BLOT_SANDBOX_SOCKET, " +
      "BLOT_EGRESS_PROXY_URL). Bookmark-link screenshots, remote-image " +
      "downloads and user-domain checks fail closed until it is redeployed " +
      "with BLOT_SANDBOX=1. See app/sandbox/README.md."
  );
}

module.exports = {
  // codebase expects either 'production' or 'development'
  environment,
  host: BLOT_HOST,
  reverse_proxies,
  // Shared secret sent as X-Blot-Purge-Token when purging the reverse
  // proxies. Optional: the proxies only require it if they are given the
  // same BLOT_PURGE_TOKEN.
  purge_token: process.env.BLOT_PURGE_TOKEN,
  protocol: BLOT_PROTOCOL + "://",
  // A worktree preview sidecar sharing the dev stack's Redis
  // (scripts/development/worktrees.md); it skips the scheduler, sync clients
  // and the start email.
  preview: process.env.BLOT_PREVIEW === "true",
  // The label for this process in logs, alerts and the per-process Redis
  // keys. In a unit, <unit>/node-a for the main process and <unit>/node-b for
  // the worker child it forks. Otherwise map 'blot-container-<container-name>'
  // to 'container-name'; a forked worker child shares its parent's
  // CONTAINER_NAME, so gets a suffix.
  container: BLOT_UNIT
    ? BLOT_UNIT + (BLOT_WORKER_CHILD ? "/node-b" : "/node-a")
    : (process.env.CONTAINER_NAME || "").split("-").slice(2).join("-") +
      (BLOT_WORKER_CHILD ? "-worker" : ""),
  worker_child: BLOT_WORKER_CHILD,
  // The socket for a worker child to serve on: set, the process forks one
  // (see helper/workerChild) and supervises it
  worker_socket: process.env.BLOT_WORKER_SOCKET || "",
  // The forked worker's --max-old-space-size in MB, or Node's default
  // Multiplies the byte and entry caps of the in-memory render caches
  // (blog/lib/cacheMetrics); 1 when unset. A forked worker child gets a small
  // one unless BLOT_WORKER_CACHE_SCALE says otherwise (helper/workerChild).
  cache_scale: parseFloat(process.env.BLOT_CACHE_SCALE) || 1,
  worker_max_old_space_size: parseInt(process.env.BLOT_WORKER_MAX_OLD_SPACE_SIZE) || null,

  webhooks: {
    client_max_body_size: 1e8, // 100MB
    // ensure the reverse proxy supports SSE
    // on this host otherwise we can't relay webhooks
    server_host: "webhooks." + BLOT_HOST,
    secret: process.env.BLOT_WEBHOOKS_SECRET,
    // we have to hard-code these so the redirects
    // for oauth2 work correctly – the production server
    // needs to know the development server's host and 
    // the development server needs to know the production
    // server's host. This let's us use the same code
    relay_host: "webhooks.blot.im",
    development_host: "local.blot",
  },

  cache: process.env.BLOT_CACHE === "true",
  debug: process.env.BLOT_DEBUG === "true",

  // These directories are used by the application
  blot_directory: BLOT_DIRECTORY,
  data_directory: BLOT_DATA_DIRECTORY,
  views_directory: BLOT_DIRECTORY + "/app/views-built",
  tmp_directory: BLOT_TMP_DIRECTORY,
  log_directory:
    process.env.BLOT_LOG_DIRECTORY || BLOT_DATA_DIRECTORY + "/logs",
  blog_folder_dir: BLOT_DATA_DIRECTORY + "/blogs",
  ip: process.env.BLOT_IP || "127.0.0.1",
  ipv6: BLOT_IPV6,

  port: BLOT_PORT,
  socket: BLOT_SOCKET,
  clients_port: 8888,

  redis: {
    port: 6379,
    host: process.env.BLOT_REDIS_HOST || "127.0.0.1",
    // Path of a Unix socket. When set, clients use it instead of host and port
    // and never fall back to TCP; when unset, TCP as before.
    socket: process.env.BLOT_REDIS_SOCKET || undefined,
  },

  admin: {
    uid: process.env.BLOT_ADMIN_UID,
    email: process.env.BLOT_ADMIN_EMAIL,
  },

  dropbox: {
    app: {
      key: process.env.BLOT_DROPBOX_APP_KEY,
      secret: process.env.BLOT_DROPBOX_APP_SECRET,
    },
    full: {
      key: process.env.BLOT_DROPBOX_FULL_KEY,
      secret: process.env.BLOT_DROPBOX_FULL_SECRET,
    },
  },

  stripe: {
    key: process.env.BLOT_STRIPE_KEY,
    secret: process.env.BLOT_STRIPE_SECRET,
    // When set, incoming Stripe webhooks are verified against this signing
    // secret (see app/dashboard/webhooks/stripe_webhook). Leave it unset to
    // skip verification, preserving the previous behaviour.
    webhook_secret: process.env.BLOT_STRIPE_WEBHOOK_SECRET,
    // Ensure that each monthly plan has a corresponding
    // annual plan, and vice versa, and that these IDs
    // correspond to plans on Stripe in both live and
    // test modes when you change Blot's price.
    plan: "monthly_6",

    plan_map: {
      yearly_30: "monthly_3",
      monthly_3: "yearly_30",

      yearly_20: "monthly_2",
      monthly_2: "yearly_20",

      yearly_44: "monthly_4",
      monthly_4: "yearly_44",

      yearly_55: "monthly_5",
      monthly_5: "yearly_55",

      monthly_6: "yearly_72",
      yearly_72: "monthly_6",
    },
  },

  // Whether the pandoc converters are loaded. Its heap and time limits are
  // in the sandbox job, app/sandbox/jobs/pandoc.js, which runs it.
  pandoc: {
    bin: process.env.BLOT_PANDOC_PATH || "pandoc",
  },

  // How many git commands each Node process runs at once
  // (app/clients/git/limiter.js). A unit runs two Node processes and git
  // shares its memory limit with them. One git command (a few processes) takes
  // up to about 100 MB with the settings limiter.js passes. Interactive is 4
  // because a slow client's clone or push holds its place for the whole
  // transfer, and a push should not wait behind two slow clones: 4 is about
  // 400 MB at the very worst, on node-b, which serves every push, clone and
  // fetch. Background is 2, about 200 MB at worst, though Blot's commits, most
  // of it, take a few MB each; gc is the large background command, and only
  // one runs at a time. So about 600 MB a process at the very worst.
  // gc_delay is how long after a commit or push a repository waits for its
  // gc, so a burst of writes makes one (gc.js).
  git: {
    interactive_processes: parseInt(process.env.BLOT_GIT_INTERACTIVE_PROCESSES) || 4,
    background_processes: parseInt(process.env.BLOT_GIT_BACKGROUND_PROCESSES) || 2,
    gc_processes: parseInt(process.env.BLOT_GIT_GC_PROCESSES) || 1,
    gc_delay: parseInt(process.env.BLOT_GIT_GC_DELAY_MS) || 60 * 1000,
  },

  // Untrusted, user-supplied URLs (remote images in posts, imports, domain
  // checks) are fetched in the sandbox's fetch and fetch-image jobs, behind the
  // jail's egress filter (app/sandbox/README.md). What is here is for the
  // fail-closed checks and the proxy jail's health check.
  egress: {
    // The forward proxy in the sandbox's proxy jail in each unit, e.g.
    // http://127.0.0.1:18988, which replaced the airlock container (#2257).
    // Nothing in the app fetches through it now; the alerts still watch it.
    proxy: process.env.BLOT_EGRESS_PROXY_URL || null,
    // When true (production), a user-controlled fetch or screenshot that
    // can't run in the sandbox fails instead of falling back to a direct one
    // (helper/egress, sandbox/fetch, helper/transformer/download). Read this
    // rather than re-deriving from environment.
    required: environment === "production",
  },

  // The sandbox broker's Unix socket (proxy/unit/sandbox, app/sandbox). Unset,
  // as in development and when the host has not turned the sandbox on,
  // app/sandbox runs its jobs in-process.
  sandbox: {
    socket: process.env.BLOT_SANDBOX_SOCKET || "",
    // Screenshots run as a sandbox job whenever there is a broker.
    browser: !!process.env.BLOT_SANDBOX_SOCKET,
  },

  paypal: {
    client_id: process.env.BLOT_PAYPAL_CLIENT_ID,
    secret: process.env.BLOT_PAYPAL_SECRET,
    // When set, incoming PayPal webhooks are verified via PayPal's
    // verify-webhook-signature API (see app/dashboard/webhooks/paypal_webhook).
    // Leave it unset to skip verification, preserving the previous behaviour.
    webhook_id: process.env.BLOT_PAYPAL_WEBHOOK_ID,

    plan: process.env.BLOT_PAYPAL_MONTHLY_6,

    plans: {
      monthly_4: process.env.BLOT_PAYPAL_MONTHLY_4,
      yearly_44: process.env.BLOT_PAYPAL_YEARLY_44,
      monthly_5: process.env.BLOT_PAYPAL_MONTHLY_5,
      yearly_55: process.env.BLOT_PAYPAL_YEARLY_55,
      monthly_6: process.env.BLOT_PAYPAL_MONTHLY_6,
      yearly_72: process.env.BLOT_PAYPAL_YEARLY_72,
    },

    api_base: `https://api.${
      environment === "development" ? "sandbox." : ""
    }paypal.com`,
  },

  cdn: {
    origin: BLOT_CDN,
  },

  bunny: {
    secret: process.env.BUNNY_API_SECRET,
  },

  session: {
    secret: process.env.BLOT_SESSION_SECRET,
  },

  youtube: {
    secret: process.env.BLOT_YOUTUBE_SECRET,
  },

  // Which blogs' folder writes are mirrored to the storage bucket and
  // models/file after they land on disk (app/storage/folder/mirror.js,
  // #2258 Phase C): "off" (the default), "all", or blog IDs separated by
  // commas, e.g. "blog_abc,blog_def". Disk stays authoritative either way.
  // Read on every write, so it can be changed in place by specs.
  folder_mirror: process.env.BLOT_FOLDER_MIRROR || "off",

  // Shadow reads (app/storage/folder/shadow.js, #2258 Phase C): for the
  // mirrored blogs above, this fraction of folder reads is repeated against
  // the S3 backend once the disk has answered, and the two results compared
  // and timed. 0 (the default) is off, 1 is every read. Read on every call.
  // scripts/storage/shadow-report.js prints what it found.
  folder_shadow: {
    rate: Number(process.env.BLOT_FOLDER_SHADOW_RATE) || 0,
    // Shadow reads running at once in a process; a sample over this is dropped
    max_in_flight: 4,
    // Files bigger than this have their size compared, not their bytes
    max_compare_bytes: 16 * 1024 * 1024,
    // A mismatch is checked again after this long, so a read which raced a
    // sync (disk changed, S3 not yet) counts as transient, not as drift
    recheck_ms: 5000,
  },

  // Credentials for the S3 client in app/storage/s3.js. When these aren't
  // set the AWS SDK's default provider chain is used instead.
  aws: {
    key: process.env.BLOT_AWS_KEY,
    secret: process.env.BLOT_AWS_SECRET,
  },

  // Renewal of the wildcard certificate for BLOT_HOST and *.BLOT_HOST
  // (app/scheduler/renew-wildcard-ssl.js). It answers the ACME DNS-01
  // challenge in this Route 53 hosted zone, using the credentials in aws above.
  // Point the directory URL at Let's Encrypt staging to try it without limits.
  wildcardSSL: {
    hostedZoneId: process.env.BLOT_WILDCARD_SSL_HOSTED_ZONE_ID || "",
    directoryUrl:
      process.env.BLOT_ACME_DIRECTORY_URL ||
      "https://acme-v02.api.letsencrypt.org/directory",
  },

  // The S3 bucket behind app/storage. Today it holds generated per-blog
  // assets (app/storage/assets.js), their only home, keyed {blogID}/{path},
  // identical to the public CDN path. The app refuses to start without a
  // bucket.
  storage: {
    bucket: process.env.BLOT_STORAGE_BUCKET || "",
    region: process.env.BLOT_STORAGE_REGION || "us-west-2",
    // Set to point at a simulated S3 (MinIO) in development and tests.
    endpoint: process.env.BLOT_STORAGE_ENDPOINT || "",
  },

  // The git object store (app/clients/git/store) in shadow mode
  // (app/clients/git/shadow): the repositories on disk stay the source of
  // truth, and every push and every one of Blot's commits is also mirrored
  // into the storage bucket, under {blogID}/git/, to compare on real traffic.
  git_store: {
    // Off unless set: "all", or a comma-separated list of blog IDs
    shadow: process.env.BLOT_GIT_STORE_SHADOW || "",
    // The store's local cache and scratch space. In production tmp is on the
    // host's instance store (/var/instance-ssd/tmp), which is where this
    // belongs: nothing in it needs to survive. Each process takes a
    // directory of its own inside it.
    cache_directory:
      process.env.BLOT_GIT_STORE_CACHE_DIRECTORY ||
      BLOT_TMP_DIRECTORY + "/git-store",
    // The budget of each process's cache, scratch space included
    cache_bytes:
      parseInt(process.env.BLOT_GIT_STORE_CACHE_BYTES, 10) ||
      1024 * 1024 * 1024,
  },

  // The content cache of the S3 backend of storage/folder
  // (app/storage/folder/cache.js, #2258): bytes of blog files read from the
  // bucket, kept on the instance store and bounded by max_bytes. Files over
  // max_file_bytes are read and served straight from S3; ensureLocal caches
  // any size. min_free_percent makes it give room back when the disk itself
  // runs low.
  folder_cache: {
    directory:
      process.env.BLOT_FOLDER_CACHE_DIRECTORY ||
      BLOT_TMP_DIRECTORY + "/storage-folder-cache",
    max_bytes:
      Number(process.env.BLOT_FOLDER_CACHE_MAX_BYTES) || 50 * 1024 * 1024 * 1024,
    max_file_bytes:
      Number(process.env.BLOT_FOLDER_CACHE_MAX_FILE_BYTES) || 4 * 1024 * 1024,
    min_free_percent: 10,
  },

  mailgun: {
    key: process.env.BLOT_MAILGUN_KEY,
    domain: "blot.im",
    from: "Blot <contact@blot.im>",
  },

  backup: {
    bucket: "blot-daily-backups",
    password: process.env.BLOT_BACKUP_SECRET,
  },

  // Microsoft Entra app used for the OneDrive folder-sync client
  // (app/clients/onedrive). app/clients/index.js only registers the
  // client once these are all set. webhook_secret is any long random
  // string; it is sent to Microsoft Graph as the subscription's
  // clientState and echoed back on every change notification.
  onedrive: {
    client_id: process.env.BLOT_ONEDRIVE_CLIENT_ID,
    client_secret: process.env.BLOT_ONEDRIVE_CLIENT_SECRET,
    webhook_secret: process.env.BLOT_ONEDRIVE_WEBHOOK_SECRET,
  },

  google_drive: {
    service_accounts: (() => {
      try {
        // Check if the environment variable is defined and not empty
        if (!process.env.BLOT_GOOGLEDRIVE_SERVICE_ACCOUNT_IDS) {
          return [];
        }

        // Split the environment variable into an array of IDs
        return process.env.BLOT_GOOGLEDRIVE_SERVICE_ACCOUNT_IDS.split(",")
          .map((service_account_id) => {
            try {
              // Retrieve the corresponding service account value
              const service_account =
                process.env[
                  `BLOT_GOOGLEDRIVE_SERVICE_ACCOUNT_${service_account_id.trim()}`
                ];

              // Validate and parse the service account if it exists
              if (service_account) {
                return JSON.parse(
                  Buffer.from(service_account, "base64").toString()
                );
              } else {
                console.warn(
                  "A service account is missing or undefined."
                );
                return null; // Return null for missing service accounts
              }
            } catch (err) {
              // Handle errors in parsing the individual service account
              console.error(
                "Failed to process a service account:",
                err.message
              );
              return null; // Return null when parsing fails
            }
          })
          .filter((account) => account !== null); // Filter out null entries
      } catch (err) {
        // Handle errors in the overall process
        console.error(
          "Failed to process Google Drive service accounts:",
          err.message
        );
        return []; // Return an empty array if any critical errors occur
      }
    })(),
  },
  
  icloud: {
    secret: process.env.BLOT_ICLOUD_SERVER_SECRET,
    server_address: process.env.BLOT_ICLOUD_SERVER_ADDRESS,
    email: process.env.BLOT_ICLOUD_EMAIL,
    // The maximum file size to sync with iCloud
    maxFileSize: 1e8, // 100MB
    // The thresholds for sending warning emails
    diskSpaceWarning: 4e9, // 4GB
    diskSpaceLimit: 1e9, // 1GB
    iCloudSpaceWarning: 2e9, // 2GB
    iCloudSpaceLimit: 1e9, // 1GB
  },
};
