import exec from "../exec.js";

// The memory macOS could hand a process without swapping, for /stats. The
// kernel's free pages (os.freemem()) are close to none on macOS, which keeps
// spare memory as file cache, so that reads as a full machine. This is total
// memory less what Activity Monitor calls Memory Used: app memory (anonymous
// pages less purgeable ones), wired memory and the compressor's pages.

const PAGE_SIZE = /page size of (\d+) bytes/;

const pages = (stdout, label) => {
  const match = stdout.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m"));
  if (!match) throw new Error(`vm_stat gave no "${label}"`);
  return Number(match[1]);
};

export function parseVmStat(stdout, totalBytes) {
  const pageSize = stdout.match(PAGE_SIZE);
  if (!pageSize) throw new Error("vm_stat gave no page size");

  const usedPages =
    pages(stdout, "Anonymous pages") -
    pages(stdout, "Pages purgeable") +
    pages(stdout, "Pages wired down") +
    pages(stdout, "Pages occupied by compressor");

  const used = usedPages * Number(pageSize[1]);
  return Math.max(0, Math.min(totalBytes, totalBytes - used));
}

export default async function availableMemory(totalBytes) {
  const { stdout } = await exec("vm_stat", [], { timeout: 5000 });
  return parseVmStat(stdout, totalBytes);
}
