const prefix = "blot:questions:";

module.exports = {
  // integer which we INCR to get a new question or reply id
  next_id: prefix + "next_id",

  // hash representing either a question
  // or a reply or a comment
  item: (id) => prefix + `item:${id}`,

  // sorted set containing all the child nodes of
  // an item. For a question, this is a list
  // of replies. For a reply, this is a list
  // of comments.
  children: (id) => prefix + `id:${id}:children`,

  // sets
  all_questions: prefix + "all",
  all_tags: prefix + "tags",

  // sorted sets which we use as indexes
  by_last_reply: prefix + "by_last_reply",
  by_created: prefix + "by_created",
  by_tag: (tag) => prefix + `by_tag:${tag}`,
  by_number_of_replies: prefix + "by_number_of_replies",
};
