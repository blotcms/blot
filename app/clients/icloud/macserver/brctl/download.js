import { iCloudDriveDirectory } from "../config.js";
import fs from "fs-extra";
import exec from "../exec.js";
import clfdate from "../util/clfdate.js";

const TIMEOUT = 15 * 1000; // 15 seconds
const POLLING_INTERVAL = 200; // 200ms

const BLOCK_SIZE = 512;

export default async (path) => {
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

  if (isDownloaded) {
    console.log(clfdate(), `File already downloaded: ${path}`);
    return stat;
  }

  const pathInDrive = path.replace(iCloudDriveDirectory, "").slice(1);

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

  while (Date.now() - start < TIMEOUT) {
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
  }

  throw new Error(`Timeout downloading file: ${path}`);
};
