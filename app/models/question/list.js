const PAGE_SIZE = 10;
const client = require("models/client");
const keys = require("./keys");
const moment = require("moment");

module.exports = async ({
  page = 1,
  tag = "",
  page_size = PAGE_SIZE,
  sort = "by_last_reply",
} = {}) => {
  const startIndex = (page - 1) * page_size;
  const endIndex = startIndex + page_size - 1;

  const key = tag
    ? keys.by_tag(tag)
    : sort === "by_created"
      ? keys.by_created
      : sort === "by_number_of_replies"
        ? keys.by_number_of_replies
        : keys.by_last_reply;

  const [total, question_ids] = await Promise.all([
    client.zCard(key),
    client.zRange(key, startIndex, endIndex, { REV: true }),
  ]);

  if (!question_ids.length) {
    return { questions: [], stats: { total, page_size, page } };
  }

  const results = (
    await Promise.all(
      question_ids.map(async (id) => {
        return Promise.all([
          client.hGetAll(keys.item(id)),
          client.zScore(keys.by_last_reply, id),
          client.zScore(keys.by_number_of_replies, id),
        ]);
      })
    )
  ).flat();

  const questions = results
    .filter((_, index) => index % 3 === 0)
    .map((question, index) => {
      const last_reply_created_at = results[index * 3 + 1];
      const number_of_replies = results[index * 3 + 2];

      const createdTimestamp = parseInt(question.created_at, 10);
      const hasValidCreatedTimestamp = !Number.isNaN(createdTimestamp);
      const createdDate = hasValidCreatedTimestamp
        ? new Date(createdTimestamp)
        : new Date();
      const createdTime = moment(createdDate).fromNow();

      const hasLastReplyTimestamp =
        last_reply_created_at !== null &&
        !Number.isNaN(parseInt(last_reply_created_at, 10));
      const lastReplyTimestamp = hasLastReplyTimestamp
        ? last_reply_created_at
        : question.created_at;
      const lastReplyTimestampInt = parseInt(lastReplyTimestamp, 10);
      const lastReplyDate = Number.isNaN(lastReplyTimestampInt)
        ? createdDate
        : new Date(lastReplyTimestampInt);

      question.last_reply_created_at = lastReplyTimestamp;
      question.last_reply_time = moment(lastReplyDate).fromNow();
      question.created_time = createdTime;
      question.time = createdTime;

      const parsedNumberOfReplies = parseInt(number_of_replies, 10);
      question.number_of_replies = Number.isNaN(parsedNumberOfReplies)
        ? 0
        : parsedNumberOfReplies;

      try {
        question.tags = JSON.parse(question.tags);
      } catch (err) {
        question.tags = [];
      }

      return question;
    })
    .filter((question) => question.title && !!question.title.trim());

  return { questions, stats: { total, page_size, page } };
};
