// Which of the unit's two Node processes a /proc/<pid>/cmdline belongs to:
// node-a runs `node app/index.js`, and node-b is forked by helper/workerChild
// with the absolute path of the script (`/usr/src/app/app/index.js`) and its
// own --max-old-space-size in execArgv. Returns "node-a", "node-b" or null.
module.exports = function nodeRole(cmdline) {
  const argv = cmdline.split("\0").filter(Boolean);
  if (!/(^|\/)node$/.test(argv[0] || "")) return null;
  const script = argv.findIndex(
    (arg) => arg === "app/index.js" || arg.endsWith("/app/index.js")
  );
  if (script < 1) return null;
  return argv
    .slice(1, script)
    .some((arg) => arg.startsWith("--max-old-space-size="))
    ? "node-b"
    : "node-a";
};
