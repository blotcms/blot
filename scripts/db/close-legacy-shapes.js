// Brings stored records up to the shapes the app now assumes, so the code
// that tolerated the old ones could go:
//
// - users without created, welcomeEmailSent or paymentMethods are saved
//   through User.set with the defaults the readers used to apply
// - template metadata loses the retired isPublic field
// - views lose the type field viewModel dropped in 2019; the Content-Type
//   now always comes from the view's name
// - customer views using the camelCase pagination aliases pageSize and
//   totalEntries, in their content or stored partials, are rewritten to
//   page_size and total_entries
// - the unread blog:*:entries:lex:ready keys are deleted
//
// Each step is idempotent. Dry run by default; pass --apply to write.
// Usage: node scripts/db/close-legacy-shapes.js [--apply]

const { promisify } = require("util");
const client = require("models/client");
const User = require("models/user");
const Template = require("models/template");
const writeToFolder = require("models/template/writeToFolder");
const redisKeys = require("../util/redisKeys");

const APPLY = process.argv.includes("--apply");
const setUser = promisify(User.set);
const setView = promisify(Template.setView);
const writeToFolderAsync = promisify(writeToFolder);

// Only pagination's own fields: {{pagination.pageSize}}, or a bare
// {{pageSize}} inside a {{#pagination}} section. A custom local with the
// same name, like {{custom.pageSize}}, is left alone.
const QUALIFIED = /(\{\{\{?[#^/&\s]*pagination\.)(pageSize|totalEntries)\b/g;
const SECTION = /(\{\{#\s*pagination\s*\}\})([\s\S]*?)(\{\{\/\s*pagination\s*\}\})/g;
const BARE = /(\{\{\{?[#^/&\s]*)(pageSize|totalEntries)\b/g;
const SNAKE = { pageSize: "page_size", totalEntries: "total_entries" };

function snakeCase(text) {
  const rename = (match, prefix, alias) => prefix + SNAKE[alias];
  return text
    .replace(QUALIFIED, rename)
    .replace(SECTION, (match, open, body, close) => open + body.replace(BARE, rename) + close);
}

const counts = {};
function count(name) {
  counts[name] = (counts[name] || 0) + 1;
}

async function users() {
  await redisKeys("user:*:info", async (key) => {
    if (key.split(":").length !== 3) return;
    const user = JSON.parse((await client.get(key)) || "null");
    if (!user) return;
    if (
      user.created !== undefined &&
      user.welcomeEmailSent !== undefined &&
      user.paymentMethods !== undefined
    )
      return;
    count("users missing defaults");
    if (!APPLY) return;
    const defaults = {};
    if (user.created === undefined) defaults.created = 0;
    if (user.welcomeEmailSent === undefined) defaults.welcomeEmailSent = true;
    if (user.paymentMethods === undefined) defaults.paymentMethods = [];
    try {
      await setUser(key.split(":")[1], defaults);
    } catch (err) {
      count("users failed");
      console.log("Failed to save user", key, err.message);
    }
  });
}

async function templates() {
  const owners = new Map();

  await redisKeys("template:*:info", async (key) => {
    const id = key.slice("template:".length, -":info".length);
    const [owner, localEditing, isPublic] = await client.hmGet(key, [
      "owner",
      "localEditing",
      "isPublic",
    ]);
    owners.set(id, { owner, localEditing: localEditing === "true" });
    if (isPublic === null || isPublic === undefined) return;
    count("templates with isPublic");
    if (APPLY) await client.hDel(key, "isPublic");
  });

  const rewritten = new Map();

  await redisKeys("template:*:view:*", async (key) => {
    const rest = key.slice("template:".length);
    const i = rest.indexOf(":view:");
    const id = rest.slice(0, i);
    const name = rest.slice(i + ":view:".length);
    const template = owners.get(id);
    if (!template) return;

    const [type, content, partialsJSON] = await client.hmGet(key, [
      "type",
      "content",
      "partials",
    ]);

    if (type !== null && type !== undefined) {
      count("views with type");
      if (APPLY) await client.hDel(key, "type");
    }

    if (template.owner === "SITE" || typeof content !== "string") return;

    const updates = { name };
    const updated = snakeCase(content);
    if (updated !== content) updates.content = updated;

    let partials = {};
    try {
      partials = JSON.parse(partialsJSON || "{}") || {};
    } catch (err) {}
    let partialsChanged = false;
    for (const partial in partials) {
      if (typeof partials[partial] !== "string") continue;
      const value = snakeCase(partials[partial]);
      if (value === partials[partial]) continue;
      partials[partial] = value;
      partialsChanged = true;
    }
    if (!updates.content && !partialsChanged) return;
    // setView drops file-backed partial markers that aren't in the content
    // or in updates.partials, so always pass the whole map back
    updates.partials = partials;

    count("views using pagination aliases");
    console.log("pagination aliases:", id, name);
    if (!APPLY) return;
    await setView(id, updates);
    rewritten.set(id, template);
  });

  for (const [id, template] of rewritten) {
    if (!template.localEditing) continue;
    count("templates written to folder");
    try {
      await writeToFolderAsync(template.owner, id);
    } catch (err) {
      // Redis is already migrated, so a re-run won't find this template:
      // retry it by hand with writeToFolder(owner, id)
      process.exitCode = 1;
      console.log("Failed to write template to folder", template.owner, id, err.message);
    }
  }
}

async function lexReadyKeys() {
  await redisKeys("blog:*:entries:lex:ready", async (key) => {
    count("entries:lex:ready keys");
    if (APPLY) await client.del(key);
  });
}

async function main() {
  await users();
  await templates();
  await lexReadyKeys();

  console.log(APPLY ? "Applied:" : "Dry run, nothing written:");
  for (const [name, n] of Object.entries(counts)) console.log(" ", name, n);
  if (!Object.keys(counts).length) console.log("  nothing to do");
}

main()
  .then(() => process.exit())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
