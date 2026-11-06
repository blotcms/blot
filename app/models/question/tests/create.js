describe("questions.create", function () {
  require("./setup")();
  const create = require("../create");

  it("creates a question", async function () {
    const question = await create({ title: "How?", body: "Yes" });

    expect(question.id).toEqual(jasmine.any(String));
    expect(question.title).toEqual("How?");
    expect(question.body).toEqual("Yes");
    expect(question.tags).toEqual([]);
  });

  it("creates a question without a body", async function () {
    const question = await create({ title: "How?" });

    expect(question.id).toEqual(jasmine.any(String));
    expect(question.title).toEqual("How?");
    expect(question.body).toEqual("");
    expect(question.tags).toEqual([]);
  });

  it("respects the ID you supply it as long as it is not new", async function () {
    const question = await create({
      id: "123",
      title: "How?",
      body: "Yes",
    });

    expect(question.id).toEqual("123");
    expect(question.title).toEqual("How?");
    expect(question.body).toEqual("Yes");
    expect(question.tags).toEqual([]);
  });

  it("will error if you create an entry using an existing ID", async function () {
    await create({ id: "123", title: "How?", body: "Yes" });
    try {
      await create({ id: "123", title: "How?", body: "Yes" });
      fail("Should have thrown");
    } catch (e) {
      expect(e.message).toEqual("Item with ID 123 already exists");
    }
  });

  it("will error if you create an entry using a non-string ID", async function () {
    try {
      await create({ id: 123, title: "How?", body: "Yes" });
      fail("Should have thrown");
    } catch (e) {
      expect(e.message).toEqual("Item property id is not a string");
    }
  });

  it("will throw an error if you trigger an issue with redis multi.exec", async function () {
    const client = require("models/client");

    spyOn(client, "multi").and.returnValue({
      zAdd: () => {},
      sAdd: () => {},
      zIncrBy: () => {},
      hSet: () => {},
      setNX: () => {},
      exec: () => Promise.reject(new Error("Oh no!")),
    });

    try {
      await create({ title: "How?", body: "Yes" });
      fail("Should have thrown");
    } catch (e) {
      expect(e.message).toEqual("Oh no!");
    }
  });

  it("will throw an error if you trigger an issue with redis exists", async function () {
    const client = require("models/client");

    spyOn(client, "exists").and.returnValue(
      Promise.reject(new Error("REDIS EXISTS ISSUE"))
    );

    try {
      await create({ title: "How?", id: "1" });
      fail("Should have thrown");
    } catch (e) {
      expect(e.message).toEqual("REDIS EXISTS ISSUE");
    }
  });

  it("will throw an error if you trigger an issue with redis incr", async function () {
    const client = require("models/client");

    spyOn(client, "incr").and.returnValue(
      Promise.reject(new Error("REDIS INCR ISSUE"))
    );

    try {
      await create({ title: "How?", body: "Yes" });
      fail("Should have thrown");
    } catch (e) {
      expect(e.message).toEqual("REDIS INCR ISSUE");
    }
  });

  it("saves tags if you supply them", async function () {
    const question = await create({
      title: "How?",
      body: "Yes",
      tags: ["a", "b"],
    });

    expect(question.id).toEqual(jasmine.any(String));
    expect(question.title).toEqual("How?");
    expect(question.body).toEqual("Yes");
    expect(question.tags).toEqual(["a", "b"]);
  });
});
