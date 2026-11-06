import exec from "../exec.js";
import clfdate from "../util/clfdate.js";

export default async () => {
  // use brctl quota to get the iCloud Drive quota and usage
  // e.g. '1899909948243 bytes of quota remaining in personal account'
  const { stdout, stderr } = await exec("brctl", ["quota"]);

  if (stderr) {
    console.error(clfdate(), `Error getting iCloud Drive quota: ${stderr}`);
    throw new Error("Failed to get iCloud Drive quota");
  }

  const match = stdout.match(/(\d+) bytes of quota remaining/);
  if (!match || !match[1]) {
    throw new Error(`Unexpected iCloud Drive quota output: ${stdout}`);
  }

  return parseInt(match[1], 10);
};
