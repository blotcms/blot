// Reconnect strategy for the standalone node-redis clients used by the
// dashboard (session store, login rate limiter). node-redis calls this after a
// dropped connection to decide how long to wait before the next attempt.
//
// Capped exponential backoff with jitter: retries quickly at first (a deploy or
// a brief blip recovers in well under a second) then backs off to a 10s ceiling
// so a longer Redis outage does not turn into a reconnect storm. We never return
// an Error, so the client keeps trying to reconnect for the life of the process
// instead of giving up.
const BASE_DELAY = 100;
const MAX_DELAY = 10000;
const MAX_JITTER = 200;

module.exports = function redisReconnectStrategy(retries) {
  const backoff = Math.min(BASE_DELAY * 2 ** retries, MAX_DELAY);
  return backoff + Math.floor(Math.random() * MAX_JITTER);
};
