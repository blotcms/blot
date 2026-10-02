describe("google-drive countChanges", function () {
  const countChanges = require("../sync/count-changes");

  it("counts downloads, removals and created directories", function () {
    expect(
      countChanges({ downloaded: 2, removed: 1, createdDirs: 3 })
    ).toEqual(6);
  });

  it("ignores downloads modified during the walk", function () {
    expect(countChanges({ downloaded: 1, modifiedDuringWalk: 1 })).toEqual(0);
    expect(
      countChanges({ downloaded: 3, modifiedDuringWalk: 1, removed: 1 })
    ).toEqual(3);
  });

  it("handles a missing summary", function () {
    expect(countChanges()).toEqual(0);
  });
});
