const create = require("./create");

async function importQuestions(allQuestions) {
  // validate input
  if (!Array.isArray(allQuestions)) {
    throw new Error("Input must be an array");
  }

  // check if there are any questions to import
  if (allQuestions.length === 0) {
    console.log("No questions to import");
    return;
  }

  for (const question of allQuestions) {
    const createdQuestion = await create({
      id: question.id || "",
      title: question.title,
      body: question.body,
      parent: question.parent || "",
      author: question.author || "",
      tags: question.tags || [],
      created_at: question.created_at,
    });

    for (const reply of question.replies) {
      await create({
        id: reply.id || "",
        title: reply.title || "",
        body: reply.body,
        parent: createdQuestion.id,
        author: reply.author || "",
        tags: reply.tags || [],
        created_at: reply.created_at,
      });
    }
  }

  console.log("Questions imported successfully");
}

module.exports = importQuestions;
