// Where a Dropbox setup has got to, for the dashboard's checklist
// (views/authenticate.html and views/index.html). The steps are:
//   signIn: sign in to Dropbox, until Blot has the account (getAccount)
//   folder: Blot creates or finds the site's folder (createFolder)
//   copy:   Blot copies the site's files into it (resetFromBlot)
//
// pending is the setup that routes/dashboard.js's /authenticate put in this
// browser's session (req.session.dropbox). routes/setup/index.js adds to it
// as it goes, and saves the session after each step: the email once the
// account is loaded, then the folder ("" for the root of the app folder).
// It removes it once the setup ends, whether the copy finished or not.
//
// Before Dropbox sends the person back, there is no pending setup: the
// person signs in, and Blot's steps wait. A first setup is always for an app
// folder; the permission page (views/permission.html) switches to the whole
// Dropbox once connected. Signing in again keeps the access the site has.
module.exports = function setupState(pending, options = {}) {
  const running = !!pending;

  let stage;
  if (!running) stage = "start";
  else if (!pending.email) stage = "signIn";
  else if (typeof pending.folder !== "string") stage = "folder";
  else stage = "copy";

  const order = ["signIn", "folder", "copy"];
  const at = order.indexOf(stage);

  // The class each of Blot's steps takes: done, active (with a spinner) or
  // todo. Before Dropbox sends the person back, signing in is theirs to do,
  // so it has no class
  const step = (name) => {
    const index = order.indexOf(name);
    const className = !running
      ? name === "signIn"
        ? ""
        : "todo"
      : index < at
        ? "done"
        : index === at
          ? "active"
          : "todo";

    return {
      className,
      done: className === "done",
      active: className === "active",
      todo: className === "todo",
      // Always set, so the view doesn't find another problem further up
      problem: "",
    };
  };

  const signIn = step("signIn");

  // A cancelled or failed sign-in comes back to the setup page with an error
  if (!running && options.error) {
    signIn.className = "problem";
    signIn.problem = options.error;
  }

  return {
    running,
    stage,
    fullAccess: running ? pending.full_access === true : !!options.fullAccess,
    email: (running && pending.email) || "",
    steps: {
      signIn,
      folder: step("folder"),
      copy: step("copy"),
    },
  };
};
