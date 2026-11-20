// birdZones.js reads when bird last fetched a change to each shared folder,
// from the NSKeyedArchiver binary plists in its client_zones table. The
// fixture below was written by Python's plistlib in the same shape: a root
// dictionary holding lastSyncDownDate (an NSDate) and a non-ASCII string.
const path = require("path");
const { pathToFileURL } = require("url");

const FIXTURE =
  "YnBsaXN0MDDUAQIDBAUGHyJZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKoBwgTFBUWGh1VJG51bGzTCQoLDA0QViRjbGFzc1dOUy5rZXlzWk5TLm9iamVjdHOABqIOD4ACgAOiERKABIAFWHpvbmVOYW1lXxAQbGFzdFN5bmNEb3duRGF0ZW8QDwBCAGwAbwBnACAAZgBvAGwAZABlAHIAIADpACAnE9IJFxgZV05TLnRpbWWAByNBx2UTIEAAANEbHFokY2xhc3NuYW1lXE5TRGljdGlvbmFyedEbHlZOU0RhdGXRICFUcm9vdIABEgABhqAACAARABsAJAApADIARABNAFMAWgBhAGkAdAB2AHkAewB9AIAAggCEAI0AoADBAMYAzgDQANkA3ADnAPQA9wD+AQEBBgEIAAAAAAAAAgEAAAAAAAAAIwAAAAAAAAAAAAAAAAAAAQ0=";

describe("icloud macserver birdZones", function () {
  let birdZones;

  beforeAll(async function () {
    birdZones = await import(
      pathToFileURL(path.join(__dirname, "../macserver/birdZones.js")).href
    );
  });

  it("reads lastSyncDownDate from an archived zone", function () {
    const when = birdZones.lastSyncDown(Buffer.from(FIXTURE, "base64"));
    expect(new Date(when).toISOString()).toBe(
      new Date(Date.UTC(2001, 0, 1) + 785000000.5 * 1000).toISOString()
    );
  });

  it("reads UTF-16 strings without changing the buffer", function () {
    const buf = Buffer.from(FIXTURE, "base64");
    expect(birdZones.readBplist(buf).$objects[4]).toBe("Blog folder é ✓");
    expect(birdZones.readBplist(buf).$objects[4]).toBe("Blog folder é ✓");
  });

  it("refuses something that isn't a binary plist", function () {
    expect(() => birdZones.readBplist(Buffer.from("hello"))).toThrow();
  });
});
