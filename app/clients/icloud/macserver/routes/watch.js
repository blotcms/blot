import { watch } from "../watcher/index.js";
import { reviveLimiterForBlogID } from "../limiters.js";
import clfdate from "../util/clfdate.js";

export default async (req, res) => {
  const blogID = req.header("blogID");

  if (!blogID) {
    console.error(clfdate(), "Missing blogID header for watch request");
    return res.status(400).send("Missing blogID header");
  }

  try {
    // Blot calls this once a (re)connected blog's initial transfer is done,
    // so a limiter stopped by an earlier disconnect can run actions again.
    // Only here: the internal watch() calls after a Blot write or an
    // eviction must not revive a blog that was disconnected meanwhile.
    reviveLimiterForBlogID(blogID);

    // watch the blog
    await watch(blogID);
  } catch (error) {
    console.error(clfdate(), `Failed to watch blogID (${blogID}):`, error);
    return res.status(500).send("Failed to watch blog folder");
  }

  console.log(clfdate(), `Recieved watch request for: ${blogID}`);
  res.sendStatus(200);
};
