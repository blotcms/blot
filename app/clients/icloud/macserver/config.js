import "dotenv/config";
import clfdate from "./util/clfdate.js";
import fs from "fs-extra";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Create a require function for importing CJS modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// Import the CJS config module
const config = require(join(__dirname, "../../../../config/index.js"));

const remoteServer = process.env.REMOTE_SERVER;
const iCloudDriveDirectory = process.env.ICLOUD_DRIVE_DIRECTORY;
const Authorization = process.env.BLOT_ICLOUD_SERVER_SECRET; // Use the correct environment variable
const maxFileSize = config.icloud.maxFileSize; // Maximum file size for iCloud uploads

if (!remoteServer) {
  throw new Error("REMOTE_SERVER is not set");
}

if (!iCloudDriveDirectory) {
  throw new Error("ICLOUD_DRIVE_DIRECTORY is not set");
}

if (!Authorization) {
  throw new Error("BLOT_ICLOUD_SERVER_SECRET is not set");
}

// verify we can read, write and delete files
fs.access(
  iCloudDriveDirectory,
  fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK
)
  .then(() =>
    console.log(clfdate(), `Directory ${iCloudDriveDirectory} is accessible`)
  )
  .catch((err) => {
    console.error(
      clfdate(),
      `Directory ${iCloudDriveDirectory} is not accessible:`,
      err
    );
    process.exit(1);
  });

export { remoteServer, iCloudDriveDirectory, Authorization, maxFileSize };
