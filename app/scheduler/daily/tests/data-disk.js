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

    expect(line).toMatch(/^Data disk: 85% used, 50 GB free of 330 GB$/);
    expect(line).not.toContain("**");
  });

  it("is bold once the first alert level is reached", function () {
    expect(dataDisk.line(disks(300, 30))).toMatch(/^\*\*Data disk: 91% used/);
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
