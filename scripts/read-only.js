// Turn the data directory's read-only freeze (app/helper/readOnly.js) on or
// off, or report it. Run inside an app container, e.g.
//
//   docker exec blot-container-blue node scripts/read-only.js on --ttl 600 --reason "volume swap"
//   docker exec blot-container-blue node scripts/read-only.js status
//   docker exec blot-container-blue node scripts/read-only.js off
//
// "on" also extends a freeze that is already on. "status" lists the folder
// locks still held, so a caller can wait for the syncs that started before
// the freeze to finish; it prints JSON and exits 0 either way.

const client = require("models/client");
const readOnly = require("helper/readOnly");

const LOCK_PATTERN = "blog:*:folder-lock";

function usage() {
  console.error(
    "Usage: node scripts/read-only.js on [--ttl SECONDS] [--reason TEXT] | off | status"
  );
  process.exit(2);
}

function option(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  if (i + 1 >= args.length) usage();
  return args[i + 1];
}

async function heldFolderLocks() {
  const keys = [];
  for await (const batch of client.scanIterator({
    MATCH: LOCK_PATTERN,
    COUNT: 1000,
  })) {
    // node-redis 4 yields keys one at a time, 5 yields arrays of them
    keys.push(...[].concat(batch));
  }
  // Not split on ":", lock names can contain one (the airlock's is a URL)
  return keys.map((key) => key.slice("blog:".length, -":folder-lock".length));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "on") {
    const ttlOption = option(args, "--ttl");
    const ttl =
      ttlOption === undefined ? readOnly.DEFAULT_TTL_SECONDS : Number(ttlOption);
    const reason = option(args, "--reason") || "";
    await readOnly.enable({ ttl, reason });
  } else if (command === "off") {
    await readOnly.disable();
  } else if (command !== "status") {
    usage();
  }

  const status = await readOnly.status();
  const lockedBlogs = await heldFolderLocks();

  console.log(JSON.stringify({ readOnly: status, lockedBlogs }));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
