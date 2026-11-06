const config = require("config");
const { promisify } = require("util");
const execAsync = promisify(require("child_process").exec);
const email = require("helper/email");
const clfdate = require("helper/clfdate");
const lock = require("helper/lock");

// Every process runs this check each minute and each container has its own
// ps, so the reaping is per process. The email is sent once per TTL however
// many processes find zombies.
const ZOMBIE_NOTIFIED_KEY = "notify:zombie-process";
const ZOMBIE_NOTIFY_TTL_MS = 60 * 60 * 1000;

async function notifyZombies() {
  try {
    if (await lock.once(ZOMBIE_NOTIFIED_KEY, ZOMBIE_NOTIFY_TTL_MS)) {
      email.ZOMBIE_PROCESS();
    }
  } catch (err) {
    console.error(
      clfdate(),
      "Zombies: error sending zombie process email",
      err
    );
  }
}

if (require.main === module) {
  main().then(() => process.exit());
}

async function main() {
  const prefix = () => clfdate() + " Zombies:";

  console.log(prefix(), "checking");

  // We determine zombies processes as commands invoked with node
  // on something within Blot's directory, e.g. node app whose
  // process parent ID is the OS (i.e. ppid = 1). This usually
  // happens when the process becomes detached, i.e. a zombie.
  // I want to investigate and remove the causes of these.
  const { stdout } = await execAsync(
    `ps -e -o ppid= -o pid= -o command= | grep "node ${config.blot_directory}" | awk '$1 == "1" { print $2 }'`
  );

  // A process started directly under the container's init (as the app
  // is in proxy/e2e) is a child of PID 1 too: never count ourselves.
  const zombie_pids = stdout
    .split("\n")
    .filter((i) => !!i && i.trim() !== String(process.pid));

  if (zombie_pids.length) {
    console.log(prefix(), `${zombie_pids.length} zombies found`);
    notifyZombies();
  } else {
    console.log(prefix(), `none found`);
  }

  for (const pid of zombie_pids) {
    console.log(prefix(), "killing pid =", pid);
    try {
      const { stdout } = await execAsync(`kill ${pid}`);
      console.log(prefix(), "killed pid =", pid, "stdout =", stdout);
    } catch (err) {
      console.log(prefix(), "error killing pid =", pid, err);
      throw err;
    }
  }
}

module.exports = main;
