module.exports = function truncateToSecond(isoString) {
  if (!isoString) return null; // Guard in case of null/undefined
  const date = new Date(isoString);
  date.setMilliseconds(0);
  return date.toISOString();
};
