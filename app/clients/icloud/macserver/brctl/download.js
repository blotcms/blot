import { iCloudDriveDirectory } from "../config.js";
import fs from "fs-extra";
import exec from "../exec.js";
import clfdate from "../util/clfdate.js";

// 15 seconds, plus 2 seconds a megabyte: a fixed 15 seconds timed out (and
// retried) on multi-megabyte photos
const BASE_TIMEOUT = 15 * 1000;
const TIMEOUT_PER_MB = 2 * 1000;
const MAX_TIMEOUT = 120 * 1000;
const POLLING_INTERVAL = 200; // 200ms

const timeoutFor = (size) =>
  Math.min(MAX_TIMEOUT, BASE_TIMEOUT + (size / 1e6) * TIMEOUT_PER_MB);

const BLOCK_SIZE = 512;

// { force: true } issues the download even when the file looks downloaded:
// a downloaded file whose newer version bird already has keeps its old
// blocks until FileProvider fetches the new one.
export default async (path, { force = false } = {}) => {
  console.log(clfdate(), `Downloading file from iCloud: ${path}`);

  const stat = await fs.stat(path);
  const start = Date.now();

  if (!path.startsWith(iCloudDriveDirectory)) {
    throw new Error(`Path not in iCloud: ${path}`);
  }

  // Determine if the file is already downloaded
  const roundUpBy8 = (x) => Math.ceil(x / 8) * 8;
  // It's important that if stat.size is 0, we expect 0 blocks
  // after 1 byte, we expect at least 8 blocks
  const expectedBlocks = roundUpBy8(Math.ceil(stat.size / BLOCK_SIZE));

  // It is impossible for us to determine whether a 'zero byte' file has been downloaded
  // and it seems that if we try to create a readStream for a zero byte file undownloaded
  // file we get the -11 error code. So we attempt to download the file if it is zero bytes
  const isDownloaded = stat.blocks === expectedBlocks && stat.size !== 0;

  console.log(
    clfdate(),
    `Initial blocks: ${stat.blocks} / ${expectedBlocks} ${
      stat.size === 0 ? " (zero byte file: downloading anyway)" : ""
    }`
  );

  if (isDownloaded && !force) {
    console.log(clfdate(), `File already downloaded: ${path}`);
    return stat;
  }

  const pathInDrive = path.replace(iCloudDriveDirectory, "").slice(1);

  const request = async () => {
    console.log(clfdate(), `Issuing brctl download for path: ${pathInDrive}`);

    const { stdout, stderr } = await exec("brctl", ["download", pathInDrive], {
      cwd: iCloudDriveDirectory,
    });

    if (stdout !== "") {
      throw new Error(`Unexpected stdout: ${stdout}`);
    }

    if (stderr !== "") {
      throw new Error(`Unexpected stderr: ${stderr}`);
    }
  };

  await request();

  let requested = { size: stat.size, mtimeMs: stat.mtimeMs };
  const timeout = timeoutFor(stat.size);

  while (Date.now() - start < timeout) {
    // wait for the file to be downloaded
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL));

    const stat = await fs.stat(path);

    // we re-calculate the expected blocks in case the file size has changed
    const expectedBlocks = roundUpBy8(Math.ceil(stat.size / BLOCK_SIZE));

    console.log(clfdate(), `Latest blocks: ${stat.blocks} / ${expectedBlocks}`);

    if (stat.blocks === expectedBlocks) {
      console.log(clfdate(), `Finish brctl download: ${path}`);
      return stat;
    }

    // A newer version replaced the file while we waited (FileProvider swaps
    // in its placeholder, not downloaded): the download we asked for was for
    // the old one, so ask again
    if (stat.size !== requested.size || stat.mtimeMs !== requested.mtimeMs) {
      console.log(clfdate(), `File changed while downloading: ${path}`);
      requested = { size: stat.size, mtimeMs: stat.mtimeMs };
      await request();
    }
  }

  throw new Error(`Timeout downloading file: ${path}`);
};
