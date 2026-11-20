import exec from "../exec.js";
import clfdate from "./clfdate.js";

// What this Mac's iCloud account may do in a shared folder: "readWrite",
// "readOnly", or null when macOS doesn't say (not shared, or not known yet).
//
// A folder shared "View only" is accepted like any other, and writes to it
// succeed on this Mac's disk, but iCloud never uploads them. So without this
// check a setup "completes" while nothing Blot writes reaches the owner.
//
// macOS keeps the permission behind a file API (the URL resource
// NSURLUbiquitousSharedItemCurrentUserPermissionsKey), not in Spotlight or an
// extended attribute, so this asks for it through JavaScript for Automation,
// which ships with macOS.

const script = `ObjC.import("Foundation");
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const value = Ref();
  url.getResourceValueForKeyError(
    value,
    $.NSURLUbiquitousSharedItemCurrentUserPermissionsKey,
    null
  );
  return ObjC.unwrap(value[0]) || "";
}`;

const VALUES = {
  NSURLUbiquitousSharedItemPermissionsReadWrite: "readWrite",
  NSURLUbiquitousSharedItemPermissionsReadOnly: "readOnly",
};

export const parse = (stdout) => VALUES[String(stdout || "").trim()] || null;

const read = async (path) => {
  const { stdout } = await exec(
    "osascript",
    ["-l", "JavaScript", "-e", script, path],
    { timeout: 10000 }
  );
  return parse(stdout);
};

// iCloud can take a moment to fill in the share's details once the folder
// appears, so ask a few times before settling for null
export default async function sharePermission(
  path,
  { attempts = 5, interval = 1000 } = {}
) {
  for (let attempt = 1; ; attempt++) {
    try {
      const permission = await read(path);
      if (permission || attempt >= attempts) return permission;
    } catch (error) {
      console.error(
        clfdate(),
        `Could not read the share permission of ${path}:`,
        error.message
      );
      if (attempt >= attempts) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
