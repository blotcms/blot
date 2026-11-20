import Bottleneck from "bottleneck";
import clfdate from "./util/clfdate.js";

// Create a map of limiters, one per blogID
const limiters = new Map();

// Stopped limiters of disconnected blogs, kept until a reconnect calls
// /watch: a watcher callback already past its checks when the blog was
// disconnected must not create a fresh limiter and push to Blot.
const stoppedLimiters = new Map();

// How many of one blog's actions run at once. Most of an upload is waiting
// for iCloud: an evicted file takes one to four seconds to download, so a
// batch of files saved together is downloaded side by side. pathOrder.js keeps
// changes to one path in order, and pushInTurn sends one request to Blot at a
// time.
const ACTIONS_PER_BLOG = 4;

/**
 * Get or create a Bottleneck limiter for a specific blogID.
 * Each blogID gets its own limiter, running up to ACTIONS_PER_BLOG actions.
 * @param {string} blogID - The blog ID for which to get the limiter.
 * @returns {Bottleneck} The Bottleneck limiter for the blogID.
 */
const getLimiterForBlogID = (blogID) => {
  if (stoppedLimiters.has(blogID)) {
    console.log(
      clfdate(),
      `Using stopped limiter for disconnected blogID: ${blogID}`
    );
    return stoppedLimiters.get(blogID);
  }

  if (!limiters.has(blogID)) {
    console.log(clfdate(), `Creating limiter for blogID: ${blogID}`);
    const limiter = new Bottleneck({ maxConcurrent: ACTIONS_PER_BLOG });
    limiters.set(blogID, limiter);
  } else {
    console.log(clfdate(), `Using existing limiter for blogID: ${blogID}`);
  }

  return limiters.get(blogID);
};

/**
 * Stop the limiter for a blogID. Jobs still waiting in the queue are dropped
 * and later ones are refused (their schedule() promises reject, see
 * isLimiterStoppedError) until reviveLimiterForBlogID; a job already running
 * is left to finish.
 * @param {string} blogID - The blog ID whose limiter should be removed.
 */
const removeLimiterForBlogID = (blogID) => {
  console.log(clfdate(), `Removing limiter for blogID: ${blogID}`);
  if (stoppedLimiters.has(blogID)) return;

  const limiter = limiters.get(blogID) || new Bottleneck({ maxConcurrent: 1 });
  limiters.delete(blogID);
  stoppedLimiters.set(blogID, limiter);

  console.log(
    clfdate(),
    `Dropping ${limiter.counts().QUEUED} queued action(s) for blogID: ${blogID}`
  );

  limiter.stop({ dropWaitingJobs: true }).catch((error) => {
    console.error(
      clfdate(),
      `Failed to stop limiter for blogID: ${blogID}`,
      error
    );
  });
};

// Called by the /watch route when a blog is reconnected, so its actions get
// a fresh limiter. A restart starts with no stopped limiters.
const reviveLimiterForBlogID = (blogID) => {
  stoppedLimiters.delete(blogID);
};

// True if a schedule() promise rejected because its limiter was stopped
// by removeLimiterForBlogID, rather than because the job itself failed.
const isLimiterStoppedError = (error) =>
  error instanceof Bottleneck.prototype.BottleneckError &&
  /has been stopped/.test(error.message);

const getLimiterCount = () => limiters.size;

// Requests to Blot for one blog, one at a time: Blot takes the blog's sync
// lock for each, and a second request arriving meanwhile waits at least 0.75s
// before it tries the lock again. Resolves or rejects as fn does.
const pushQueues = new Map(); // blogID -> promise of the last request queued

const pushInTurn = (blogID, fn) => {
  const previous = pushQueues.get(blogID) || Promise.resolve();
  const request = previous.then(() => fn());
  const settled = request.catch(() => {});
  pushQueues.set(blogID, settled);
  settled.then(() => {
    if (pushQueues.get(blogID) === settled) pushQueues.delete(blogID);
  });
  return request;
};

export {
  getLimiterForBlogID,
  removeLimiterForBlogID,
  reviveLimiterForBlogID,
  getLimiterCount,
  isLimiterStoppedError,
  pushInTurn,
  ACTIONS_PER_BLOG,
};
