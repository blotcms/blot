describe("clients/util countChanges", function () {
  const countChanges = require("../countChanges");

  it("counts downloads, removals and created directories", function () {
    expect(
      countChanges({ downloaded: 2, removed: 1, createdDirs: 3, skipped: 9 })
    ).toEqual(6);
  });

  it("ignores files modified after the walk started", function () {
    expect(countChanges({ downloaded: 1, modifiedDuringWalk: 1 })).toEqual(0);
    expect(
      countChanges({ downloaded: 3, modifiedDuringWalk: 1, removed: 1 })
    ).toEqual(3);
  });

  it("ignores changes Dropbox reported during the walk", function () {
    expect(countChanges({ removed: 3, changedDuringWalk: 3 })).toEqual(0);
    expect(
      countChanges({ downloaded: 2, modifiedDuringWalk: 1, removed: 2, changedDuringWalk: 1 })
    ).toEqual(2);
  });

  it("handles a missing summary", function () {
    expect(countChanges()).toEqual(0);
  });
});
