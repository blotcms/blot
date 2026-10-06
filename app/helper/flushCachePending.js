// Redis-backed record of hosts a reverse proxy failed to purge (see
// helper/flushCache). One sorted set per proxy URL: member = host, score =
// when the failure was recorded. A later failure for the same host bumps the
// score, so a retry that started before it does not delete it.

const key = (target) => `flushCache:pending:${target}`;

// Remove members only if their score still matches what list() returned.
const REMOVE_UNCHANGED = `
local removed = 0
for i = 1, #ARGV, 2 do
  local score = redis.call('ZSCORE', KEYS[1], ARGV[i])
  if score and tonumber(score) == tonumber(ARGV[i + 1]) then
    redis.call('ZREM', KEYS[1], ARGV[i])
    removed = removed + 1
  end
end
return removed
`;

module.exports = (client) => ({
  async add(target, hosts) {
    const score = Date.now();
    await client.zAdd(
      key(target),
      hosts.map((value) => ({ score, value }))
    );
  },

  async list(target) {
    const members = await client.zRangeWithScores(key(target), 0, -1);
    return members.map(({ value, score }) => ({ host: value, score }));
  },

  async remove(target, entries) {
    if (!entries.length) return;

    await client.eval(REMOVE_UNCHANGED, {
      keys: [key(target)],
      arguments: entries.flatMap(({ host, score }) => [host, String(score)]),
    });
  },
});
