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

  describe("stopped", function () {
    const { stopped, START_GRACE_MS } = setupState;
    const now = 1000000;

    it("is a running setup while the folder lock is held", function () {
      expect(stopped({ started: 0 }, true, now)).toBe(false);
    });

    it("gives a setup that has just started time to take the lock", function () {
      expect(stopped({ started: now - 1000 }, false, now)).toBe(false);
    });

    it("has stopped once nothing holds the lock after that", function () {
      expect(stopped({ started: now - START_GRACE_MS - 1 }, false, now)).toBe(
        true
      );
    });

    it("has stopped for a setup from before started was stored", function () {
      expect(stopped({ preparing: true }, false, now)).toBe(true);
    });

    it("has nothing to stop without a setup", function () {
      expect(stopped(undefined, false, now)).toBe(false);
    });
  });
});
