// The macserver's /stats reports its CPU as a percentage of one core, since
// the previous call and since the process started.
const path = require("path");
const { pathToFileURL } = require("url");

describe("icloud macserver processStats", function () {
  let createProcessStats;

  beforeAll(async function () {
    ({ createProcessStats } = await import(
      pathToFileURL(path.join(__dirname, "../macserver/util/processStats.js"))
        .href
    ));
  });

  const host = {
    cpus: () => [{}, {}, {}, {}],
    loadavg: () => [4.8, 4, 3.5],
    freemem: () => 4e9,
    totalmem: () => 8e9,
  };

  it("gives the CPU since the last call and since the start", function () {
    let cpuMicros = 0;
    let time = 1000000;
    let uptime = 100;

    const sample = createProcessStats({
      cpuUsage: () => ({ user: cpuMicros, system: 0 }),
      memoryUsage: () => ({ rss: 300e6 }),
      uptime: () => uptime,
      now: () => time,
      host,
    });

    // 150 seconds of CPU in 100 seconds: 150% since the start
    cpuMicros = 150e6;
    const first = sample();
    expect(first.cpu_percent).toBe(150);
    expect(first.cpu_percent_average).toBe(150);

    // then two cores flat out for a minute
    cpuMicros += 120e6;
    time += 60000;
    uptime += 60;
    const second = sample();
    expect(second.cpu_percent).toBe(200);
    expect(second.cpu_percent_average).toBe(169);

    expect(second).toEqual(
      jasmine.objectContaining({
        cpu_count: 4,
        load_average: 4.8,
        memory_rss_bytes: 300e6,
        host_memory_free_bytes: 4e9,
        host_memory_total_bytes: 8e9,
        uptime_seconds: 160,
      })
    );
  });
});
