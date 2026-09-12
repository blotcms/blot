// Bound the one-time warming of legacy folders. One file larger than the byte
// allowance may run alone so large files cannot remain unverified forever.
module.exports = function migrationBudget() {
  let files = 0;
  let bytes = 0;
  return size => {
    if (files >= 32 || (files > 0 && bytes + size > 64 * 1024 * 1024)) return false;
    files++;
    bytes += size;
    return true;
  };
};
