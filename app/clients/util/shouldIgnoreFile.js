const IGNORED_SYSTEM_FILES = new Set([
  // macOS system files
  ".ds_store",
  ".fseventsd",
  ".spotlight-v100",
  ".trashes",
  ".temporaryitems",
  // Windows system files
  "thumbs.db",
  "desktop.ini",
  "$recycle.bin",
  // Linux system files
  ".trash",
  // Version control
  ".git",
  ".svn",
  // Editor/IDE
  ".kate-swp",
  // Application-specific
  ".tmp.driveupload",
  ".synologyworkingdirectory",
  ".sync",
  ".syncignore",
  // Cloud sync
  ".dropbox",
  ".dropbox.attr",
  ".dropbox.cache",
]);

const IGNORED_SUFFIXES = [".tmp", "~", ".orig", ".rej", ".swp", ".swo"];

const IGNORED_PREFIXES = [
  "~$", // Office temp
  ".#", // Emacs lockfiles
  "._", // AppleDouble
  ".trash-", // macOS trash variants
];

const shouldIgnoreFile = (inputPath) => {
  if (!inputPath) return false;

  const normalizedPath = String(inputPath).trim();
  if (!normalizedPath) return false;

  const components = normalizedPath.split(/[\\/]/);

  for (const rawComponent of components) {
    // macOS Icon file with CR
    if (rawComponent === "Icon\r" || rawComponent.startsWith("Icon\r"))
      return true;

    const component = rawComponent.trim();
    if (!component || component === "." || component === "..") continue;

    const lowerComponent = component.normalize("NFC").toLowerCase();

    if (IGNORED_SYSTEM_FILES.has(lowerComponent)) return true;

    for (const suffix of IGNORED_SUFFIXES) {
      if (lowerComponent.endsWith(suffix)) return true;
    }

    for (const prefix of IGNORED_PREFIXES) {
      if (lowerComponent.startsWith(prefix)) return true;
    }
  }

  return false;
};

module.exports = shouldIgnoreFile;
