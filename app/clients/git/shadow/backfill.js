// Copies the EBS repositories of existing git blogs into the git store, for
// blogs pushed to before shadow mode was on for them. The command line is
// scripts/git/backfill-store.js.
//
// Each blog is one mirror through shadow mode's own queue (./index.js), which
// does what a push would: an empty store is imported (importRepo, building its
// packs in scratchDir, on a large disk), and one with history is brought up
// to date by a push of what it lacks. A blog already in sync costs a manifest
// read and nothing else, so a run can be repeated, or stopped and run again.
//
// Nothing here writes to an EBS repository. In the app's processes, a push's
// mirror and this one share the blog's queue. Run as a script, this is a
// process of its own, and a push mirrored at the same moment by the app is
// kept apart from it by the store: its conditional swap lets one writer land,
// and the other is refused (and retried once from the store's new refs) or,
// for an import, raced (and pushes onto what the other imported). A blog
// which still ends in a mismatch is run again later.
//
// Resolves with { blogs, outcomes: { "<op>:<outcome>": n }, bytesUp, ms }.
// Each blog's mirror logs its own line (op=import or op=push, reason=backfill).
const shadow = require("./index");
const maintenance = require("./maintenance");
const { manifest } = require("../store");
const removeRepo = require("../store/remove");

const ZERO = "0".repeat(40);

async function plan(blogID) {
  const ctx = await shadow.contextFor(blogID);
  if (!ctx) return { blog: blogID, op: "push", outcome: "skipped", detail: "the blog is gone, off git or has no repository" };

  const ebs = await shadow.ebsRefs(ctx.gitDir);
  const current = await manifest.read(ctx.store);

  if (manifest.isEmpty(current)) return { blog: blogID, op: "import", outcome: Object.keys(ebs).length ? "would-import" : "empty", refs: Object.keys(ebs).length };

  const refs = new Set([...Object.keys(ebs), ...Object.keys(current.refs)]);
  const differ = [...refs].filter((ref) => (ebs[ref] || ZERO) !== (current.refs[ref] || ZERO));

  return { blog: blogID, op: "push", outcome: differ.length ? "would-push" : "same", refs: differ.length, seq: current.seq };
}

// Removes the blog's copy, for --reset: a store copy the verifier found
// damaged is removed and imported again. The store's removeRepo leaves a
// tombstone manifest, so the import goes above the old numbers, never back at
// seq 1 under a process still holding an old manifest.
async function reset(blogID) {
  const { seq, deleted } = await removeRepo({ store: shadow.objectStoreFor(blogID) });
  shadow.log({ blog: blogID, op: "remove", outcome: "ok", reason: "backfill-reset", deleted, seq });
}

async function backfill({ all = false, blog = null, concurrency = 1, dryRun = false, resetFirst = false, scratchDir = maintenance.defaultScratchDir() } = {}) {
  const started = Date.now();
  const ids = await maintenance.gitBlogs({ all, ids: blog ? [blog] : null });
  const outcomes = {};
  let bytesUp = 0;
  let next = 0;

  if (resetFirst && !blog) throw new Error("A reset is for one blog: pass its ID");

  const one = async (blogID) => {
    let fields;

    try {
      if (dryRun) {
        fields = await plan(blogID);
        shadow.log({ ...fields, reason: "backfill", dryRun: true });
      } else {
        if (resetFirst) await reset(blogID);
        fields = (await shadow.mirror(blogID, { reason: "backfill", scratchDir })) || { op: "push", outcome: "dropped" };
      }
    } catch (err) {
      fields = { blog: blogID, op: "push", outcome: "error", detail: shadow.scrub(err) };
      shadow.log({ ...fields, reason: "backfill" });
    }

    const key = fields.op + ":" + fields.outcome;
    outcomes[key] = (outcomes[key] || 0) + 1;
    bytesUp += fields.bytesUp || 0;
  };

  const worker = async () => {
    while (next < ids.length) await one(ids[next++]);
  };

  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), ids.length) }, worker));

  // Mirrors start compactions in the background; a script waits for them
  await Promise.all(ids.map((id) => shadow.idle(id)));

  const summary = { blogs: ids.length, outcomes, bytesUp, ms: Date.now() - started, dryRun: dryRun || undefined };
  shadow.log({ blog: "-", op: "backfill", outcome: "done", ...Object.fromEntries(Object.entries(summary).filter(([key]) => key !== "outcomes")), ...outcomes });

  return summary;
}

module.exports = backfill;
