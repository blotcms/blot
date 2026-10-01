const { promisify } = require("util");
const fs = require("fs-extra");
const health = require("clients/health");
const database = require("../database");
const getHealth = require("../getHealth");
const { MESSAGES } = require("../error");
const dataDir = require("../dataDir");
const localPath = require("helper/localPath");

describe("git getHealth", function () {
  global.test.blog();

  const setStatus = promisify(database.setStatus.bind(database));
  const setIssue = promisify(database.setIssue.bind(database));
  const createToken = promisify(database.createToken.bind(database));
  const flush = promisify(database.flush.bind(database));

  async function connectGit() {
    const Blog = require("models/blog");
    const set = promisify(Blog.set);
    await set(this.blog.id, { client: "git" });
    await createToken(this.blog.owner);
    await fs.ensureDir(dataDir + "/" + this.blog.handle + ".git");
    await fs.ensureDir(localPath(this.blog.id, "/.git"));
    await setStatus(this.blog.id, database.STATUSES.CREATE_COMPLETE);
  }

  it("is exported on the Git client", function () {
    expect(typeof require("../index").getHealth).toBe("function");
  });

  it("returns syncing while repository creation is in progress", async function () {
    await setStatus(this.blog.id, database.STATUSES.CREATE_IN_PROGRESS);

    expect(await getHealth(this.blog.id)).toEqual(health.syncing());
  });

  it("returns SYNC_ERROR when repository creation failed", async function () {
    await createToken(this.blog.owner);
    await setStatus(this.blog.id, database.STATUSES.CREATE_FAILED);

    const result = await getHealth(this.blog.id);

    expect(result.state).toBe(health.STATES.ERROR);
    expect(result.issues[0].code).toBe(health.CODES.SYNC_ERROR);
    expect(result.issues[0].message).toBe(MESSAGES.SETUP_FAILED);
    expect(typeof result.issues[0].since).toBe("number");
  });

  it("does not also report SOURCE_MISSING after a failed create", async function () {
    await createToken(this.blog.owner);
    await setStatus(this.blog.id, database.STATUSES.CREATE_FAILED);

    const result = await getHealth(this.blog.id);
    const codes = result.issues.map(function (issue) {
      return issue.code;
    });

    expect(codes).toEqual([health.CODES.SYNC_ERROR]);
  });

  it("returns SOURCE_MISSING when the git repositories are gone", async function () {
    await createToken(this.blog.owner);
    await setStatus(this.blog.id, database.STATUSES.CREATE_COMPLETE);

    const result = await getHealth(this.blog.id);

    expect(result).toEqual(
      health.error([
        {
          code: health.CODES.SOURCE_MISSING,
          message: MESSAGES.SOURCE_MISSING,
        },
      ])
    );
  });

  it("returns REAUTH_REQUIRED when the git token is missing", async function () {
    await connectGit.call(this);
    await flush(this.blog.owner);

    const result = await getHealth(this.blog.id);

    expect(result.state).toBe(health.STATES.ERROR);
    expect(result.issues[0].code).toBe(health.CODES.REAUTH_REQUIRED);
    expect(result.issues[0].message).toBe(MESSAGES.REAUTH_REQUIRED);
  });

  it("returns a persisted sync issue", async function () {
    await connectGit.call(this);
    await setIssue(this.blog.id, {
      code: health.CODES.SYNC_ERROR,
      message: "Git blogs support regular files only (no symbolic links or submodules)",
      since: 1758000000000,
    });

    const result = await getHealth(this.blog.id);

    expect(result).toEqual(
      health.error([
        {
          code: health.CODES.SYNC_ERROR,
          message:
            "Git blogs support regular files only (no symbolic links or submodules)",
          since: 1758000000000,
        },
      ])
    );
  });

  it("returns ok when create finished, the token exists, and both repos exist", async function () {
    await connectGit.call(this);

    expect(await getHealth(this.blog.id)).toEqual(health.ok());
  });
});
