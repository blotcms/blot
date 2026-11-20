const health = require("clients/health");
const { isSetupError } = require("../error");

// Where an iCloud setup has got to, for the dashboard's checklist
// (views/index.html). Steps 1 and 2 are the person's: share a folder with
// Blot, paste its link. Step 3 is Blot's: its Mac joins the folder
// ("joining"), then the site's files are copied in ("copying").
//
// A failed setup puts its message on the step that fixes it. The macserver
// says which check failed (setupErrorReason, from routes/setup.js); one that
// predates that only sends its message, so that is matched instead.

const SHARE_PROBLEMS = {
  PRIVATE:
    "This folder isn’t shared with {email}. Share it as shown below, then copy the link again and paste it in step 2.",
  NO_ACCESS:
    "This folder isn’t shared with {email}. Share it as shown below, then copy the link again and paste it in step 2.",
  READ_ONLY:
    "Blot can only view this folder, so it can’t add your site’s files. In Finder, choose Share… › Manage Shared Folder, set Blot’s iCloud account to “Can make changes”, then click Connect folder.",
};

const LINK_PROBLEMS = {
  INVALID_LINK:
    "This link doesn’t open a shared folder. Copy it again in Finder (Share… › Copy Link) and paste it below.",
  TIMEOUT:
    "iCloud took too long to give Blot the folder. Check this is the link to the folder you shared, then click Connect folder.",
};

const FORMAT_PROBLEM =
  "That isn’t an iCloud Drive folder link. Use Copy Link in Finder; the link starts with https://www.icloud.com/iclouddrive/";

const SLOW_JOIN_MS = 2 * 60 * 1000;

const EMPTY_PROBLEM = "Paste the folder’s link first.";

// What an older macserver sends, matched to the reasons above
const reasonFromMessage = (message) => {
  const text = String(message || "").toLowerCase();
  if (text.includes("is private")) return "PRIVATE";
  if (text.includes("asking for access")) return "NO_ACCESS";
  if (text.includes("only view")) return "READ_ONLY";
  if (text.includes("invalid sharing link")) return "INVALID_LINK";
  if (text.includes("timed out")) return "TIMEOUT";
  return null;
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
