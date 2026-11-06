import { execFile } from "child_process";
import { iCloudDriveDirectory } from "../config.js";
import clfdate from "../util/clfdate.js";

const POLL_INTERVAL = 15 * 1000; // Check every 15 seconds
const MAX_DISK_USAGE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB

// Tracks the last filesystem-driven update time for each blog
const blogUpdateTimes = new Map();

// We don't use ../exec because it can't tolerate stderr or non-zero exit codes
// which happens when there is a file in someone's folder with a name that's too
// long and produces du:  File name too long
const getDiskUsage = () => {
  return new Promise((resolve, reject) => {
    // Run du -sk <dir> with stderr redirected to /dev/null
    console.log(clfdate(), "Getting disk usage for iCloud Drive...");
    execFile(
      "du",
      ["-sk", iCloudDriveDirectory],
      { stdio: ["ignore", "pipe", "ignore"] }, // [stdin, stdout, stderr]
      (_error, stdout) => {
        if (!stdout) {
          return reject(new Error("No output from du command"));
        }

        try {
          console.log(clfdate(), `Disk usage output: ${stdout}`);
          // Parse output
          const bytes = parseInt(stdout.split("\t")[0]) * 1024;
          console.log(clfdate(), `Disk usage: ${bytes} bytes`);
          resolve(bytes);
        } catch (parseError) {
          reject(new Error(`Error parsing du output: ${parseError.message}`));
        }
      }
    );
  });
};

const markBlogUpdated = (blogID, observedTimeMs = Date.now()) => {
  blogUpdateTimes.set(blogID, observedTimeMs);
};

const removeBlog = (blogID) => {
  blogUpdateTimes.delete(blogID);
};

// Sort blogs by their last update time (least recently updated first)
const sortBlogsByUpdateTime = () => {
  return Array.from(blogUpdateTimes.entries()).sort(
    ([, timeA], [, timeB]) => timeA - timeB
  );
};

const check = async (evictBlogDirectory) => {
  console.log(clfdate(), "Checking free disk space...");

  let diskUsage = await getDiskUsage();

  if (diskUsage < MAX_DISK_USAGE_BYTES) {
    console.log(
      clfdate(),
      `Disk usage is below threshold: ${diskUsage} bytes of ${MAX_DISK_USAGE_BYTES} bytes`
    );
    return;
  }

  const bytesToEvict = diskUsage - MAX_DISK_USAGE_BYTES;

  console.log(
    clfdate(),
    `Disk usage is above threshold: ${diskUsage} bytes, need to evict ${bytesToEvict} bytes`
  );

  const sortedBlogs = sortBlogsByUpdateTime();
  console.log(
    clfdate(),
    `Oldest-first eviction order: ${sortedBlogs.map(([blogID]) => blogID).join(", ") || "(none)"}`
  );

  for (const [blogID, updatedAt] of sortedBlogs) {
    const lastUpdatedSecondsAgo = (Date.now() - updatedAt) / 1000;
    console.log(
      clfdate(),
      `Eviction candidate blogID ${blogID} (target ./${blogID}), last updated ${lastUpdatedSecondsAgo.toFixed(1)}s ago`
    );

    await evictBlogDirectory(blogID);

    diskUsage = await getDiskUsage();
    console.log(
      clfdate(),
      `Disk usage after attempting blog ${blogID}: ${diskUsage} bytes of ${MAX_DISK_USAGE_BYTES} bytes`
    );

    if (diskUsage < MAX_DISK_USAGE_BYTES) {
      console.log(
        clfdate(),
        `Exiting eviction loop: usage is below quota (${diskUsage} < ${MAX_DISK_USAGE_BYTES})`
      );
      return;
    }
  }

  console.warn(
    clfdate(),
    `Disk usage is still above threshold: ${diskUsage} bytes`
  );
};

const checkDiskSpace = (evictBlogDirectory) => {
  console.log(clfdate(), "Starting disk space monitoring...");
  setInterval(() => {
    check(evictBlogDirectory).catch((error) => {
      console.error(clfdate(), `Disk space check failed: ${error}`);
    });
  }, POLL_INTERVAL);
};

export { checkDiskSpace, markBlogUpdated, removeBlog };
