describe("importQuestions", function () {
  require("./setup")();

  require("models/client"); // Ensure this client is correctly initialized
  const importQuestions = require("../import"); // Adjust the path as needed
  const exportQuestions = require("../export"); // We'll use this to verify the import

  it("imports questions correctly into Redis", async function (done) {
    const allQuestions = [
      {
        id: "1",
        title: "How?",
        body: "Yes",
        parent: "",
        author: "",
        tags: [],
        created_at: Date.now().toString(),
        replies: [
          {
            id: "2",
            title: "",
            body: "Reply to How?",
            parent: "1",
            author: "",
            tags: [],
            created_at: Date.now().toString(),
            comments: [],
          },
        ],
      },
      {
        id: "3",
        title: "What?",
        body: "No",
        parent: "",
        author: "",
        tags: [],
        created_at: Date.now().toString(),
        replies: [],
      },
    ];

    await importQuestions(allQuestions);

    const exportedData = await exportQuestions();

    expect(exportedData.length).toBe(2);
    expect(exportedData).toEqual(jasmine.arrayContaining(allQuestions));
    done();
  });

  it("handles empty input gracefully", async function (done) {
    await importQuestions([]);

    const exportedData = await exportQuestions();

    expect(exportedData).toEqual([]);
    done();
  });

  it("throws an error for invalid input", async function (done) {
    try {
      await importQuestions({});
    } catch (err) {
      expect(err.message).toBe("Input must be an array");
      done();
    }
  });

  it("imports questions without replies", async function (done) {
    const allQuestions = [
      {
        id: "1",
        title: "How?",
        body: "Yes",
        parent: "",
        author: "",
        tags: [],
        created_at: Date.now().toString(),
        replies: [],
      },
    ];

    await importQuestions(allQuestions);

    const exportedData = await exportQuestions();

    expect(exportedData.length).toBe(1);
    expect(exportedData).toEqual(jasmine.arrayContaining(allQuestions));
    done();
  });

  it("imports replies without comments", async function (done) {
    const allQuestions = [
      {
        id: "1",
        title: "How?",
        body: "Yes",
        parent: "",
        author: "",
        tags: [],
        created_at: Date.now().toString(),
        replies: [
          {
            id: "2",
            title: "",
            body: "Reply to How?",
            parent: "1",
            author: "",
            tags: [],
            created_at: Date.now().toString(),
            comments: [],
          },
        ],
      },
    ];

    await importQuestions(allQuestions);

    const exportedData = await exportQuestions();

    expect(exportedData.length).toBe(1);
    expect(exportedData).toEqual(jasmine.arrayContaining(allQuestions));
    done();
  });
});
