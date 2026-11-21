const health = require("clients/health");
const { isSetupError } = require("../error");

// Where an iCloud setup has got to, for the dashboard (views/index.html).
// Before the link is sent it shows the person's steps: create a folder,
// share it with Blot, paste its link. After, it shows Blot's: its Mac joins
// the folder ("joining"), then the site's files are copied in ("copying").
//
// A failed setup puts its message on the step that fixes it. The macserver
// says which check failed (setupErrorReason, from routes/setup.js); one that
// predates that only sends its message, so that is matched instead.

const SHARE_PROBLEMS = {
  PRIVATE:
    "This folder isn’t shared with {email}. Share it as shown below, then paste the new link.",
  NO_ACCESS:
    "This folder isn’t shared with {email}. Share it as shown below, then paste the new link.",
  READ_ONLY:
    "This folder is shared as view only. In Finder, choose Share… › Manage Shared Folder, set {email} to “Can make changes”, then click Connect folder.",
};

const LINK_PROBLEMS = {
  INVALID_LINK:
    "This link doesn’t open a shared folder. Copy it again in Finder.",
  TIMEOUT: "iCloud took too long. Check the link, then click Connect folder.",
};

const FORMAT_PROBLEM =
  "That isn’t an iCloud Drive folder link. Use Copy Link in Finder.";

const SLOW_JOIN_MS = 2 * 60 * 1000;

const EMPTY_PROBLEM = "Paste the link first.";

// What an older macserver sends, matched to the reasons above
const reasonFromMessage = (message) => {
  const text = String(message || "").toLowerCase();
  if (text.includes("is private")) return "PRIVATE";
  if (text.includes("asking for access")) return "NO_ACCESS";
  if (text.includes("only view") || text.includes("view only"))
    return "READ_ONLY";
  if (text.includes("isn’t shared") || text.includes("isn't shared"))
    return "PRIVATE";
  if (text.includes("invalid sharing link")) return "INVALID_LINK";
  if (text.includes("timed out")) return "TIMEOUT";
  return null;
};

// The folder's name: what the macserver reported when it joined the folder
// (and, once it follows renames, since), else the name iCloud put at the end
// of the sharing link when it was copied ("#My_site", spaces as
// underscores). Null when neither is known.
const folderName = (account) => {
  if (!account) return null;
  if (typeof account.folderName === "string" && account.folderName.trim())
    return account.folderName.trim();
  const link = String(account.sharingLink || "");
  const hash = link.indexOf("#");
  if (hash === -1) return null;
  let name = link.slice(hash + 1);
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep it as it is
  }
  name = name.replace(/_/g, " ").trim();
  return name || null;
};

// account: the stored iCloud account, or null
// options.share: show steps 1 and 2 whatever the account says (the setup page)
// options.linkError: "empty" or "format", from a link the form turned down
// options.sharingLink: what was pasted, to put back in the box
// options.email: Blot's iCloud account
module.exports = function setupState(account, options = {}) {
  const email = options.email || "";
  const fill = (text) => text.replace("{email}", email);

  const failed = isSetupError(account);
  const transferFailed =
    !!account &&
    !failed &&
    account.setupComplete !== true &&
    account.errorCode === health.CODES.TRANSFER_INCOMPLETE;

  let stage;
  if (options.share || options.linkError || !account || failed) {
    stage = "share";
  } else if (account.setupComplete === true) {
    stage = "complete";
  } else if (transferFailed) {
    stage = "transferFailed";
  } else if (account.acceptedSharingLink === true) {
    stage = "copying";
  } else if (account.sharingLink) {
    stage = "joining";
  } else {
    stage = "share";
  }

  const state = {
    stage,
    share: stage === "share",
    joining: stage === "joining",
    copying: stage === "copying",
    transferFailed: stage === "transferFailed",
    complete: stage === "complete",
    // In progress: steps 1 and 2 are done
    linked: stage === "joining" || stage === "copying" || transferFailed,
    // Blot's Mac has the folder, so the page shows the lines it will show
    // once setup is done (the folder, then the status) in place of the
    // checklist, and adds the rest when the copy finishes
    joined:
      stage === "copying" || stage === "transferFailed" || stage === "complete",
    sharingLink:
      options.sharingLink !== undefined
        ? options.sharingLink
        : (account && account.sharingLink) || "",
    shareProblem: null,
    linkProblem: null,
    otherProblem: null,
  };

  if (options.linkError === "empty") state.linkProblem = EMPTY_PROBLEM;
  if (options.linkError === "format") state.linkProblem = FORMAT_PROBLEM;

  if (failed && !options.linkError) {
    const reason = account.setupErrorReason || reasonFromMessage(account.error);
    if (SHARE_PROBLEMS[reason])
      state.shareProblem = fill(SHARE_PROBLEMS[reason]);
    else if (LINK_PROBLEMS[reason]) state.linkProblem = LINK_PROBLEMS[reason];
    else state.otherProblem = account.error;
  }

  // What went wrong copying, as reported, shown under step 3
  state.transferDetail = transferFailed ? account.error : null;

  // The macserver reports back within a minute either way, so a join that
  // has run much longer than that lost its answer (a restart, say)
  state.slow =
    stage === "joining" &&
    typeof account.setupStartedAt === "number" &&
    (options.now || Date.now()) - account.setupStartedAt > SLOW_JOIN_MS;

  // How long until the note above is due, so the page can re-render then:
  // nothing else would, if the macserver's answer never comes
  state.slowInMs =
    stage === "joining" &&
    !state.slow &&
    typeof account.setupStartedAt === "number"
      ? Math.max(
          0,
          account.setupStartedAt + SLOW_JOIN_MS - (options.now || Date.now())
        )
      : null;

  // The folder as the owner names it, and the link that opens it for them
  state.folderName = folderName(account);
  state.folderLink = (account && account.sharingLink) || null;

  // Step 3: Blot is busy (spinner), or stuck and needs a retry
  state.working = (state.joining && !state.slow) || state.copying;
  state.stuck = state.slow || state.transferFailed;

  state.problem = !!(
    state.shareProblem ||
    state.linkProblem ||
    state.otherProblem
  );

  return state;
};

module.exports.reasonFromMessage = reasonFromMessage;
module.exports.folderName = folderName;
