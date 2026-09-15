const { compactTags, expandTags } = require("../helpers/compactTags");

describe("compactTags", function () {
  it("compacts null placeholders from Tags.list", function () {
    const compact = compactTags([
      { name: "def", entries: [null, null, null], total: 3 },
    ]);

    expect(compact).toEqual([{ name: "def", total: 3, entryCount: 3 }]);
    expect(expandTags(compact)[0].entries).toEqual([null, null, null]);
  });

  it("compacts undefined placeholders from Tags.popular", function () {
    const compact = compactTags([
      { name: "abc", entries: Array.from({ length: 2 }), total: 2 },
    ]);

    expect(compact).toEqual([{ name: "abc", total: 2, entryCount: 2 }]);
    expect(expandTags(compact)[0].entries.length).toEqual(2);
  });

  it("leaves real entry IDs intact", function () {
    const tags = [{ name: "abc", entries: ["/a.txt", "/b.txt"], total: 2 }];

    expect(compactTags(tags)).toEqual(tags);
    expect(expandTags(compactTags(tags))).toEqual(tags);
  });
});
