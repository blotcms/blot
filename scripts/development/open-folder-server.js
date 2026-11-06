const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = Number(process.env.LOCAL_OPEN_FOLDER_PORT) || 3020;
const SOURCES_DIR = path.resolve(__dirname, "../../data/local-sources");

// Map client types to their folder paths in development
const CLIENT_FOLDERS = {
  dropbox: path.join(os.homedir(), "/Library/CloudStorage/Dropbox/Apps/Blot test"),
  "google-drive": path.join(os.homedir(), "/Library/CloudStorage/GoogleDrive-dmerfield@gmail.com/My Drive/Sites"),
  icloud: path.join(os.homedir(), "/Library/Mobile Documents/com~apple~CloudDocs/Sites"),
};

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");

    if (req.method !== "GET" || url.pathname !== "/open-folder") {
      res.statusCode = 404;
      return res.end();
    }

    const blogID = (url.searchParams.get("blogID") || "").trim();
    const client = (url.searchParams.get("client") || "").trim();

    if (!blogID) {
      res.statusCode = 400;
      return res.end("Missing blogID");
    }

    let folderPath;

    if (client && CLIENT_FOLDERS[client]) {
      // For cloud clients, open the base folder (not blog-specific)
      folderPath = CLIENT_FOLDERS[client];
    } else {
      // For the local client (or no client specified), open its source
      // directory (app/clients/local/source.js), named for the handle
      const handle = (url.searchParams.get("handle") || "").trim();
      const source = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(handle) && !handle.includes("..")
        ? path.join(SOURCES_DIR, handle)
        : null;
      folderPath = source && fs.existsSync(source) ? source : SOURCES_DIR;
    }

    spawn("open", ['-R',folderPath], {
      detached: true,
      stdio: "ignore",
    }).unref();

    res.end("ok");
  })
  .listen(PORT, () => {
    console.log(`[start] Launched local folder opener`);
  });
