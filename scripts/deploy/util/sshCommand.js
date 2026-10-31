const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

// The host is BLOT_DEPLOY_TARGET, an ssh alias or user@host (see ../units.sh).
module.exports = async function sshCommand(command) {
  const target = process.env.BLOT_DEPLOY_TARGET || "blot";
  // It goes into a shell string, and a leading - would be an ssh option.
  if (!/^[A-Za-z0-9._@-]+$/.test(target) || target.startsWith("-")) {
    throw new Error(
      `Invalid BLOT_DEPLOY_TARGET '${target}': use an ssh alias or user@host`
    );
  }
  const timeoutMs = 60 * 1000;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const { stdout } = await execAsync(`ssh ${target} "${command}"`, {
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return stdout.trim();
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(
        `SSH command timed out after ${timeoutMs / 1000} seconds: ${command}`
      );
    }
    throw new Error(`SSH command failed: ${command}\n${error.message}`);
  }
};
