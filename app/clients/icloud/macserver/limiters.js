import Bottleneck from "bottleneck";
import clfdate from "./util/clfdate.js";

// Create a map of limiters, one per blogID
const limiters = new Map();

// Stopped limiters of disconnected blogs, kept until a reconnect calls
// /watch: a watcher callback already past its checks when the blog was
// disconnected must not create a fresh limiter and push to Blot.
const stoppedLimiters = new Map();

/**
 * Get or create a Bottleneck limiter for a specific blogID.
 * Each blogID gets its own limiter to ensure events are processed sequentially.
 * @param {string} blogID - The blog ID for which to get the limiter.
 * @returns {Bottleneck} The Bottleneck limiter for the blogID.
 */
const getLimiterForBlogID = (blogID) => {
  if (stoppedLimiters.has(blogID)) {
    console.log(clfdate(), `Using stopped limiter for disconnected blogID: ${blogID}`);
    return stoppedLimiters.get(blogID);
  }

  if (!limiters.has(blogID)) {
    // Create a new limiter for this blogID with concurrency of 1
    console.log(clfdate(), `Creating limiter for blogID: ${blogID}`);
    const limiter = new Bottleneck({
      maxConcurrent: 1, // Only one task per blogID can run at a time
    });
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

  const limiter =
    limiters.get(blogID) || new Bottleneck({ maxConcurrent: 1 });
  limiters.delete(blogID);
  stoppedLimiters.set(blogID, limiter);

  console.log(
    clfdate(),
    `Dropping ${limiter.counts().QUEUED} queued action(s) for blogID: ${blogID}`
  );

  limiter.stop({ dropWaitingJobs: true }).catch((error) => {
    console.error(clfdate(), `Failed to stop limiter for blogID: ${blogID}`, error);
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

export {
  getLimiterForBlogID,
  removeLimiterForBlogID,
  reviveLimiterForBlogID,
  getLimiterCount,
  isLimiterStoppedError,
};
