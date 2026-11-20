import * as brctl from "../brctl/index.js";
import { promisify } from "util";
import fs from "fs-extra";
import { statfs as statfsSync } from "fs";
import { iCloudDriveDirectory } from "../config.js";
import clfdate from "../util/clfdate.js";
import processStats from "../util/processStats.js";
import availableMemory from "../util/availableMemory.js";
import { backlog } from "../pathOrder.js";
import { journalStatus } from "../journal.js";
import { waitingForFileProvider } from "../watcher/index.js";

const statfs = promisify(statfsSync);

// brctl quota can hang until the exec timeout (30s), longer than Blot waits
// for /stats, so a slow lookup must not hold up the reply. Reply with the last
// known quota (null until the first lookup finishes) and refresh it in the
// background, one lookup at a time.
let lastQuota = null;
let refreshing = false;

const refreshQuota = async () => {
  if (refreshing) return;
  refreshing = true;
  try {
    lastQuota = await brctl.quota();
  } catch (error) {
    console.error(clfdate(), `Error getting iCloud Drive quota: ${error}`);
    lastQuota = null;
  } finally {
    refreshing = false;
  }
};

export default async (req, res) => {
  const result = {};

  refreshQuota();
  // get iCloud Drive free space in bytes
  result.icloud_bytes_available = lastQuota;

  try {
    Object.assign(result, processStats());
  } catch (error) {
    console.error(clfdate(), `Error getting CPU and memory: ${error}`);
  }

  try {
    if (result.host_memory_total_bytes > 0)
      result.host_memory_available_bytes = await availableMemory(
        result.host_memory_total_bytes
      );
  } catch (error) {
    console.error(clfdate(), `Error getting available memory: ${error}`);
  }

  try {
    const stats = await statfs("/");
    // get disk free space and size in bytes
    result.disk_bytes_available = stats.bavail * stats.bsize;
    result.disk_bytes_total = stats.blocks * stats.bsize;
  } catch (error) {
    console.error(clfdate(), `Error getting disk free space: ${error}`);
  }

  try {
    // get number of blogs connected
    const blogs = await fs.readdir(iCloudDriveDirectory, {
      withFileTypes: true,
    });

    result.blogs_connected = blogs.filter((blog) => blog.isDirectory()).length;
  } catch (error) {
    console.error(
      clfdate(),
      `Error getting number of blogs connected: ${error}`
    );
  }

  // How far behind the macserver is, for Blot's delay alert
  // (clients/icloud/util/syncDelays.js)
  try {
    const queue = backlog();
    result.actions_pending = queue.pending;
    result.actions_oldest_ms = queue.oldestMs;
    result.actions_busiest_blog = queue.busiest?.blogID || null;
    result.actions_busiest_pending = queue.busiest?.pending || 0;

    const journal = journalStatus();
    result.journal_running = journal.running;
    result.journal_poll_age_ms = journal.pollAgeMs;
    result.journal_behind = journal.behind;

    const waiting = waitingForFileProvider();
    result.fileprovider_waiting = waiting.count;
    result.fileprovider_oldest_ms = waiting.oldestMs;
    result.fileprovider_gave_up_15m = waiting.gaveUpRecently;
  } catch (error) {
    console.error(clfdate(), `Error getting sync backlog: ${error}`);
  }

  console.log(clfdate(), "Sending stats:", result);
  res.json(result);
};
