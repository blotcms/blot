describe("questions.list", function () {
  require("./setup")();

  const create = require("../create");
  const list = require("../list");

  it("lists questions in the order they were created, most recent first", async function () {
    const first = await create({ title: "How?", body: "Yes" });
    const second = await create({ title: "How?", body: "Yes" });
    const third = await create({ title: "How?", body: "Yes" });

    const { questions } = await list();

    expect(questions.length).toBe(3);
    expect(questions[0].id).toBe(third.id);
    expect(questions[1].id).toBe(second.id);
    expect(questions[2].id).toBe(first.id);
  });

  it("lists questions by most recent reply", async function () {
    const first = await create({ title: "How?", body: "Yes" });
    const second = await create({ title: "How?", body: "Yes" });
    const third = await create({ title: "How?", body: "Yes" });

    await create({ body: "reply", parent: third.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await create({ body: "reply", parent: first.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await create({ body: "reply", parent: first.id });

    const { questions } = await list();

    expect(questions.length).toBe(3);

    expect(questions[0].id).toBe(first.id);
    expect(questions[1].id).toBe(third.id);
    expect(questions[2].id).toBe(second.id);
  });

  it("when you list questions by tag, the most recent question appears first", async function () {
    const first = await create({ title: "How?", body: "Yes", tags: ["foo"] });
    const second = await create({ title: "How?", body: "Yes", tags: ["foo"] });
    const third = await create({ title: "How?", body: "Yes", tags: ["foo"] });

    const { questions } = await list({ tag: "foo" });

    expect(questions.length).toBe(3);
    expect(questions[0].id).toBe(third.id);
    expect(questions[1].id).toBe(second.id);
    expect(questions[2].id).toBe(first.id);
  });

  it("paginates questions with a default page size of 10", async function () {
    for (let i = 0; i < 15; i++) {
      await create({ title: "How?", body: "Yes" });
    }

    const { questions, stats } = await list();

    expect(stats.total).toBe(15);
    expect(questions.length).toBe(10);

    const page_two = await list({ page: 2 });

    expect(page_two.questions.length).toBe(5);
  });

  it("lets you list the questions with a given tag", async function () {
    const first = await create({ title: "How?", body: "Yes", tags: ["foo"] });
    await create({ title: "How?", body: "Yes", tags: ["bar"] });
    const third = await create({ title: "How?", body: "Yes", tags: ["foo"] });

    const { questions } = await list({ tag: "foo" });

    expect(questions.length).toBe(2);
    expect(questions[0].id).toBe(third.id);
    expect(questions[1].id).toBe(first.id);
  });

  it("lets you list questions by created date, regardless of last reply time", async function () {
    const first = await create({ title: "How?", body: "Yes" });
    const second = await create({ title: "How?", body: "Yes" });
    const third = await create({ title: "How?", body: "Yes" });

    await create({ title: "How?", body: "Yes", parent: first.id });

    const { questions } = await list({ sort: 'by_created' });

    expect(questions.length).toBe(3);
    expect(questions[0].id).toBe(third.id);
    expect(questions[1].id).toBe(second.id);
    expect(questions[2].id).toBe(first.id);
  });

  it("lets you list questions by number of replies", async function () {
    const first = await create({ title: "How?", body: "Yes" });
    const second = await create({ title: "How?", body: "Yes" });
    const third = await create({ title: "How?", body: "Yes" });

    await create({ title: "How?", body: "Yes", parent: second.id });
    await create({ title: "How?", body: "Yes", parent: second.id });

    await create({ title: "How?", body: "Yes", parent: first.id });

    const { questions } = await list({ sort: 'by_number_of_replies' });

    expect(questions.length).toBe(3);
    expect(questions[0].id).toBe(second.id);
    expect(questions[1].id).toBe(first.id);
    expect(questions[2].id).toBe(third.id);
  });

  it("returns the number of replies for each question", async function () {
    const first = await create({ title: "How?", body: "Yes" });
    const second = await create({ title: "How?", body: "Yes" });
    const third = await create({ title: "How?", body: "Yes" });

    await create({ title: "How?", body: "Yes", parent: first.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await create({ title: "How?", body: "Yes", parent: first.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await create({ title: "How?", body: "Yes", parent: second.id });

    const { questions } = await list();

    expect(questions.length).toBe(3);
    expect(questions[0].id).toBe(second.id);
    expect(questions[1].id).toBe(first.id);
    expect(questions[2].id).toBe(third.id);

    expect(questions[0].number_of_replies).toBe(1);
    expect(questions[1].number_of_replies).toBe(2);
    expect(questions[2].number_of_replies).toBe(0);
  });
});
