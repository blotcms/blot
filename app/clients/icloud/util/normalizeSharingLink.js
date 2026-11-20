const isValidSharingLink = require("./isValidSharingLink");

const OPENERS = "<\"'“‘";
const CLOSERS = ">\"'”’";

// Tidies what people paste as a sharing link before it is checked: spaces and
// line breaks around it, angle brackets or quotes some apps add, a missing
// "https://", "http://", and the host without "www.". Returns the link in
// the form isValidSharingLink accepts, or null when it still isn't one.
module.exports = function normalizeSharingLink(input) {
  if (typeof input !== "string") return null;

  // Trimmed by hand: a regex anchored at the end backtracks badly on long
  // runs of these characters
  let link = input.trim();
  let start = 0;
  let end = link.length;
  while (start < end && OPENERS.includes(link[start])) start++;
  while (end > start && CLOSERS.includes(link[end - 1])) end--;
  link = link.slice(start, end).trim();

  if (!/^https?:\/\//i.test(link)) link = "https://" + link;

  link = link.replace(
    /^https?:\/\/(www\.)?icloud\.com\//i,
    "https://www.icloud.com/"
  );

  return isValidSharingLink(link) ? link : null;
};
