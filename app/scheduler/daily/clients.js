const User = require("models/user");
const extend = require("models/user/extend");
const Blog = require("models/blog");

const NO_CLIENT_LABEL = "no client";

// Turns one client name per active subscribed site into a sorted list of
// client/site counts. Percentages use those sites as the denominator.
function buildRows(siteClients) {
  const counts = {};

  siteClients.forEach(function (client) {
    counts[client] = (counts[client] || 0) + 1;
  });

  const rows = Object.keys(counts).map(function (client) {
    const sites = counts[client];

    return {
      client,
      sites,
      percentage:
        Math.round(
          siteClients.length ? (sites / siteClients.length) * 100 : 0
        ) + "%",
    };
  });

  rows.sort(function (a, b) {
    return b.sites - a.sites;
  });

  return rows;
}

async function main() {
  const userIds = await User.getAllIds();
  const siteClients = [];

  for (const userId of userIds) {
    try {
      let user = await User.getById(userId);

      if (!user) continue;

      user = extend(user);

      if (user.isDisabled) continue;

      if (!user.isSubscribed) continue;

      if (Array.isArray(user.blogs)) {
        for (const blogId of user.blogs) {
          try {
            const blog = await Blog.get({ id: blogId });

            if (!blog || blog.isDisabled) continue;

            siteClients.push(blog.client || NO_CLIENT_LABEL);
          } catch (err) {
            continue;
          }
        }
      }
    } catch (err) {
      continue;
    }
  }

  // Clients without config here (or a stale name) keep the stored name
  const clients = require("clients");
  const rows = buildRows(siteClients);
  const syncSummary = rows
    .map(function (row) {
      const client = clients[row.client];
      const name = (client && client.display_name) || row.client;
      return `${row.percentage} ${name} (${row.sites} sites)`;
    })
    .join(", ");

  return {
    sync_summary: syncSummary || "no sites",
  };
}

module.exports = main;
module.exports.buildRows = buildRows;

if (require.main === module) require("./cli")(main);
