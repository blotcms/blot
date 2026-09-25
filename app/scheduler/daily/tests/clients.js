const { buildRows } = require("../clients");

describe("scheduler/daily/clients buildRows", function () {
  it("counts each client once per user and sorts most-used first", function () {
    // user A: dropbox only
    // user B: dropbox + git (counts once toward each)
    // user C: no client set
    const usersClients = [
      new Set(["dropbox"]),
      new Set(["dropbox", "git"]),
      new Set(["No client"]),
    ];

    const rows = buildRows(usersClients, usersClients.length);

    expect(rows).toEqual([
      { client: "dropbox", users: 2, percentage: "66.7%" },
      { client: "git", users: 1, percentage: "33.3%" },
      { client: "No client", users: 1, percentage: "33.3%" },
    ]);

    // A multi-client user is counted toward more than one row, so the
    // percentages can add up to more than 100%.
    const total = rows.reduce(function (sum, row) {
      return sum + parseFloat(row.percentage);
    }, 0);
    expect(total).toBeGreaterThan(100);
  });

  it("buckets blogs with no client under the No client label", function () {
    const rows = buildRows([new Set(["No client"]), new Set(["No client"])], 2);

    expect(rows).toEqual([{ client: "No client", users: 2, percentage: "100.0%" }]);
  });

  it("sorts rows by user count, most users first", function () {
    const usersClients = [
      new Set(["git"]),
      new Set(["dropbox"]),
      new Set(["dropbox"]),
      new Set(["dropbox"]),
      new Set(["google-drive"]),
      new Set(["google-drive"]),
    ];

    const rows = buildRows(usersClients, usersClients.length);

    expect(rows.map((row) => row.client)).toEqual([
      "dropbox",
      "google-drive",
      "git",
    ]);
  });

  it("returns an empty array when there are no current users", function () {
    expect(buildRows([], 0)).toEqual([]);
  });
});
