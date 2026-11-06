import path from "path";
import { ls } from "../brctl/index.js";
import shouldIgnoreFile from "../../../util/shouldIgnoreFile.js";
import clfdate from "./clfdate.js";

const MAX_DEPTH = 1000;
const UPDATE_INTERVAL = 1000; // 1 second
const RECURSIVE_LIST_TIMEOUT_MS = 90 * 1000;

const inFlightByDirPath = new Map();

async function recursiveList(dirPath, depth = 0) {
  try {
    if (depth > MAX_DEPTH) {
      console.warn(
        clfdate(),
        `Maximum depth ${MAX_DEPTH} reached at ${dirPath}`
      );
      return;
    }

    const contents = await ls(dirPath);

    if (!contents || contents.trim() === "") {
      console.warn(clfdate(), `No contents for directory: ${dirPath}`);
      return;
    }

    const dirs = contents
      .split("\n")
      .filter((line) => line.endsWith("/"))
      .map((line) => line.slice(0, -1))
      .filter((name) => name !== "." && name !== "..")
      .filter((name) => !shouldIgnoreFile(name))
      .map((name) => path.join(dirPath, name));

    for (const subDir of dirs) {
      await recursiveList(subDir, depth + 1);
    }
  } catch (error) {
    console.error(clfdate(), "Error processing directory", dirPath, error);
  }
}

function startRun(dirPath, entry) {
  try {
    console.log(
      clfdate(),
      `Starting recursive list: ${dirPath} (timeout: ${Math.round(RECURSIVE_LIST_TIMEOUT_MS / 1000)}s)`
    );
    const startTime = Date.now();

    entry.inFlight = (async () => {
      let progressInterval;

      try {
        progressInterval = setInterval(() => {
          const elapsedMs = Date.now() - startTime;
          console.log(
            clfdate(),
            `Progress: ${Math.round(elapsedMs / 1000)}s elapsed (timeout: ${Math.round(
              RECURSIVE_LIST_TIMEOUT_MS / 1000
            )}s), processing: ${dirPath}`
          );

          if (elapsedMs >= RECURSIVE_LIST_TIMEOUT_MS) {
            console.warn(
              clfdate(),
              `Recursive list is approaching/exceeding client timeout (${Math.round(
                elapsedMs / 1000
              )}s elapsed vs ${Math.round(RECURSIVE_LIST_TIMEOUT_MS / 1000)}s timeout): ${dirPath}`
            );
          }
        }, UPDATE_INTERVAL);

        await recursiveList(dirPath);
      } finally {
        if (progressInterval) {
          clearInterval(progressInterval);
        }

        const elapsedMs = Date.now() - startTime;
        console.log(
          clfdate(),
          `Completed recursive list: ${dirPath} (${Math.round(
            elapsedMs / 1000
          )}s elapsed, timeout: ${Math.round(RECURSIVE_LIST_TIMEOUT_MS / 1000)}s)`
        );

        if (entry.rerunRequested) {
          entry.rerunRequested = false;
          startRun(dirPath, entry); // overwrites entry.inFlight (same semantics as before)
        } else {
          inFlightByDirPath.delete(dirPath);
        }
      }
    })();
  } catch (error) {
    inFlightByDirPath.delete(dirPath);
    throw error;
  }
}

function recursiveListDebounced(dirPath) {
  const entry = inFlightByDirPath.get(dirPath);
  if (entry) {
    entry.rerunRequested = true;
    return entry.inFlight;
  }

  const next = { inFlight: null, rerunRequested: false };
  inFlightByDirPath.set(dirPath, next);
  startRun(dirPath, next);
  return next.inFlight;
}

export { recursiveListDebounced };
export default recursiveListDebounced;
