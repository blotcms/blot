import { iCloudDriveDirectory } from "../config.js";
import exec from "../exec.js";
import clfdate from "../util/clfdate.js";
import snapshot from "./diagnostics.js";

const CONFIG = {
  TIMEOUT: 5 * 1000,
  POLLING_INTERVAL: 200,
  ERROR_MESSAGES: {
    DEADLOCK: "Resource deadlock avoided",
    NO_FILE: "No such file or directory"
  }
};

const handleExecError = (error, dirPath) => {
  if (!error?.message) return null;
  
  if (error.message.includes(CONFIG.ERROR_MESSAGES.NO_FILE)) {
    console.warn(clfdate(), `Directory does not exist: ${dirPath}`);
    return null;
  }
  
  if (!error.message.includes(CONFIG.ERROR_MESSAGES.DEADLOCK)) {
    console.error(clfdate(), `Unexpected error listing directory ${dirPath}: ${error.message}`);
    return null;
  }
  
  return error;  // Return deadlock error for handling
};

// `ls` on a directory iCloud is still materialising can block for a long
// time. Track how many are in flight and how long each took, so a stall can
// be matched against load, and snapshot the iCloud daemons when one times out.
let inFlight = 0;

const listDirectory = async (dirPath) => {
  const startedAt = Date.now();
  inFlight++;
  const concurrent = inFlight;
  try {
    const { stdout, stderr } = await exec("ls", ["-la1F", dirPath]);
    if (stderr) throw new Error(`Error listing directory ${dirPath}: ${stderr}`);
    return stdout;
  } catch (error) {
    if (error?.message?.includes("timed out")) {
      console.error(
        clfdate(),
        `ls timed out after ${Date.now() - startedAt}ms (${concurrent} in flight at start, ${inFlight} now): ${dirPath}`
      );
      snapshot();
    }
    throw error;
  } finally {
    inFlight--;
    const elapsed = Date.now() - startedAt;
    if (elapsed > 1000) {
      console.log(clfdate(), `ls took ${elapsed}ms (${concurrent} in flight at start): ${dirPath}`);
    }
  }
};

export default async (dirPath) => {
  try {
    return await listDirectory(dirPath);
  } catch (error) {
    const handledError = handleExecError(error, dirPath);
    if (!handledError) return null;

    // Handle deadlock by downloading
    try {
      console.log(clfdate(), `Directory not downloaded, downloading: ${dirPath}`);
      const pathInDrive = dirPath.replace(iCloudDriveDirectory, "").slice(1);
      await exec("brctl", ["download", pathInDrive], {
        cwd: iCloudDriveDirectory,
      });
    } catch (error) {
      console.error(clfdate(), `Error downloading directory ${dirPath}: ${error.message}`);
      return null;
    }

    const start = Date.now();
    while (Date.now() - start < CONFIG.TIMEOUT) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.POLLING_INTERVAL));
      
      try {
        return await listDirectory(dirPath);
      } catch (error) {
        const handledError = handleExecError(error, dirPath);
        if (!handledError) return null;
        // Continue polling on deadlock
      }
    }

    console.error(clfdate(), `Timeout listing directory ${dirPath}`);
    return null;
  }
};
