const config = require("config");
const email = require("helper/email");
const clfdate = require("helper/clfdate");
const prettySize = require("helper/prettySize");
const client = require("models/client");
const lock = require("helper/lock");
const { schedule } = require("clients/util/scheduleExclusive");

const MAC_SERVER_ADDRESS = config.icloud.server_address;
const Authorization = config.icloud.secret;

const DISK_SPACE_WARNING_THRESHOLD = config.icloud.diskSpaceWarning;
const DISK_SPACE_LIMIT = config.icloud.diskSpaceLimit;

const ICLOUD_SPACE_WARNING_THRESHOLD = config.icloud.iCloudSpaceWarning;
const ICLOUD_SPACE_LIMIT = config.icloud.iCloudSpaceLimit;

const DAY = 24 * 60 * 60 * 1000;

// Which notifications have gone out lives in Redis so that however many
// processes run the check, each condition emails once. The space warnings
// used to be sent once per process lifetime (until the next deploy), so they
// now repeat daily while the condition lasts. The "down" marker has no such
// repeat: it is cleared when the server recovers, which is what lets the next
// outage notify again; the long TTL only bounds a marker nobody cleared.
const SPACE_NOTIFICATION_TTL = DAY;
const DOWN_NOTIFICATION_TTL = 7 * DAY;

const fetch = require("./rateLimitedFetchWithRetriesAndTimeout");

const key = (type) => "icloud:macserver-stats:notified:" + type;

// True the first time within the ttl that a notification of this type is due
const shouldNotify = (type, ttl) => lock.once(key(type), ttl);

const check = async () => {
  console.log(clfdate(), "Checking Mac server stats");
  let stats;
  // Only a failure to fetch or validate /stats means the macserver is down.
  // Redis errors in the notification state below must never look like an outage.
  try {
    // fetching stats
    // readBody keeps the timeout armed while the body is read, so a stalled
    // reply fails the check instead of hanging it
    const body = await fetch(MAC_SERVER_ADDRESS + "/stats", {
      readBody: true,
      headers: { Authorization },
    });

    stats = JSON.parse(body.toString());

    if (!stats || !stats.disk_bytes_available) {
      throw new Error("No stats returned");
    }

    stats.disk_available_human = prettySize(stats.disk_bytes_available / 1000);

    // The macserver answers with a null iCloud quota when its own quota lookup
    // failed (e.g. a CloudKit network blip). It is up, so that is not an
    // outage: skip the quota checks until the next minute.
    if (stats.icloud_bytes_available) {
      stats.icloud_available_human = prettySize(
        stats.icloud_bytes_available / 1000
      );
    }
  } catch (error) {
    console.log(clfdate(), "Error connecting to mac server: ", error);
    try {
      if (await shouldNotify("icloud_server_down", DOWN_NOTIFICATION_TTL)) {
        email.ICLOUD_SERVER_DOWN();
      }
    } catch (redisError) {
      console.error(clfdate(), "Could not record server down", redisError);
    }
    return;
  }

  console.log(clfdate(), "Mac server stats: ", stats);

  try {
    // Check if server recovered from being down. DEL says whether the marker
    // was there, so exactly one process announces the recovery.
    if (await client.del(key("icloud_server_down"))) {
      email.ICLOUD_SERVER_RECOVERED();
    }

    if (stats.disk_bytes_available < DISK_SPACE_LIMIT) {
      console.log(clfdate(), "Disk space is low");
      if (await shouldNotify("disk_space_low", SPACE_NOTIFICATION_TTL)) {
        email.ICLOUD_DISK_LIMIT(null, stats);
      }
    } else if (stats.disk_bytes_available < DISK_SPACE_WARNING_THRESHOLD) {
      console.log(clfdate(), "Disk space is running out");
      if (await shouldNotify("disk_space_warning", SPACE_NOTIFICATION_TTL)) {
        email.ICLOUD_APPROACHING_DISK_LIMIT(null, stats);
      }
    }

    if (!stats.icloud_bytes_available) {
      console.log(clfdate(), "Mac server could not report iCloud quota");
    } else if (stats.icloud_bytes_available < ICLOUD_SPACE_LIMIT) {
      console.log(clfdate(), "iCloud drive space is low");
      if (await shouldNotify("icloud_space_low", SPACE_NOTIFICATION_TTL)) {
        email.ICLOUD_QUOTA_LIMIT(null, stats);
      }
    } else if (stats.icloud_bytes_available < ICLOUD_SPACE_WARNING_THRESHOLD) {
      console.log(clfdate(), "iCloud drive space is running out");
      if (await shouldNotify("icloud_space_warning", SPACE_NOTIFICATION_TTL)) {
        email.ICLOUD_APPROACHING_QUOTA_LIMIT(null, stats);
      }
    }
  } catch (error) {
    // Redis failure: skip notifying this tick, the next one retries
    console.error(clfdate(), "Could not update Mac server notifications", error);
  }
};

// Every minute, in one process per minute
module.exports = () => schedule("icloud-macserver-stats", "* * * * *", check);
module.exports.check = check;
