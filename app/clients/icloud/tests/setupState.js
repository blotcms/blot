const setupState = require("../util/setupState");

describe("icloud setupState", function () {
  const email = "blot@example.com";
  const link = "https://www.icloud.com/iclouddrive/0abc#Site";

  it("starts at the checklist with nothing connected", function () {
    const state = setupState(null, { email });
    expect(state.stage).toBe("share");
    expect(state.linked).toBe(false);
    expect(state.problem).toBe(false);
  });

  it("follows the account through joining, copying and complete", function () {
    expect(setupState({ sharingLink: link }, { email }).stage).toBe("joining");
    expect(
      setupState({ sharingLink: link, acceptedSharingLink: true }, { email })
        .stage
    ).toBe("copying");
    expect(
      setupState(
        { sharingLink: link, acceptedSharingLink: true, setupComplete: true },
        { email }
      ).stage
    ).toBe("complete");
  });

  it("leaves out the copying step only for a site that had nothing to copy", function () {
    const nothing = (account) => setupState(account, { email }).nothingToCopy;
    expect(nothing(null)).toBe(false);
    expect(nothing({ sharingLink: link })).toBe(false);
    expect(nothing({ sharingLink: link, nothingToCopy: false })).toBe(false);
    expect(nothing({ sharingLink: link, nothingToCopy: true })).toBe(true);
  });

  it("marks the join done once Blot's Mac has joined the folder", function () {
    const joined = (account) => setupState(account, { email }).joined;
    expect(joined(null)).toBe(false);
    expect(joined({ sharingLink: link })).toBe(false);
    expect(joined({ sharingLink: link, acceptedSharingLink: true })).toBe(true);
    expect(
      joined({
        sharingLink: link,
        acceptedSharingLink: true,
        errorCode: "TRANSFER_INCOMPLETE",
        error: "x",
      })
    ).toBe(true);
    expect(
      joined({
        sharingLink: link,
        acceptedSharingLink: true,
        setupComplete: true,
      })
    ).toBe(true);
    expect(
      setupState(
        { sharingLink: link, acceptedSharingLink: true, setupComplete: true },
        { email, share: true }
      ).joined
    ).toBe(false);
  });

  it("puts sharing problems on step 2, with Blot's account", function () {
    for (const reason of ["PRIVATE", "NO_ACCESS", "READ_ONLY"]) {
      const state = setupState(
        {
          sharingLink: link,
          error: "x",
          errorCode: "SETUP_FAILED",
          setupErrorReason: reason,
        },
        { email }
      );
      expect(state.stage).toBe("share");
      expect(state.shareProblem).toEqual(jasmine.any(String));
      expect(state.linkProblem).toBe(null);
      expect(state.sharingLink).toBe(link);
    }
    expect(
      setupState(
        { error: "x", errorCode: "SETUP_FAILED", setupErrorReason: "PRIVATE" },
        { email }
      ).shareProblem
    ).toContain(email);
  });

  it("puts link problems on step 3", function () {
    for (const reason of ["INVALID_LINK", "TIMEOUT"]) {
      const state = setupState(
        { error: "x", errorCode: "SETUP_FAILED", setupErrorReason: reason },
        { email }
      );
      expect(state.linkProblem).toEqual(jasmine.any(String));
      expect(state.shareProblem).toBe(null);
    }
  });

  it("reads the reason from an older macserver's message", function () {
    const state = setupState(
      {
        error:
          "This sharing link is private. Share the folder with Blot's iCloud account, or allow anyone with the link to access it, then retry",
        errorCode: "SETUP_FAILED",
      },
      { email }
    );
    expect(state.shareProblem).toEqual(jasmine.any(String));
    expect(setupState.reasonFromMessage("Invalid sharing link")).toBe(
      "INVALID_LINK"
    );
  });

  it("shows any other failure as it was reported", function () {
    const state = setupState(
      {
        error: "Couldn't reach the setup server, please try again in a moment",
        errorCode: "SETUP_FAILED",
      },
      { email }
    );
    expect(state.otherProblem).toContain("setup server");
  });

  it("explains a link the form turned down, keeping what was pasted", function () {
    const state = setupState(null, {
      email,
      linkError: "format",
      sharingLink: "dropbox.com/x",
    });
    expect(state.linkProblem).toContain("Copy Link");
    expect(state.sharingLink).toBe("dropbox.com/x");
    expect(setupState(null, { email, linkError: "empty" }).linkProblem).toEqual(
      jasmine.any(String)
    );
  });

  it("marks a transfer that failed after Blot joined", function () {
    const state = setupState(
      {
        sharingLink: link,
        acceptedSharingLink: true,
        error: "timeout",
        errorCode: "TRANSFER_INCOMPLETE",
      },
      { email }
    );
    expect(state.stage).toBe("transferFailed");
    expect(state.linked).toBe(true);
  });

  it("shows the checklist on the setup page even when connected", function () {
    expect(
      setupState(
        { sharingLink: link, setupComplete: true },
        { email, share: true }
      ).stage
    ).toBe("share");
  });

  it("says when joining has taken much longer than usual", function () {
    const account = { sharingLink: link, setupStartedAt: 1000 };
    expect(setupState(account, { email, now: 1000 + 30 * 1000 }).slow).toBe(
      false
    );
    expect(setupState(account, { email, now: 1000 + 3 * 60 * 1000 }).slow).toBe(
      true
    );
  });
  it("says how long until the slow note is due", function () {
    const account = { sharingLink: link, setupStartedAt: 1000 };
    expect(setupState(account, { email, now: 1000 + 30 * 1000 }).slowInMs).toBe(
      90 * 1000
    );
    expect(
      setupState(account, { email, now: 1000 + 3 * 60 * 1000 }).slowInMs
    ).toBe(null);
  });
  it("names the folder from the macserver, else from the link", function () {
    expect(
      setupState({ sharingLink: link, folderName: "My site" }, { email })
        .folderName
    ).toBe("My site");
    expect(
      setupState(
        { sharingLink: "https://www.icloud.com/iclouddrive/0abc#iCloud_test" },
        { email }
      ).folderName
    ).toBe("iCloud test");
    expect(
      setupState(
        {
          sharingLink:
            "https://www.icloud.com/iclouddrive/0abc#Caf%C3%A9_notes",
        },
        { email }
      ).folderName
    ).toBe("Café notes");
    expect(
      setupState(
        { sharingLink: "https://www.icloud.com/iclouddrive/0abc" },
        { email }
      ).folderName
    ).toBe(null);
    expect(setupState({ sharingLink: link }, { email }).folderLink).toBe(link);
  });
});
