// Development-only preload (see --require in docker-compose.yml). While the
// flag file written by scripts/dropbox/fake-quota-full.js exists, Dropbox
// upload requests are answered with the 409 path/insufficient_space error
// Dropbox returns when an account is out of storage, without ever reaching
// Dropbox. Everything above the HTTP layer (SDK, retry, sync) runs for real.
const fs = require("fs");
const os = require("os");
const path = require("path");

const flagPath = path.join(os.tmpdir(), "blot-dropbox-fake-quota-full");

// Uploads are the requests which fail for lack of space
const UPLOAD_URL = /^https:\/\/content\.dropboxapi\.com\/2\/files\/upload/;

const realFetch = globalThis.fetch;

globalThis.fetch = function (input, init) {
  const url = typeof input === "string" ? input : input.url || String(input);

  if (UPLOAD_URL.test(url) && fs.existsSync(flagPath)) {
    console.log("dropbox:fakeQuotaFull returning insufficient_space for", url);
    return Promise.resolve(
      new Response(
        JSON.stringify({
          error_summary: "path/insufficient_space/..",
          error: { ".tag": "path", reason: { ".tag": "insufficient_space" } },
        }),
        { status: 409, headers: { "content-type": "application/json" } }
      )
    );
  }

  return realFetch.apply(this, arguments);
};
