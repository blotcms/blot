import clfdate from "../util/clfdate.js";
import { getLimiterForBlogID, isLimiterStoppedError } from "../limiters.js";
import { takeTurn } from "../pathOrder.js";
import mkdir from "../httpClient/mkdir.js";
import remove from "../httpClient/remove.js";
import resync from "../httpClient/resync.js";
import { isNotSyncing } from "../httpClient/notSyncing.js";
import upload from "../httpClient/upload.js";
import { forgetPath, recordDirectory } from "../pushedFiles.js";
import { forgetBlotChange, isBlotEcho } from "../blotWrites.js";
import { buildBlogPath } from "./pathUtils.js";
import fs from "fs-extra";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isFileTooLargeError = (error) => error?.code === "ERR_FILE_TOO_LARGE";

const isFileMissingError = (error) => error?.code === "ERR_FILE_MISSING";

const withRetries = async (label, operation, options = {}) => {
  const { attempts = 4, baseDelayMs = 200 } = options;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // the file is gone, or Blot won't sync the blog: retrying cannot help
      if (isFileMissingError(error) || isNotSyncing(error)) {
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

  console.error(
    clfdate(),
    `${label} failed after ${attempts} attempts:`,
    lastError
  );
  throw lastError;
};

const performAction = async (blogID, pathInBlogDirectory, action) => {
  const validActions = ["upload", "remove", "mkdir"];

  if (!validActions.includes(action)) {
    throw new Error(
      `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`
    );
  }

  // Blot's own removal or new directory, seen by the watcher: Blot already
  // has it. A removal counts only while the path is still gone.
  if (
    (action === "mkdir" && isBlotEcho(blogID, pathInBlogDirectory, "mkdir")) ||
    (action === "remove" &&
      isBlotEcho(blogID, pathInBlogDirectory, "remove") &&
      !(await fs.pathExists(buildBlogPath(blogID, pathInBlogDirectory))))
  ) {
    console.log(
      clfdate(),
      `Skipping ${action}: Blot made this change, blogID: ${blogID}, path: ${pathInBlogDirectory}`
    );
    return;
  }

  if (action === "remove" || action === "upload")
    forgetBlotChange(blogID, pathInBlogDirectory);

  const limiter = getLimiterForBlogID(blogID);

  // Taken before the first await, so turns follow the order of the events
  const turn = takeTurn(blogID, pathInBlogDirectory);

  try {
    await turn.ready;
    return await runAction(limiter, blogID, pathInBlogDirectory, action);
  } finally {
    turn.done();
  }
};

// resolves to the result of the action; mkdir reports whether Blot created the directory
const runAction = (limiter, blogID, pathInBlogDirectory, action) =>
  limiter
    .schedule(async () => {
      try {
        if (action === "upload") {
          await withRetries(`upload ${blogID}/${pathInBlogDirectory}`, () =>
            upload(blogID, pathInBlogDirectory)
          );
        } else if (action === "remove") {
          // forgotten even if the remove fails, so the file is pushed again
          // if it comes back with the same size and mtime
          forgetPath(blogID, pathInBlogDirectory);
          await withRetries(`remove ${blogID}/${pathInBlogDirectory}`, () =>
            remove(blogID, pathInBlogDirectory)
          );
        } else if (action === "mkdir") {
          const created = await withRetries(
            `mkdir ${blogID}/${pathInBlogDirectory}`,
            () => mkdir(blogID, pathInBlogDirectory)
          );
          recordDirectory(blogID, pathInBlogDirectory);
          return created;
        }
      } catch (error) {
        if (isFileMissingError(error)) {
          console.log(clfdate(), "Skipping upload: file no longer exists", {
            blogID,
            pathInBlogDirectory,
          });
          return;
        }

        if (isNotSyncing(error)) {
          console.log(
            clfdate(),
            `Dropped ${action} for ${blogID}: Blot isn't syncing this blog (${error.status})`,
            pathInBlogDirectory
          );
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
    })
    .catch((error) => {
      // The blog was disconnected (or its folder deleted) while this action was
      // queued. removeLimiterForBlogID logged how many were dropped; there is
      // nothing to do and no point asking Blot for a resync.
      if (isLimiterStoppedError(error)) return;
      throw error;
    });

export { performAction };
