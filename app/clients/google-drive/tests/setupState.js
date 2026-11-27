describe("google drive setupState", function () {
  const setupState = require("../util/setupState");
  const { SETUP_ERROR } = require("../database/error");

  it("has no state without an account", function () {
    expect(setupState(null)).toBe(null);
  });

  it("waits for a shared folder until Blot stores one", function () {
    const state = setupState({ email: "a@example.com", preparing: true });
    expect(state.stage).toBe("share");
    expect(state.inProgress).toBe(true);
    expect(state.shareProblem).toBe(false);
  });

  it("copies the site's files once the folder is stored", function () {
    const state = setupState({ preparing: true, folderId: "f1" });
    expect(state.stage).toBe("copying");
    expect(state.inProgress).toBe(true);
  });

  it("is complete once preparing is cleared", function () {
    const state = setupState({ preparing: false, folderId: "f1" });
    expect(state.stage).toBe("complete");
    expect(state.inProgress).toBe(false);
  });

  it("puts a failed setup in its own stage, even while preparing", function () {
    const state = setupState({ preparing: true, error: SETUP_ERROR });
    expect(state.stage).toBe("failed");
    expect(state.inProgress).toBe(false);
  });

  it("says what was wrong with the last folder shared", function () {
    expect(
      setupState({ preparing: true, nonEmptyFolderShared: true }).shareProblem
    ).toContain("empty folder");
    expect(
      setupState({ preparing: true, nonEditorPermissions: true }).shareProblem
    ).toContain("Editor");
    // Only while Blot is still looking for a folder
    expect(
      setupState({
        preparing: true,
        folderId: "f1",
        nonEmptyFolderShared: true,
      }).shareProblem
    ).toBe(false);
  });
});
