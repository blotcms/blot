const client = require("models/client");
const serializeRedisHashValue = require("models/redisHashSerializer").value;
const keys = require("./keys");
const get = require("./get");

module.exports = async (id, updates) => {
  // node-redis requires sorted-set members to be strings
  id = String(id);

  const existing = await get(id);

  if (!existing) throw new Error("Question with ID " + id + " does not exist");

  const multi = client.multi();
  const created_at =
    existing.created_at || updates.created_at || Date.now().toString();
  const removedTags = [];

  for (const key in updates) {
    multi.hSet(keys.item(id), key, serializeRedisHashValue(updates[key]));
  }

  // we need to update any tags
  if (updates.tags) {
    for (const tag of updates.tags) {
      multi.sAdd(keys.all_tags, tag);
      multi.zAdd(keys.by_tag(tag), {
        score: parseInt(created_at, 10),
        value: id,
      });
    }

    for (const tag of existing.tags) {
      if (!updates.tags.includes(tag)) {
        multi.zRem(keys.by_tag(tag), id);
        removedTags.push(tag);
      }
    }
  }

  const tagsToRemove = await identifyTagsToRemove(removedTags);

  for (const tag of tagsToRemove) {
    multi.sRem(keys.all_tags, tag);
  }

  await multi.exec();

  // get the latest version of the question
  // and return it
  return get(id);
};

// clean up any tags that are no longer used
async function identifyTagsToRemove(removedTags) {
  const replies = await Promise.all(
    removedTags.map((tag) => {
      return client.zCard(keys.by_tag(tag));
    })
  );

  return removedTags.filter((_, i) => replies[i] <= 1);
}
