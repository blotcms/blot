import exec from "../exec.js";
import { join } from "path";
import fs from "fs-extra";
import Bottleneck from "bottleneck";
import status from "../httpClient/status.js";
import { iCloudDriveDirectory } from "../config.js";
import clfdate from "../util/clfdate.js";

// Only one setup can run at a time otherwise the apple script
// might not work correctly or accept the wrong sharing link
const setupLimiter = new Bottleneck({
  maxConcurrent: 1,
});

/**
 * Wait for a new top-level directory to appear, rename it, and notify the remote server.
 * @param {string} blogID - The blogID to associate with the folder
 * @param {string} sharingLink - The iCloud sharing link for the folder
 */
const setupBlog = setupLimiter.wrap(async (blogID, sharingLink) => {
  console.log(clfdate(), 
    `Waiting for a new folder to set up blogID: ${blogID} using sharingLink: ${sharingLink}`
  );

  const checkInterval = 100; // Interval (in ms) to check for new directories
  const timeout = 1000 * 15; // Timeout (in ms) to wait for a new directory: 15 seconds 
  const start = Date.now();

  // Get the initial state of the top-level directories
  const initialDirs = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });
  const initialDirNames = initialDirs
    .filter((dir) => dir.isDirectory())
    .map((dir) => dir.name);

  console.log(clfdate(), 
    `Initial state of iCloud Drive: ${
      initialDirNames.join(", ") || "No directories"
    }`
  );

  console.log(clfdate(), "running the acceptSharingLink script");
  await acceptSharingLink(sharingLink);

  while (true && Date.now() - start < timeout) {
    // Get the current state of the top-level directories
    const currentDirs = await fs.readdir(iCloudDriveDirectory, {
      withFileTypes: true,
    });
    const currentDirNames = currentDirs
      .filter((dir) => dir.isDirectory())
      .map((dir) => dir.name);

    // Find any new directories by comparing initial state with the current state
    const newDirs = currentDirNames.filter(
      (dirName) => !initialDirNames.includes(dirName)
    );

    if (newDirs.length > 0) {
      const newDirName = newDirs[0]; // Handle the first new directory found
      console.log(clfdate(), `Found new folder: ${newDirName}`);

      const oldPath = join(iCloudDriveDirectory, newDirName);
      const newPath = join(iCloudDriveDirectory, blogID);

      // If there is already a folder with the blogID, delete it
      await fs.remove(newPath);

      // Rename the folder
      await fs.rename(oldPath, newPath);
      console.log(clfdate(), `Renamed folder from ${newDirName} to ${blogID}`);
      return; // Setup is complete, exit the loop
    }

    // Wait before checking again
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  console.error(clfdate(), 
    `Timed out waiting for a new folder to set up blogID: ${blogID} after ${timeout}ms`
  );
  throw new Error("Invalid sharing link");
});
const escapeAppleScriptString = (value) =>
  String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\r\n|\r|\n/g, "\\n");

// Used the accessibility inspector to find the UI elements to interact with
const appleScript = (sharingLink) => `
-- Open the specified sharing link in Finder
try
    -- Open the sharing link in Finder
    tell application "Finder"
        open location "${sharingLink}"
    end tell

    -- Wait for the iCloud sharing system dialog to appear
    set timeoutSeconds to 10 -- Set the timeout (in seconds)
    set startTime to (current date) -- Track the start time

    tell application "System Events"
        tell process "UserNotificationCenter"
            -- Loop until either the "Open" or "Continue" button is detected, or timeout occurs
            repeat
                if (exists (button "Open" of window 1)) or (exists (button "Continue" of window 1)) or (exists (button "OK" of window 1)) then
                    exit repeat -- Exit the loop if a button is detected
                end if

                -- Check if the timeout has been reached
                if ((current date) - startTime) > timeoutSeconds then
                    exit repeat -- Exit the loop if the timeout has been reached
                end if

                delay 0.1 -- Check every 0.1 seconds
            end repeat

            -- Check if the "Continue" button exists
            -- This means the sharing link is for another user
            if exists (button "Continue" of window 1) then
                click button "Cancel" of window 1
            end if

            -- Check if the "OK" button exists
            -- This means the sharing link is invalid
            if exists (button "OK" of window 1) then
                click button "OK" of window 1
            end if

            -- Click the "Open" button if it exists
            -- This means the sharing link is valid
            if exists (button "Open" of window 1) then
                click button "Open" of window 1
            end if
        end tell
    end tell

    -- wait 2 seconds for the Finder to process the new folder if it was created
    delay 2
    
    -- Close all Finder windows after interacting with the sharing dialog
    tell application "Finder"
        close every window
    end tell
end try
`;

async function acceptSharingLink(sharingLink) {
  console.log(clfdate(), `Running AppleScript to accept sharing link: ${sharingLink}`);
  const escapedSharingLink = escapeAppleScriptString(sharingLink);

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await exec(
      "osascript",
      ["-e", appleScript(escapedSharingLink)],
      { timeout: 25000 }
    ));
  } catch (error) {
    console.error(
      clfdate(),
      `AppleScript execution failed for sharing link: ${sharingLink}`,
      error
    );
    throw error;
  }

  if (stderr && stderr.trim()) {
    throw new Error(`Unexpected AppleScript stderr: ${stderr}`);
  }

  if (stdout && stdout.trim()) {
    throw new Error(`Unexpected AppleScript stdout: ${stdout}`);
  }

  // We don't know if the script succeeded or failed because it's hard to 
  // write to stdout or stderr from AppleScript. We check if it worked
  // by determining if the folder was created
  console.log(clfdate(), `AppleScript finished`);
}

export default async (req, res) => {
  const blogID = req.header("blogID");

  const sharingLink = req.header("sharingLink"); // New header for the sharing link

  if (!blogID) {
    console.error(clfdate(), "Missing blogID header for setup request");
    return res.status(400).send("Missing blogID header");
  }

  if (!sharingLink) {
    console.error(clfdate(), "Missing sharingLink header for setup request", {
      blogID,
    });
    return res.status(400).send("Missing sharingLink header");
  }

  console.log(clfdate(),
    `Received setup request for blogID: ${blogID}, sharingLink: ${sharingLink}`
  );

  // Setting up a folder involves driving the Finder UI via AppleScript and then
  // waiting for iCloud to materialise the shared folder, which can take tens of
  // seconds. Rather than holding the HTTP connection open for the whole
  // operation, acknowledge the request immediately and report the outcome
  // asynchronously via the status client (POST /status on the remote server).
  const reportStatus = async (payload) => {
    try {
      await status(blogID, payload);
    } catch (error) {
      console.error(
        clfdate(),
        `Failed to report setup status for blogID (${blogID}):`,
        error
      );
    }
  };

  setupBlog(blogID, sharingLink)
    .then(() => {
      console.log(clfdate(), `Setup complete for blogID: ${blogID}`);
      return reportStatus({ acceptedSharingLink: true, error: null });
    })
    .catch((error) => {
      console.error(clfdate(), `Setup failed for blogID (${blogID}):`, error);
      return reportStatus({
        acceptedSharingLink: false,
        error: error.message,
      });
    });

  return res.status(202).json({ accepted: true });
};
