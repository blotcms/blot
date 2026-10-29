import { spawn, execFile } from "child_process";
import clfdate from "./util/clfdate.js";

const SLOW_COMMAND_MS = 2000;

// After a timeout we SIGTERM the child, but one blocked in the kernel or the
// file provider (state U) can outlive it. Log whether it is still there.
const logSurvivor = (command, pid) => {
  setTimeout(() => {
    execFile("ps", ["-o", "pid=,stat=,etime=", "-p", String(pid)], (err, out) => {
      const line = (out || "").trim();
      console.error(
        clfdate(),
        `Timed out "${command}" pid=${pid}:`,
        line ? `still running after kill (pid stat etime: ${line})` : "exited after kill"
      );
    });
  }, 1000);
};

// A promisified spawn function to execute commands with async/await.
// Designed to be slightly safer than using exec because I'm worried
// about shell injection attacks.
const exec = (command, args = [], options = {}) => {
  return new Promise((resolve, reject) => {
    const { timeout = 30000, ...spawnOptions } = options;
    const startedAt = Date.now();
    const child = spawn(command, args, spawnOptions);

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timerId;

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
    }

    const settle = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timerId) {
        clearTimeout(timerId);
      }
      handler();
    };

    timerId = setTimeout(() => {
      child.kill();
      logSurvivor(command, child.pid);
      settle(() =>
        reject(new Error(`Command timed out after ${timeout}ms`))
      );
    }, timeout);

    child.on("error", (error) => {
      settle(() => reject(error)); // If spawn fails, reject the promise
    });

    child.on("close", (code) => {
      const elapsed = Date.now() - startedAt;
      if (elapsed > SLOW_COMMAND_MS) {
        console.log(clfdate(), `Slow command (${elapsed}ms, exit ${code}): ${command}`);
      }
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(
              `Command failed with exit code ${code}\nStderr: ${stderr.trim()}`
            )
          );
        }
      });
    });
  });
};

export default exec;
