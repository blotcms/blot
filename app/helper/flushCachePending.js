// Redis-backed record of hosts not yet purged from a reverse proxy (see
// helper/flushCache). One sorted set per proxy URL: member = host, score =
// when the purge was recorded. Recording the same host again bumps the
// score, so a purge that started before it does not delete it.

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
  async add(target, hosts, score = Date.now()) {
    if (!hosts.length) return;

    await client.zAdd(
      key(target),
      hosts.map((value) => ({ score, value }))
    );
  },

  // Entries recorded at or before maxScore, oldest first, at most count
  async list(target, maxScore = "+inf", count = -1) {
    const members = await client.zRangeWithScores(key(target), "-inf", maxScore, {
      BY: "SCORE",
      LIMIT: { offset: 0, count },
    });
    // Scores are recorded to the thousandth, but RESP3 decodes them slightly
    // off, and a removal must send back exactly what was recorded
    return members.map(({ value, score }) => ({
      host: value,
      score: Math.round(score * 1000) / 1000,
    }));
  },

  async remove(target, entries) {
    if (!entries.length) return;

    await client.eval(REMOVE_UNCHANGED, {
      keys: [key(target)],
      arguments: entries.flatMap(({ host, score }) => [host, String(score)]),
    });
  },
});
