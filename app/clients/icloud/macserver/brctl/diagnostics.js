import { execFile } from "child_process";
import os from "os";
import clfdate from "../util/clfdate.js";

const MIN_INTERVAL_MS = 60 * 1000;
const INTERESTING = /fileproviderd|\/bird|cloudd|brctl|\bls\b/;

let lastSnapshot = 0;

// Logs what the iCloud daemons and any stuck ls/brctl processes were doing,
// at most once a minute. Called when a listing times out.
export default function snapshot() {
  const now = Date.now();
  if (now - lastSnapshot < MIN_INTERVAL_MS) return;
  lastSnapshot = now;

  execFile("ps", ["-axo", "pid,stat,etime,%cpu,command"], (err, out) => {
    if (err) {
      console.error(clfdate(), "Diagnostic snapshot failed:", err.message);
      return;
    }
    const rows = out
      .split("\n")
      .filter((line) => INTERESTING.test(line))
      .map((line) => line.trim().slice(0, 160));
    console.error(
      clfdate(),
      `Diagnostic snapshot: loadavg=${os.loadavg().map((n) => n.toFixed(2)).join(",")} processes:\n${rows.join("\n")}`
    );
  });
}
