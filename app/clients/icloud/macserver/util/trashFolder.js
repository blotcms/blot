import fs from "fs-extra";
import exec from "../exec.js";

// Takes a blog's shared folder off this Mac without touching the owner's copy.
//
// Deleting items inside a shared iCloud folder deletes them for everyone,
// owner included, but deleting the shared folder itself only removes it from
// the devices of the one who deletes it. So never remove a blog folder
// recursively (fs.remove unlinks every file first): have Finder move the
// folder itself to the Trash, as deleting it in Finder does, then empty the
// Trash. Emptying it takes everything else in this Mac's Trash with it.
//
// The path goes in as an argument, not into the script's text, so it needs no
// escaping.
export const script = `on run argv
  set target to POSIX file (item 1 of argv) as alias
  tell application "Finder"
    set warns before emptying of trash to false
    delete target
    empty the trash
  end tell
end run`;

export default async function trashFolder(path, { run = exec } = {}) {
  if (!(await fs.pathExists(path))) return false;

  await run("osascript", ["-e", script, path], { timeout: 60000 });

  // Finder can leave it in place (a dialog, a locked item) without failing
  if (await fs.pathExists(path))
    throw new Error(`Finder did not move ${path} to the Trash`);

  return true;
}
