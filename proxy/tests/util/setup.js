const server = require("./upstream-server");
const fetch = require("node-fetch");
const child_process = require("child_process");
const mustache = require("mustache");
const os = require("os");
const { basename, resolve } = require("path");
const fs = require("fs-extra");

function openrestyIdentity() {
  // os.userInfo() throws when the running uid has no /etc/passwd entry (some
  // sandboxed CI/agent environments), so only call it when the env var is
  // absent and fall back to "root" if it still blows up.
  let username = process.env.BLOT_OPENRESTY_TEST_USER;
  if (!username) {
    try {
      username = os.userInfo().username;
    } catch (e) {
      username = "root";
    }
  }
  // nginx `user` must exist. Root in Docker/CI uses group root; the original
  // macOS default is staff.
  const group =
    process.env.BLOT_OPENRESTY_TEST_GROUP ||
    (username === "root" ? "root" : "staff");
  return { username, group };
}

const PROXY_DIRECTORY = resolve(__dirname + "/../../");
const DATA_DIRECTORY = PROXY_DIRECTORY + "/tests/data";

const config = {
  openresty: {
    port: 8787
  },
  node: {
    port: 8788
  }
};

const startOpenresty = async (pathToConf, origin) => {
  try {
    const output = child_process.execSync(
      __dirname + "/start-openresty.sh " + pathToConf
    );
    // console.log(output.toString());
  } catch (e) {
    console.log("stdout: ", e.stdout.toString());
    console.log("stderr: ", e.stderr.toString());
    throw new Error("Failed to start openresty");
  }

  let connected = false;

  while (!connected) {
    try {
      // this seems to hang sometimes, set a timeout of 1 second
      await fetch(origin + "/health", { timeout: 1000 });
      connected = true;
    } catch (e) {
      //   console.log("Openresty not started yet");
    }
  }
};

const stopOpenresty = async () => {
  try {
    const output = child_process.execSync(__dirname + "/stop-openresty.sh");
    // console.log(output.toString());
  } catch (e) {}
};

// Options:
//   upstream: a function({ port }) resolving to a server, instead of the
//     stub in upstream-server.js
module.exports = (configFile, { upstream = server } = {}) => {
  beforeEach(async function () {
    await fs.emptyDir(DATA_DIRECTORY);

    const origin = `http://127.0.0.1:${config.openresty.port}`;

    this.origin = origin;

    const configInput = PROXY_DIRECTORY + "/tests/" + configFile;
    const configPath = DATA_DIRECTORY + "/" + basename(configFile);

    const identity = openrestyIdentity();
    const result = mustache.render(await fs.readFile(configInput, "utf8"), {
      ...config,
      user: identity.username,
      group: identity.group,
      lua_directory: PROXY_DIRECTORY + "/config",
      data_directory: DATA_DIRECTORY
    });

    await fs.outputFile(configPath, result, "utf8");

    await stopOpenresty();

    await startOpenresty(configPath, this.origin);

    this.server = await upstream({ port: config.node.port });

    this.reloadOpenresty = async () => {
      child_process.execSync(
        __dirname + "/start-openresty.sh " + configPath + " -s reload"
      );
    };

    this.restartOpenresty = async () => {
      // get the pid of the current openresty process
      const masterpid = () =>
        child_process
          .execSync(
            "ps aux | grep openresty | grep 'master process' | awk '{print $2}'"
          )
          .toString()
          .trim();

      const pidBefore = masterpid();

      await stopOpenresty();
      await startOpenresty(configPath, origin);

      // check that the pid has changed
      const pidAfter = masterpid();

      if (!pidBefore) {
        throw new Error("Openresty was not running");
      }

      if (!pidAfter) {
        throw new Error("Openresty did not start");
      }

      if (pidBefore === pidAfter) {
        throw new Error("Openresty did not restart");
      }
    };
  });

  afterEach(async function () {
    await stopOpenresty();
    await this.server.close();
  });
};
