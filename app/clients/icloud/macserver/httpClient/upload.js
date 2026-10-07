import {
  remoteServer,
  Authorization,
  iCloudDriveDirectory,
  maxFileSize,
} from "../config.js";
import clfdate from "../util/clfdate.js";
import fs from "fs-extra";
import * as brctl from "../brctl/index.js";
import fetch from "./rateLimitedFetchWithRetriesAndTimeout.js";
import { join } from "path";

class FileTooLargeError extends Error {
  constructor({ path, size, maxFileSize, mtime }) {
    super(`File size exceeds maximum of ${maxFileSize} bytes`);
    this.name = "FileTooLargeError";
    this.code = "ERR_FILE_TOO_LARGE";
    this.path = path;
    this.size = size;
    this.maxFileSize = maxFileSize;
    this.mtime = mtime;
  }
}

// The file was moved or deleted between the watcher event and the upload. The
// matching unlink/rename event follows separately, so this is not a failure.
class FileMissingError extends Error {
  constructor(path) {
    super(`File no longer exists: ${path}`);
    this.name = "FileMissingError";
    this.code = "ERR_FILE_MISSING";
    this.path = path;
  }
}

const isMissingCode = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";

export default async (blogID, path) => {
  // Input validation
  if (!blogID || typeof blogID !== "string") {
    console.error(clfdate(), "Invalid blogID for upload client request", {
      blogID,
      path,
    });
    throw new Error("Invalid blogID");
  }

  if (!path || typeof path !== "string") {
    console.error(clfdate(), "Invalid path for upload client request", {
      blogID,
      path,
    });
    throw new Error("Invalid path");
  }

  const filePath = join(iCloudDriveDirectory, blogID, path);
  const pathBase64 = Buffer.from(path).toString("base64");

  console.log(clfdate(), `Preparing to upload file: ${filePath}`);

  const notifyOversizedFile = async (size, modifiedTime) => {
    console.error(
      clfdate(),
      `File size exceeds maximum for upload: ${filePath}`,
      { size, maxFileSize }
    );

    let response;
    try {
      response = await fetch(`${remoteServer}/upload`, {
        timeout: 60 * 1000,
        method: "POST",
        headers: {
          Authorization,
          blogID,
          pathBase64,
          modifiedTime,
          "x-placeholder": "true",
          "x-original-size": String(size),
        },
      });
    } catch (error) {
      console.error(
        clfdate(),
        `Failed to record oversized file placeholder on remote server: ${filePath}`,
        error
      );
      throw error;
    }

    const text = await response.text();

    if (!response.ok) {
      console.error(
        clfdate(),
        `Placeholder upload failed with status ${response.status} for file: ${filePath}`,
        text
      );
      throw new Error(
        `Placeholder upload failed with status ${response.status}`
      );
    }
  };

  let preStat;
  try {
    preStat = await fs.stat(filePath);
  } catch (e) {
    if (isMissingCode(e)) throw new FileMissingError(path);
    console.error(clfdate(), `Failed to stat file before upload: ${filePath}`, e);
    throw new Error(`Stat failed: ${e.message}`);
  }

  if (preStat.size > maxFileSize) {
    const modifiedTime = preStat.mtime.toISOString();

    await notifyOversizedFile(preStat.size, modifiedTime);

    throw new FileTooLargeError({
      path,
      size: preStat.size,
      maxFileSize,
      mtime: modifiedTime,
    });
  }
  
  // Download and check file
  let stat;
  try {
    stat = await brctl.download(filePath);
  } catch (e) {
    // brctl reports a vanished file as a generic command failure with no code
    if (isMissingCode(e) || !(await fs.pathExists(filePath))) {
      throw new FileMissingError(path);
    }
    console.error(
      clfdate(),
      `Failed to download file before upload: ${filePath}`,
      e
    );
    throw new Error(`Download failed: ${e.message}`);
  }

  if (stat.size > maxFileSize) {
    const modifiedTime = stat.mtime.toISOString();

    await notifyOversizedFile(stat.size, modifiedTime);

    throw new FileTooLargeError({
      path,
      size: stat.size,
      maxFileSize,
      mtime: modifiedTime,
    });
  }

  const modifiedTime = stat.mtime.toISOString();

  // Read entire file into memory
  console.log(clfdate(), `Reading file into memory: ${filePath}`);

  // Beware: if you try and rewrite this to use streams you also have to
  // update rateLimitedFetchWithRetriesAndTimeout to re-create the stream
  // correctly for subsequent retries otherwise the stream will be in a
  // bad state and will not work correctly
  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(filePath);
  } catch (error) {
    if (isMissingCode(error)) throw new FileMissingError(path);
    console.error(clfdate(), `Failed to read file for upload: ${filePath}`, error);
    throw new Error(`Failed to read file: ${error.message}`);
  }

  console.log(clfdate(), `Issuing HTTP /upload request to remote server: ${path}`);

  let response;
  try {
    response = await fetch(`${remoteServer}/upload`, {
      // we use a larger timeout for uploads since they involve building a potentially expensive entry
      // even if the upload itself is fast
      timeout: 60 * 1000,
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization,
        blogID,
        pathBase64,
        modifiedTime,
      },
      body: fileBuffer,
    });
  } catch (error) {
    console.error(
      clfdate(),
      `Failed to upload file to remote server: ${filePath}`,
      error
    );
    throw error;
  }

  const text = await response.text();

  if (!response.ok) {
    console.error(
      clfdate(),
      `Upload failed with status ${response.status} for file: ${filePath}`,
      text
    );
    throw new Error(`Upload failed with status ${response.status}`);
  }

  console.log(clfdate(), "Upload successful:", text);
};
