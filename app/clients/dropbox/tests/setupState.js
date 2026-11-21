const setupState = require("../util/setupState");

describe("dropbox setupState", function () {
  const classes = (state) => ({
    signIn: state.steps.signIn.className,
    folder: state.steps.folder.className,
    copy: state.steps.copy.className,
  });

  it("leaves signing in to the person before Dropbox sends them back", function () {
    const state = setupState(null);
    expect(state.running).toBe(false);
    expect(state.stage).toBe("start");
    expect(classes(state)).toEqual({
      signIn: "",
      folder: "todo",
      copy: "todo",
    });
  });

  it("keeps the full access an account has when signing in again", function () {
    expect(setupState(null, { fullAccess: true }).fullAccess).toBe(true);
    expect(setupState(null).fullAccess).toBe(false);
  });

  it("puts a failed sign-in's message on the sign-in step", function () {
    const state = setupState(null, { error: "You cancelled" });
    expect(state.steps.signIn.className).toBe("problem");
    expect(state.steps.signIn.problem).toBe("You cancelled");
  });

  it("signs in until the setup has the account's email", function () {
    const state = setupState({ full_access: false, preparing: true });
    expect(state.stage).toBe("signIn");
    expect(classes(state)).toEqual({
      signIn: "active",
      folder: "todo",
      copy: "todo",
    });
  });

  it("creates the folder until the setup has one", function () {
    const state = setupState({ full_access: true, email: "a@example.com" });
    expect(state.stage).toBe("folder");
    expect(state.fullAccess).toBe(true);
    expect(state.email).toBe("a@example.com");
    expect(classes(state)).toEqual({
      signIn: "done",
      folder: "active",
      copy: "todo",
    });
  });

  it("copies once there is a folder, the app folder's root included", function () {
    for (const folder of ["", "/My site"]) {
      const state = setupState({ email: "a@example.com", folder });
      expect(state.stage).toBe("copy");
      expect(classes(state)).toEqual({
        signIn: "done",
        folder: "done",
        copy: "active",
      });
    }
  });
});
