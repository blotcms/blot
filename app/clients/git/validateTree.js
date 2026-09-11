// Validate an immutable commit, then use that same ID for checkout: validating
// a branch name and later resetting it would allow the ref to change in between.
module.exports = async function validateTree(git, ref) {
  const commit = (await git.raw(["rev-parse", "--verify", ref + "^{commit}"])).trim();
  const tree = await git.raw(["ls-tree", "-r", "-z", commit]);
  for (const record of tree.split("\0")) {
    if (!record) continue;
    const mode = record.slice(0, record.indexOf(" "));
    if (mode !== "100644" && mode !== "100755") {
      throw new Error("Git blogs support regular files only (no symbolic links or submodules)");
    }
  }
  return commit;
};
