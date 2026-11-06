describe("questions.get", function () {
  require("./setup")();

  const create = require("../create");
  const get = require("../get");
  const moment = require("moment");

  it("gets a question", async function () {
    const { id } = await create({ title: "How?", body: "Yes" });
    const question = await get(id);

    expect(question.id).toEqual(id);
    expect(question.title).toEqual("How?");
    expect(question.body).toEqual("Yes");
  });

  it("adds a human readable date under question.time", async function () {
    const { id } = await create({ title: "How?", body: "Yes" });
    const question = await get(id);

    expect(question.time).toEqual("a few seconds ago");
  });

  it("gets a question with replies", async function () {
    const { id } = await create({ title: "How?", body: "Yes" });
    const reply = await create({ body: "Answer", parent: id });

    const question = await get(id);

    expect(question.replies[0].id).toEqual(reply.id);
  });

  it("gets replies in chronological order", async function () {
    const { id } = await create({ title: "How?", body: "Yes" });
    const reply1 = await create({ body: "Answer", parent: id });
    const reply2 = await create({ body: "Answer", parent: id });

    const question = await get(id);

    expect(question.replies[0].id).toEqual(reply1.id);
    expect(question.replies[1].id).toEqual(reply2.id);
  });

  it("keeps the parent question time based on creation date", async function () {
    const oldTimestamp = Date.now() - 1000 * 60 * 60 * 24 * 400;
    const { id } = await create({
      title: "Old question",
      body: "Body",
      created_at: oldTimestamp.toString(),
    });

    const reply = await create({ body: "Recent reply", parent: id });

    const question = await get(id);

    const expectedCreationTime = moment(oldTimestamp).fromNow();
    const expectedLastReplyTime = moment(
      parseInt(reply.created_at, 10)
    ).fromNow();

    expect(question.time).toEqual(expectedCreationTime);
    expect(question.created_time).toEqual(expectedCreationTime);
    expect(question.last_reply_time).toEqual(expectedLastReplyTime);
  });
});
