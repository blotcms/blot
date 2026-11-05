// Removes the live clones left in git blogs' folders (a .git directory Blot's
// git client once made there), now that the git store is the only path
// (#2259). See app/clients/git/liveClones.js for when a .git is removed and
// why one is kept.
//
//   node scripts/git/remove-live-clones.js            dry run: what it would do
//   node scripts/git/remove-live-clones.js --apply    removes them
//   node scripts/git/remove-live-clones.js --blogs <id,id,...> [--apply]
//
// Prints one line per blog that has a .git (or would have one removed), then
// the counts. Blog IDs only, never handles. Exits 0 unless a removal failed
// (or the arguments are wrong, 2).
//
// On the production host:
//
//   docker exec -u 1000 blot-blue node scripts/git/remove-live-clones.js
function usage(message) {
  if (message) console.error(message + "\n");
  console.error("Usage: node scripts/git/remove-live-clones.js [--apply] [--blogs <id,id,...>]");
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, ids: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--blogs") {
      const value = argv[++i];
      if (!value) usage("--blogs needs a value");
      options.ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
    } else usage("Unknown argument " + argv[i]);
  }

  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const liveClones = require("clients/git/liveClones");

  console.log(options.apply ? "Removing live clones" : "Dry run: nothing is removed (pass --apply to remove)");

  const counts = await liveClones.run({
    apply: options.apply,
    ids: options.ids,
    onResult: function (result) {
      // Blogs with nothing to do are only counted
      if (result.outcome === "kept" && (result.reason === "not-git" || result.reason === "no-clone")) return;
      console.log(
        [result.blog, result.outcome, result.reason, result.detail && JSON.stringify(result.detail)].filter(Boolean).join(" ")
      );
    },
  });

  console.log(JSON.stringify(counts));

  return counts.failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
