const client = require("models/client");
const keys = require("./keys");
const PAGE_SIZE = 20;

// assign a score to each question based on how well it matches the query
// the title is more important than the body and a complete word match is more important than a partial word match
// after the body, the body of the replies is considered
const Score = (query, result) => {
  // trim, lowercase, and split the query into words
  const title = result.title.toLowerCase();
  const body = result.body.toLowerCase();
  const queryWords = query.trim().toLowerCase().split(" ");

  const titleScore = queryWords.reduce((score, word) => {
    if (title.includes(word)) {
      return score + 1;
    } else {
      return score;
    }
  }, 0);

  const bodyScore = queryWords.reduce((score, word) => {
    if (body.includes(word)) {
      return score + 1;
    } else {
      return score;
    }
  }, 0);

  const replyScore = result.replies.reduce((score, reply) => {
    const replyBody = reply.body.toLowerCase();

    return queryWords.reduce((score, word) => {
      if (replyBody.includes(word)) {
        return score + 1;
      } else {
        return score;
      }
    }, score);
  }, 0);

  return titleScore * 3 + bodyScore + replyScore;
};

// sort the questions by score and paginate them
const sortAndPaginate = (questions, page_size, page) => {
  questions.sort((a, b) => b.score - a.score);

  const startIndex = (page - 1) * page_size;
  const endIndex = startIndex + page_size - 1;

  return questions.slice(startIndex, endIndex + 1);
};

const hasNonEmptyBody = (body) =>
  typeof body === "string" && body.trim().length > 0;

const hasNonEmptyTitle = (title) =>
  typeof title === "string" && title.trim().length > 0;

const load = async (ids) => {
  const childIDs = await Promise.all(
    ids.map((id) => {
      return client.zRange(keys.children(id), 0, -1);
    })
  );

  const results = await Promise.all([
    ...ids.map((id) => client.hGetAll(keys.item(id))),
    ...childIDs.flat().map((id) => client.hGetAll(keys.item(id))),
  ]);

  const questions = results
    .filter(
      (result) =>
        result &&
        !result.parent &&
        hasNonEmptyBody(result.body) &&
        hasNonEmptyTitle(result.title)
    )
    .map((result) => {
      result.replies = results
        .filter(
          (reply) =>
            reply && reply.parent === result.id && hasNonEmptyBody(reply.body)
        )
        .map((reply) => {
          return { body: reply.body };
        });

      return {
        id: result.id,
        title: result.title,
        body: result.body,
        replies: result.replies,
      };
    });

  return questions;
};

module.exports = async ({ query, page = 1, page_size = PAGE_SIZE } = {}) => {
  const key = keys.all_questions;
  const questions = [];
  let cursor = "0";

  do {
    const result = await client.sScan(key, cursor);
    cursor = result.cursor;

    const candidates = await load(result.members);

    candidates.forEach((entry) => {
      const score = Score(query, entry);
      if (score > 0) {
        questions.push({
          title: entry.title,
          id: entry.id,
          score,
        });
      }
    });
  } while (questions.length < page_size * page && cursor !== "0");

  return sortAndPaginate(questions, page_size, page);
};
