import express from "express";
const { raw } = express;
import { Authorization, maxFileSize } from "./config.js";
import { initialize } from "./watcher/index.js";
import notifyServerStarted from "./httpClient/notifyServerStarted.js";
import clfdate from "./util/clfdate.js";
import monitorer from "./monitorer.js";
import uploadRoute from "./routes/upload.js";
import deleteRoute from "./routes/delete.js";
import mkdirRoute from "./routes/mkdir.js";
import watchRoute from "./routes/watch.js";
import disconnectRoute from "./routes/disconnect.js";
import readdirRoute from "./routes/readdir.js";
import recursiveListRoute from "./routes/recursiveList.js";
import downloadRoute from "./routes/download.js";
import statsRoute from "./routes/stats.js";
import setupRoute from "./routes/setup.js";

const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// maxFileSize is in bytes but limit must be in the format '5mb'
const limit = `${maxFileSize / 1000000}mb`;

const startServer = async () => {
  const app = express();

  app.use((req, res, next) => {
    console.log(clfdate(), `Request: ${req.method} ${req.url}`);

    const authorization = req.header("Authorization"); // New header for the Authorization secret

    if (authorization !== Authorization) {
      console.error(clfdate(), "Unauthorized request", {
        method: req.method,
        url: req.url,
        hasAuthorization: Boolean(authorization),
      });
      return res.status(403).send("Unauthorized");
    }

    next();
  });

  app.use(express.json());

  app.use(raw({ type: "application/octet-stream", limit }));

  app.post("/upload", asyncHandler(uploadRoute));

  app.post("/delete", asyncHandler(deleteRoute));

  app.post("/mkdir", asyncHandler(mkdirRoute));

  app.post("/watch", asyncHandler(watchRoute));

  app.post("/disconnect", asyncHandler(disconnectRoute));

  app.get("/readdir", asyncHandler(readdirRoute));
  app.post("/recursiveList", asyncHandler(recursiveListRoute));

  app.get("/download", asyncHandler(downloadRoute));

  app.get("/stats", asyncHandler(statsRoute));

  app.post("/setup", asyncHandler(setupRoute));

  app.use((err, req, res, next) => {
    console.error(clfdate(), "Macserver error:", err);
    res.status(500).send("Internal Server Error");
  });

  app.listen(3000, () => {
    console.log(clfdate(), "Macserver is running on port 3000");
  });
};

// Main entry point
(async () => {
  try {
    // Test connectivity with the remote server
    console.log(clfdate(), "Pinging remote server...");
    try {
      await notifyServerStarted();
    } catch (error) {
      console.error(clfdate(), "Failed to ping remote server:", error);
    }

    // Start the local server
    console.log(clfdate(), "Starting macserver...");
    await startServer();

    // Initialize the file watcher
    console.log(
      clfdate(),
      "Initializing file watchers for existing folders..."
    );
    await initialize();

    // Start the monitorer to keep iCloud in sync
    console.log(clfdate(), "Starting iCloud monitorer...");
    monitorer();

    console.log(clfdate(), "Macserver started successfully");
  } catch (error) {
    console.error(clfdate(), "Error starting macserver:", error);
    process.exit(1);
  }
})();
