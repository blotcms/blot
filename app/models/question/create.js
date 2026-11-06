const client = require("models/client");
const serializeRedisHashValues = require("models/redisHashSerializer");
const keys = require("./keys");
const get = require("./get");

module.exports = async function ({
  id = "",
  parent = "",
  title = "",
  body = "",
  author = "",
  tags = [],
  created_at = Date.now().toString(),
}) {
  // If no id is provided, generate one
  if (!id) {
    id = await generateID();
  } else {
    const isUnique = await checkIDisUnique(id);
    if (!isUnique) throw new Error("Item with ID " + id + " already exists");
  }

  const item = {
    id,
    parent,
    author,
    title,
    body,
    tags: parent ? "[]" : JSON.stringify(tags),
    created_at,
  };

  // check all the properties of the item are strings
  Object.keys(item).forEach((key) => {
    if (typeof item[key] !== "string") {
      throw new Error("Item property " + key + " is not a string");
    }
  });

  const multi = client.multi();

  // Handle replies
  if (parent) {
    multi.zAdd(keys.children(parent), {
      score: parseInt(created_at, 10),
      value: id,
    });
    multi.zAdd(keys.by_last_reply, {
      score: parseInt(created_at, 10),
      value: parent,
    });
    multi.zIncrBy(keys.by_number_of_replies, 1, parent);

    // Handle questions
  } else {
    tags.forEach((tag) => {
      multi.sAdd(keys.all_tags, tag);
      multi.zAdd(keys.by_tag(tag), {
        score: parseInt(created_at, 10),
        value: id,
      });
    });

    multi.sAdd(keys.all_questions, id);
    multi.zAdd(keys.by_last_reply, {
      score: parseInt(created_at, 10),
      value: id,
    });
    multi.zAdd(keys.by_created, { score: parseInt(created_at, 10), value: id });
    multi.zAdd(keys.by_number_of_replies, { score: 0, value: id });
  }

  multi.hSet(keys.item(id), serializeRedisHashValues(item));

  // ensure the multi command fails if the ID
  // is already in use
  multi.setNX(keys.item(id), id);

  await multi.exec();

  return get(id);
};

async function checkIDisUnique(id) {
  return !(await client.exists(keys.item(id)));
}

async function generateID() {
  const id = await client.incr(keys.next_id);
  return id.toString();
}
