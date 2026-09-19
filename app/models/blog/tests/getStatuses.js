describe("Blog.getStatuses", function () {
  const { promisify } = require("util");
  const setStatus = promisify(require("../setStatus"));
  const getStatuses = promisify(require("../getStatuses"));
  const { v4: uuid } = require("uuid");

  // Create a test user before each spec
  global.test.blog();

  it("gets statuses", async function () {
    const messages = ["Hey", "You", "David"];
    const syncID = "sync_" + uuid().slice(0, 7);
    for (const message of messages)
      await setStatus(this.blog.id, { message, syncID });
    const { statuses } = await getStatuses(this.blog.id);
    expect(statuses.length).toEqual(messages.length);
  });

  it("gets pages of statuses", async function () {
    const syncID = "sync_" + uuid().slice(0, 7);
    const totalMessages = 1000;
    const messages = [];
    while (messages.length < totalMessages)
      messages.push(global.test.fake.lorem.sentence());

    for (const message of messages)
      await setStatus(this.blog.id, { message, syncID });

    const { statuses } = await getStatuses(this.blog.id);

    expect(statuses.length).toEqual(200);
    expect(statuses[0].message).toEqual(messages.at(-1));

    const secondPage = await getStatuses(this.blog.id, { page: 2 });

    expect(secondPage.statuses.length).toEqual(200);

    const shortPage = await getStatuses(this.blog.id, {
      page: 1,
      pageSize: 10,
    });

    expect(shortPage.statuses.length).toEqual(10);
    expect(shortPage.statuses[0].message).toEqual(messages.at(-1));
    expect(shortPage.statuses.at(-1).message).toEqual(messages.at(-10));
  });

  it("returns an empty list when there are no statuses", async function () {
    const { statuses } = await getStatuses(this.blog.id);
    expect(statuses).toEqual([]);
  });

  it("throws errors when args are invalid", async function () {
    const options = { page: 2, pageSize: 10 };

    // Missing blog id
    await expectAsync(getStatuses()).toBeRejected();
    await expectAsync(getStatuses(options)).toBeRejected();
    await expectAsync(getStatuses(null, options)).toBeRejected();
    await expectAsync(getStatuses(undefined, options)).toBeRejected();

    // Invalid blog id
    await expectAsync(getStatuses(1, options)).toBeRejected();
    await expectAsync(getStatuses(() => {}, options)).toBeRejected();
    await expectAsync(getStatuses({}, options)).toBeRejected();

    // Invalid options
    await expectAsync(getStatuses(this.blog.id, { foo: "bar" })).toBeRejected();
    await expectAsync(
      getStatuses(this.blog.id, { pageSize: null, page: 1 })
    ).toBeRejected();
    await expectAsync(
      getStatuses(this.blog.id, { pageSize: 1, page: () => {} })
    ).toBeRejected();

    // Sanity check
    await expectAsync(getStatuses(this.blog.id, options)).not.toBeRejected();
  });
});
