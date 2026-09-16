// iCloud Drive share URLs look like:
//   https://www.icloud.com/iclouddrive/08d83wAt2lMHc46hEEi0D5zcQ
//   https://www.icloud.com/iclouddrive/08d83wAt2lMHc46hEEi0D5zcQ#example
// The hash fragment (folder name) is optional.
const SHARING_LINK =
  /^https:\/\/www\.icloud\.com\/iclouddrive\/[a-zA-Z0-9_-]+(#|$)/;

module.exports = function isValidSharingLink(sharingLink) {
  return typeof sharingLink === "string" && SHARING_LINK.test(sharingLink);
};
