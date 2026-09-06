const { resolve } = require("path");

const environment =
  process.env.NODE_ENV === "production" ? "production" : "development";

const BLOT_DIRECTORY =
  process.env.BLOT_DIRECTORY || resolve(__dirname + "/../");
const BLOT_DATA_DIRECTORY =
  process.env.BLOT_DATA_DIRECTORY || BLOT_DIRECTORY + "/data";
const BLOT_HOST = process.env.BLOT_HOST || "localhost";
const BLOT_PORT = process.env.BLOT_PORT || "8080";
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

// See the "airlock" config block below. A warning, not a thrown error that
// would crash every container on boot over a single misconfigured/down
// dependency - but it means bookmark screenshots and remote-image downloads
// are fetching user-controlled URLs directly, with no SSRF protection. Once
// the airlock deploy has been stable for a while, consider tightening this
// to fail closed (but only after confirming the airlock, not blindly).
if (
  environment === "production" &&
  !(process.env.BLOT_AIRLOCK_BROWSER_URL && process.env.BLOT_AIRLOCK_PROXY_URL)
) {
  console.warn(
    "WARNING: BLOT_AIRLOCK_BROWSER_URL / BLOT_AIRLOCK_PROXY_URL are not both " +
      "set in production. Bookmark-link screenshots and remote-image " +
      "downloads are fetching user-controlled URLs directly, with no SSRF " +
      "protection. See config/airlock/README.md."
  );
}

module.exports = {
  // codebase expects either 'production' or 'development'
  environment,
  host: BLOT_HOST,
  reverse_proxies,
  protocol: BLOT_PROTOCOL + "://",
  master: process.env.CONTAINER_NAME === "blot-container-green",
  // map 'blot-container-<container-name>' to 'container-name'
  container: (process.env.CONTAINER_NAME || "").split("-").slice(2).join("-"),

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

  maintenance: process.env.BLOT_MAINTENANCE === "true",
  cache: process.env.BLOT_CACHE === "true",
  debug: process.env.BLOT_DEBUG === "true",

  // These directories are used by the application
  blot_directory: BLOT_DIRECTORY,
  data_directory: BLOT_DATA_DIRECTORY,
  views_directory: BLOT_DIRECTORY + "/app/views-built",
  tmp_directory: process.env.BLOT_TMP_DIRECTORY || BLOT_DATA_DIRECTORY + "/tmp",
  log_directory:
    process.env.BLOT_LOG_DIRECTORY || BLOT_DATA_DIRECTORY + "/logs",
  blog_static_files_dir: BLOT_DATA_DIRECTORY + "/static",
  blog_folder_dir: BLOT_DATA_DIRECTORY + "/blogs",

  ip: process.env.BLOT_IP || "127.0.0.1",
  ipv6: BLOT_IPV6,

  port: BLOT_PORT,
  clients_port: 8888,

  redis: { port: 6379, host: process.env.BLOT_REDIS_HOST || "127.0.0.1" },

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

  pandoc: {
    bin: process.env.BLOT_PANDOC_PATH || "pandoc",
    maxmemory: "500M", // 500mb
    timeout: 10000, // 10s
  },

  // The "airlock" container (config/airlock) is the single egress point for
  // fetching untrusted, user-supplied URLs: bookmark-link screenshots and
  // remote images referenced in posts. When these are unset the app talks to
  // the network directly - fine for local development, but with no SSRF
  // protection (see the production warning above). See config/airlock/README.md.
  airlock: {
    // Chromium DevTools endpoint, e.g. http://airlock:9222 - consumed by
    // app/helper/screenshot.
    browser_url: process.env.BLOT_AIRLOCK_BROWSER_URL || null,
    // HTTP(S) forward proxy, e.g. http://airlock:8888 - consumed by
    // app/helper/transformer/download.
    proxy: process.env.BLOT_AIRLOCK_PROXY_URL || null,
  },

  paypal: {
    client_id: process.env.BLOT_PAYPAL_CLIENT_ID,
    secret: process.env.BLOT_PAYPAL_SECRET,

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

  aws: {
    key: process.env.BLOT_AWS_KEY,
    secret: process.env.BLOT_AWS_SECRET,
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
