import * as brctl from "../brctl/index.js";
import { promisify } from "util";
import fs from "fs-extra";
import { statfs as statfsSync } from "fs";
import { iCloudDriveDirectory } from "../config.js";
import clfdate from "../util/clfdate.js";

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
    const stats = await statfs('/');
    // get disk free space in bytes
    result.disk_bytes_available = stats.bavail * stats.bsize
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
    console.error(clfdate(), `Error getting number of blogs connected: ${error}`);
  }

  console.log(clfdate(), "Sending stats:", result);
  res.json(result);
};
