var database = {};
var client = require("models/client");
var debug = require("debug")("blot:clients:git:database");

// I picked v4 from 5 possible versions
// because it said random next to its name?
var { v4: uuid } = require("uuid");

function tokenKey(user_id) {
  return "user:" + user_id + ":git:token";
}

function statusKey(user_id) {
  return "user:" + user_id + ":git:status";
}

// The commit whose changes Blot has applied to the blog's entries: the next
// sync diffs from it. Under blog:<id>: so deleting the blog removes it, and
// disconnecting removes it too.
function appliedKey(blogID) {
  return "blog:" + blogID + ":git:applied";
}

// Set while a repository is being set up for the blog (create.js), so the
// dashboard shows the setup's progress rather than the create page before the
// store has the repository. It expires by itself, so a setup cut off by a
// crash or a deploy never leaves the blog stuck "in progress".
function creatingKey(blogID) {
  return "blog:" + blogID + ":git:creating";
}

var CREATING_TTL_SECONDS = 60 * 60;

function generateToken() {
  return uuid().replace(/-/g, "");
}

async function createToken(user_id) {
  var new_token = generateToken();

  debug("User:", user_id, "Creating token if none exists");

  var created = await client.setNX(tokenKey(user_id), new_token);

  // Preserve legacy setnx callback semantics (1: created, 0: existed)
  if (typeof created === "boolean") created = created ? 1 : 0;

  return created;
}

async function refreshToken(user_id) {
  var new_token = generateToken();

  debug("User:", user_id, "Refreshing token");

  await client.set(tokenKey(user_id), new_token);

  debug("User:", user_id, "Set token successfully");

  return new_token;
}

async function checkToken(user_id, token) {
  debug("User:", user_id, "Checking token");

  var valid_token = await getToken(user_id);

  return token === valid_token;
}

async function flush(user_id) {
  debug("User:", user_id, "Getting token");

  await client.del(tokenKey(user_id));

  debug("User:", user_id, "Flushed token");
}

async function getToken(user_id) {
  debug("User:", user_id, "Getting token");

  return await client.get(tokenKey(user_id));
}

async function setStatus(blogID, status) {
  return await client.set(statusKey(blogID), status);
}

async function getStatus(blogID) {
  return await client.get(statusKey(blogID));
}

async function removeStatus(blogID) {
  return await client.del(statusKey(blogID));
}

async function setCreating(blogID) {
  await client.set(creatingKey(blogID), String(Date.now()), {
    EX: CREATING_TTL_SECONDS,
  });
}

async function isCreating(blogID) {
  return !!(await client.get(creatingKey(blogID)));
}

async function clearCreating(blogID) {
  await client.del(creatingKey(blogID));
}

async function getApplied(blogID) {
  return (await client.get(appliedKey(blogID))) || null;
}

async function setApplied(blogID, commit) {
  await client.set(appliedKey(blogID), commit);
}

// Sets the commit only if there is none yet. Resolves to true if it did.
async function setAppliedIfMissing(blogID, commit) {
  var created = await client.setNX(appliedKey(blogID), commit);
  return !!created;
}

// Moves the commit from one value to the next, unless something else has
// moved it since. Blot's own commit does this while a sync may be applying a
// push, and a plain read then write could set it back over the sync's newer
// value, so this is the one compare-then-set that is a script. Resolves to
// true if it moved.
async function advanceApplied(blogID, from, to) {
  var moved = await client.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0",
    { keys: [appliedKey(blogID)], arguments: [from, to] }
  );
  return moved === 1;
}

async function removeApplied(blogID) {
  await client.del(appliedKey(blogID));
}

database.createToken = createToken;
database.checkToken = checkToken;
database.getToken = getToken;

database.flush = flush;
database.refreshToken = refreshToken;

database.setStatus = setStatus;
database.getStatus = getStatus;
database.removeStatus = removeStatus;
database.setCreating = setCreating;
database.isCreating = isCreating;
database.clearCreating = clearCreating;
database.creatingKey = creatingKey;
database.CREATING_TTL_SECONDS = CREATING_TTL_SECONDS;

database.getApplied = getApplied;
database.setApplied = setApplied;
database.setAppliedIfMissing = setAppliedIfMissing;
database.advanceApplied = advanceApplied;
database.removeApplied = removeApplied;

module.exports = database;
