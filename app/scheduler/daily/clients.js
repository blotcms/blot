const { promisify } = require("util");
const User = require("models/user");
const extend = require("models/user/extend");
const Blog = require("models/blog");

const getAllUserIds = promisify(User.getAllIds);
const getUserById = promisify(User.getById);
const getBlog = promisify(Blog.get);

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
      percentage: (siteClients.length ? (sites / siteClients.length) * 100 : 0)
        .toFixed(1) + "%"
    };
  });

  rows.sort(function (a, b) {
    return b.sites - a.sites;
  });

  return rows;
}

async function main(callback) {
  try {
    const userIds = await getAllUserIds();
    const siteClients = [];

    for (const userId of userIds) {
      try {
        let user = await getUserById(userId);

        if (!user) continue;

        user = extend(user);

        if (user.isDisabled) continue;

        if (!user.isSubscribed) continue;

        if (Array.isArray(user.blogs)) {
          for (const blogId of user.blogs) {
            try {
              const blog = await getBlog({ id: blogId });

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

    const rows = buildRows(siteClients);
    const syncSummary = rows
      .map(function (row) {
        return `${row.client}: ${row.sites} sites (${row.percentage})`;
      })
      .join(", ");

    callback(null, {
      sync_summary: syncSummary || "no sites"
    });
  } catch (err) {
    callback(err);
  }
}

module.exports = main;
module.exports.buildRows = buildRows;

if (require.main === module) require("./cli")(main);
