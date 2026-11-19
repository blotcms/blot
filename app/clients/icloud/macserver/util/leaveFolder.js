import fs from "fs-extra";
import { basename, dirname, resolve } from "path";
import exec from "../exec.js";

// Takes a blog's shared folder off this Mac without touching the owner's copy.
//
// Deleting items inside a shared iCloud folder deletes them for everyone,
// owner included, so a blog folder is never removed recursively. Deleting the
// shared folder itself in Finder only takes it off the devices of the one who
// deletes it, after a "delete this shared folder?" sheet. Only Finder's own
// Delete does this: NSFileManager's trashItem refuses shared folders, and
// Finder's scripted `delete` raises a detached dialog whose Delete does
// nothing. So this selects the folder in a Finder window, presses ⌘⌫ and
// confirms the sheet, as a person would. A folder that isn't shared goes to
// the Trash with no sheet, which is then emptied.
//
// `root` is iCloud Drive (config.js's iCloudDriveDirectory), passed in so this
// module doesn't read the config. Run it inside finderLimiter, so it can't
// click a setup's dialog or the other way round.

const BLOG_FOLDER = /^blog_[a-zA-Z0-9]+$/;

// Refuses anything but <iCloud Drive>/blog_<id>: a slip here must never reach
// iCloud Drive itself or a folder that isn't a blog's.
export function checkPath(path, root) {
  const full = resolve(path);
  if (dirname(full) !== resolve(root) || !BLOG_FOLDER.test(basename(full)))
    throw new Error(
      `Refusing to remove ${path}: not a blog folder in iCloud Drive`
    );
  return full;
}

// Every step that could act on the wrong item is checked first: one item
// selected, with the folder's name, and Finder frontmost to take the keys.
export const script = `on run argv
  set wanted to item 1 of argv
  set blogFolder to POSIX file (item 2 of argv) as alias
  tell application "Finder"
    activate
    reveal blogFolder
    delay 2
    set picked to selection
    if (count of picked) is not 1 then return "abort: " & (count of picked) & " items selected"
    if (name of (item 1 of picked)) is not wanted then return "abort: selected " & (name of (item 1 of picked))
  end tell
  delay 1
  tell application "System Events"
    if (name of (first process whose frontmost is true)) is not "Finder" then return "abort: Finder is not frontmost"
    keystroke (ASCII character 8) using command down
  end tell
  repeat 15 times
    delay 1
    tell application "System Events" to tell process "Finder"
      repeat with w in windows
        try
          set s to sheet 1 of w
          if ((value of static texts of s) as text) contains "delete this shared folder" then
            click button "Delete" of s
            return "confirmed"
          end if
        end try
      end repeat
    end tell
  end repeat
  return "no sheet"
end run`;

const emptyTrashScript = `tell application "Finder"
  set warns before emptying of trash to false
  empty the trash
end tell`;

export default async function leaveFolder(
  path,
  { root, run = exec, waitMs = 30000, pollMs = 1000 }
) {
  const full = checkPath(path, root);
  if (!(await fs.pathExists(full))) return false;

  const { stdout } = await run(
    "osascript",
    ["-e", script, basename(full), full],
    { timeout: 60000 }
  );
  const outcome = stdout.trim();
  if (outcome.startsWith("abort")) throw new Error(`Finder ${outcome}`);

  for (let waited = 0; await fs.pathExists(full); waited += pollMs) {
    if (waited >= waitMs)
      throw new Error(`${full} is still there after Finder (${outcome})`);
    await new Promise((done) => setTimeout(done, pollMs));
  }

  // A folder that wasn't shared went to the Trash; a shared one left without
  if (outcome !== "confirmed")
    await run("osascript", ["-e", emptyTrashScript], { timeout: 60000 });

  return true;
}
