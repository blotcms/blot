// Brings stored records up to the shapes the app now assumes, so the code
// that tolerated the old ones could go:
//
// - users without created, welcomeEmailSent or paymentMethods are saved
//   through User.set, which fills the defaults the readers used to apply
// - template metadata loses the retired isPublic field
// - views lose the type field viewModel dropped in 2019; the Content-Type
//   now always comes from the view's name
// - customer views using the camelCase pagination aliases pageSize and
//   totalEntries are rewritten to page_size and total_entries
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

const PAGINATION_ALIAS = /(\{\{\{?[#^/&\s]*(?:[\w.]*\.)?)(pageSize|totalEntries)\b/g;
const SNAKE = { pageSize: "page_size", totalEntries: "total_entries" };

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
    try {
      await setUser(key.split(":")[1], {});
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

    const [type, content] = await client.hmGet(key, ["type", "content"]);

    if (type !== null && type !== undefined) {
      count("views with type");
      if (APPLY) await client.hDel(key, "type");
    }

    if (template.owner === "SITE" || typeof content !== "string") return;

    const updated = content.replace(
      PAGINATION_ALIAS,
      (match, prefix, alias) => prefix + SNAKE[alias]
    );
    if (updated === content) return;

    count("views using pagination aliases");
    console.log("pagination aliases:", id, name);
    if (!APPLY) return;
    await setView(id, { name, content: updated });
    rewritten.set(id, template);
  });

  for (const [id, template] of rewritten) {
    if (!template.localEditing) continue;
    count("templates written to folder");
    try {
      await writeToFolderAsync(template.owner, id);
    } catch (err) {
      console.log("Failed to write template to folder", id, err.message);
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
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
