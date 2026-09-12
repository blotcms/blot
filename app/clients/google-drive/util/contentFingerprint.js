// Nanosecond stat fields keep the cache sensitive to same-size writes whose
// timestamps fall within the same millisecond, as well as file replacement.
module.exports = function contentFingerprint(stat) {
  if (!stat || !stat.isFile()) return null;
  const fields = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
  if (fields.some(value => value === undefined)) return null;
  return fields.map(String).join(":");
};
