const isValidSharingLink = require("./isValidSharingLink");

// Tidies what people paste as a sharing link before it is checked: spaces and
// line breaks around it, angle brackets or quotes some apps add, a missing
// "https://", "http://", and the host without "www.". Returns the link in
// the form isValidSharingLink accepts, or null when it still isn't one.
module.exports = function normalizeSharingLink(input) {
  if (typeof input !== "string") return null;

  let link = input
    .trim()
    .replace(/^[<"'“‘]+|[>"'”’]+$/g, "")
    .trim();

  if (!/^https?:\/\//i.test(link)) link = "https://" + link;

  link = link.replace(
    /^https?:\/\/(www\.)?icloud\.com\//i,
    "https://www.icloud.com/"
  );

  return isValidSharingLink(link) ? link : null;
};
