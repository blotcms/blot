// sharePermission.js asks macOS whether this Mac's iCloud account may change
// a shared folder. Only the parsing of osascript's answer runs here: the
// lookup itself needs macOS and a shared folder.
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver sharePermission", function () {
  let parse;

  beforeAll(async function () {
    ({ parse } = await import(
      pathToFileURL(
        path.join(__dirname, "../macserver/util/sharePermission.js")
      ).href
    ));
  });

  it("reads both permissions", function () {
    expect(parse("NSURLUbiquitousSharedItemPermissionsReadWrite\n")).toBe(
      "readWrite"
    );
    expect(parse("NSURLUbiquitousSharedItemPermissionsReadOnly")).toBe(
      "readOnly"
    );
  });

  it("is null when macOS doesn't say", function () {
    expect(parse("")).toBe(null);
    expect(parse(undefined)).toBe(null);
    expect(parse("something else")).toBe(null);
  });
});
