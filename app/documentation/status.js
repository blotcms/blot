// The status line in the brochure's footer. It reads the updown.io checks
// behind status.blot.im on the server, at most once every few minutes, so
// visitors' browsers never call a third party. Without a key (config.updown)
// there is nothing to show and the footer just links to /status.
const config = require("config");
const clfdate = require("helper/clfdate");

const ENDPOINT = "https://updown.io/api/checks";
const MAX_AGE = 5 * 60 * 1000;
const TIMEOUT = 5 * 1000;

let current = null;
let checkedAt = 0;
let checking = null;

const summarise = (checks) => {
  const enabled = checks.filter((check) => check.enabled !== false);
  if (!enabled.length) return null;
  const down = enabled.filter((check) => check.down).length;
  if (!down) return { state: "up", label: "All systems operational" };
  if (down < enabled.length)
    return { state: "partial", label: "Some systems are down" };
  return { state: "down", label: "Blot is down" };
};

async function check() {
  try {
    const response = await fetch(ENDPOINT, {
      headers: { "X-API-KEY": config.updown.key },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!response.ok) throw new Error("updown.io responded " + response.status);
    current = summarise(await response.json());
  } catch (err) {
    console.log(clfdate(), "Footer status:", err.message);
    current = null;
  } finally {
    checkedAt = Date.now();
    checking = null;
  }
}

module.exports = function status(req, res, next) {
  if (!config.updown.key) return next();

  // Answer with what we know and refresh in the background, so a slow
  // updown.io never holds up a page
  if (!checking && Date.now() - checkedAt > MAX_AGE) checking = check();
  res.locals.serviceStatus = current;
  next();
};
