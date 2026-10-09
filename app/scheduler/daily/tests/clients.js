const { buildRows } = require("../clients");

describe("scheduler/daily/clients buildRows", function () {
  it("counts sites per client and sorts most-used first", function () {
    const siteClients = ["dropbox", "dropbox", "git", "no client"];
    const rows = buildRows(siteClients);

    expect(rows).toEqual([
      { client: "dropbox", sites: 2, percentage: "50.0%" },
      { client: "git", sites: 1, percentage: "25.0%" },
      { client: "no client", sites: 1, percentage: "25.0%" },
    ]);

    const total = rows.reduce(function (sum, row) {
      return sum + parseFloat(row.percentage);
    }, 0);
    expect(total).toBe(100);
  });

  it("buckets blogs with no client under the no client label", function () {
    const rows = buildRows(["no client", "no client"]);

    expect(rows).toEqual([{ client: "no client", sites: 2, percentage: "100.0%" }]);
  });

  it("sorts rows by site count, most sites first", function () {
    const siteClients = ["git", "dropbox", "dropbox", "dropbox", "google-drive", "google-drive"];
    const rows = buildRows(siteClients);

    expect(rows.map((row) => row.client)).toEqual([
      "dropbox",
      "google-drive",
      "git",
    ]);
  });

  it("returns an empty array when there are no sites", function () {
    expect(buildRows([])).toEqual([]);
  });
});
