describe("daily update data disk", function () {
  const dataDisk = require("../data-disk");
  const { dataDiskAlert } = require("../../free-disk-space");

  const GB = 1024 * 1024;

  function disks(usedGB, availableGB) {
    return [
      { label: "instance", used_k: GB, available_k: 100 * GB, available_human: "100 GB", used_percent: 1 },
      {
        label: "data",
        used_k: usedGB * GB,
        available_k: availableGB * GB,
        available_human: availableGB + " GB",
        used_percent: Math.ceil((usedGB * 100) / (usedGB + availableGB))
      }
    ];
  }

  it("says how full the data disk is", function () {
    const line = dataDisk.line(disks(280, 50));

    expect(line).toBe("Data disk: 85% (50 GB free)");
    expect(line).not.toContain("**");
  });

  it("is bold once the first alert level is reached", function () {
    expect(dataDisk.line(disks(300, 30))).toMatch(/^\*\*Data disk: 91% \(grow now, 30 GB free\)\*\*$/);
  });

  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 22, 7, 0);
  const point = (days, usedGB) => ({ time: NOW - days * DAY, used: usedGB * GB * 1024 });

  it("says where the data disk is heading from the last week", function () {
    // 90% of 330 GB is 297 GB: 17 GB to go at 1 GB a day
    const growing = [point(7, 273), point(1, 279)];
    expect(dataDisk.line(disks(280, 50), { history: growing, now: NOW })).toBe(
      "Data disk: 85% (grow in ~17 days, 50 GB free)"
    );

    expect(dataDisk.line(disks(280, 50), { history: [point(7, 280)], now: NOW })).toBe(
      "Data disk: 85% (stable, 50 GB free)"
    );
    expect(dataDisk.line(disks(280, 50), { history: [point(7, 290)], now: NOW })).toBe(
      "Data disk: 85% (stable, 50 GB free)"
    );
  });

  it("stores each day's reading and uses it the next day", function (done) {
    const store = new Map();
    const client = {
      sendCommand: async ([command, key, value]) =>
        command === "GET" ? store.get(key) || null : store.set(key, value) && "OK"
    };
    const run = now =>
      new Promise(resolve =>
        dataDisk((err, result) => resolve(result.data_disk), {
          client,
          now,
          freeDiskSpace: callback => callback(null, disks(280, 50))
        })
      );

    run(NOW - DAY)
      .then(first => {
        expect(first).toBe("Data disk: 85% (50 GB free)");
        expect(JSON.parse(store.get(dataDisk.HISTORY_KEY))).toEqual([{ time: NOW - DAY, used: 280 * GB * 1024 }]);
        return run(NOW);
      })
      .then(second => {
        expect(second).toBe("Data disk: 85% (stable, 50 GB free)");
        done();
      });
  });

  it("still gives the line when Redis cannot be read", function (done) {
    const client = {
      sendCommand: async () => {
        throw new Error("connection refused");
      }
    };

    dataDisk(
      (err, result) => {
        expect(result.data_disk).toBe("Data disk: 85% (50 GB free)");
        done();
      },
      { client, now: NOW, freeDiskSpace: callback => callback(null, disks(280, 50)) }
    );
  });

  it("says to grow now whenever the alert level is reached, by the rounded percentage", function () {
    // 89.1% is shown as 90%
    const line = dataDisk.line(disks(294, 36), { history: [], now: NOW });
    expect(line).toBe("**Data disk: 90% (grow now, 36 GB free)**");
  });

  it("picks the highest alert level reached", function () {
    expect(dataDiskAlert(disks(280, 50))).toBe(null);
    expect(dataDiskAlert(disks(297, 33)).percent).toBe(90);
    expect(dataDiskAlert(disks(314, 16)).percent).toBe(95);
    expect(dataDiskAlert(disks(327, 3)).percent).toBe(99);
    expect(dataDiskAlert(disks(327, 3)).headline).toMatch(/^URGENT/);
  });

  it("reports a failed check instead of failing the email", function (done) {
    dataDisk(
      function (err, result) {
        expect(err).toBe(null);
        expect(result.data_disk).toBe("Data disk: unavailable (df failed)");
        done();
      },
      { freeDiskSpace: (callback) => callback(new Error("df failed")) }
    );
  });
});
