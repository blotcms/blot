import clfdate from "../util/clfdate.js";
import { getLimiterForBlogID } from "../limiters.js";
import mkdir from "../httpClient/mkdir.js";
import remove from "../httpClient/remove.js";
import resync, { hasRecentResync } from "../httpClient/resync.js";
import upload from "../httpClient/upload.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isFileTooLargeError = (error) => error?.code === "ERR_FILE_TOO_LARGE";

const isFileMissingError = (error) => error?.code === "ERR_FILE_MISSING";

// 423 Locked: the server holds the blog's folder lock, usually because it is
// already running the resync we asked for
const isLockedError = (error) => error?.status === 423;

// How long after a resync was acknowledged we assume a 423 is that resync
const RESYNC_LOCK_WINDOW_MS = 10 * 60 * 1000;

const withRetries = async (label, operation, options = {}) => {
  const { attempts = 4, baseDelayMs = 200 } = options;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // the file is gone, retrying cannot help
      if (isFileMissingError(error)) {
        throw error;
      }

      if (isFileTooLargeError(error)) {
        console.warn(
          clfdate(),
          `${label} reported oversized file; skipping retries and treating placeholder as intentional:`,
          {
            path: error.path,
            size: error.size,
            maxFileSize: error.maxFileSize,
            mtime: error.mtime,
          }
        );
        throw error;
      }

      if (attempt === attempts) {
        break;
      }
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        clfdate(),
        `${label} failed on attempt ${attempt}/${attempts}, retrying in ${delayMs}ms:`,
        error
      );
      await sleep(delayMs);
    }
  }

  console.error(clfdate(), `${label} failed after ${attempts} attempts:`, lastError);
  throw lastError;
};

const performAction = async (blogID, pathInBlogDirectory, action) => {

  const validActions = ['upload', 'remove', 'mkdir'];
  
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`);
  }

  const limiter = getLimiterForBlogID(blogID);

  await limiter.schedule(async () => {
    try {
      if (action === "upload") {
        await withRetries(
          `upload ${blogID}/${pathInBlogDirectory}`,
          () => upload(blogID, pathInBlogDirectory)
        );
      } else if (action === "remove") {
        await withRetries(
          `remove ${blogID}/${pathInBlogDirectory}`,
          () => remove(blogID, pathInBlogDirectory)
        );
      } else if (action === "mkdir") {
        await withRetries(
          `mkdir ${blogID}/${pathInBlogDirectory}`,
          () => mkdir(blogID, pathInBlogDirectory)
        );
      }
    } catch (error) {
      if (isFileMissingError(error)) {
        console.log(clfdate(), "Skipping upload: file no longer exists", {
          blogID,
          pathInBlogDirectory,
        });
        return;
      }

      if (isFileTooLargeError(error)) {
        console.warn(
          clfdate(),
          "Oversized file recorded as placeholder; upload skipped intentionally",
          {
            blogID,
            pathInBlogDirectory,
            size: error.size,
            maxFileSize: error.maxFileSize,
            mtime: error.mtime,
          }
        );
        return;
      }

      // A resync already holds the lock and treats iCloud as the source of
      // truth, so it will pick this change up. If no resync is known to be
      // running, the lock is held by something else: fall through and request
      // one so the change is not lost (the request itself retries on 423).
      if (isLockedError(error) && hasRecentResync(blogID, RESYNC_LOCK_WINDOW_MS)) {
        console.log(
          clfdate(),
          "Skipping resync request: blog is locked by a resync already in progress",
          { blogID, action, pathInBlogDirectory }
        );
        throw error;
      }

      resync(
        blogID,
        `${action} for ${pathInBlogDirectory} failed after retries`
      ).catch((resyncError) => {
        console.error(
          clfdate(),
          `Unexpected error requesting resync for blogID: ${blogID}`,
          resyncError
        );
      });
      throw error;
    }
  });
};

export { performAction };
