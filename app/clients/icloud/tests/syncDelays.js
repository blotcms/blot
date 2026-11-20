describe("icloud syncDelays", function () {
  const syncDelays = require("../util/syncDelays");
  const MINUTE = 60 * 1000;
  const lag = (...seconds) => seconds.map((s) => ({ at: 0, lagMs: s * 1000 }));

  it("finds nothing when the macserver and recent pushes keep up", function () {
    const stats = {
      actions_pending: 2,
      actions_oldest_ms: 20 * 1000,
      journal_running: true,
      journal_poll_age_ms: 1500,
      journal_behind: 0,
      fileprovider_gave_up_15m: 0,
    };
    expect(syncDelays(stats, lag(6, 8, 30, 9, 7))).toEqual([]);
  });

  it("reports a change waiting over five minutes on the macserver", function () {
    const reasons = syncDelays(
      {
        actions_pending: 40,
        actions_oldest_ms: 6 * MINUTE,
        actions_busiest_blog: "blog_a",
        actions_busiest_pending: 38,
      },
      []
    );
    expect(reasons.length).toBe(1);
    expect(reasons[0]).toContain("blog_a");
  });

  it("reports a journal that stopped reading bird's database", function () {
    expect(
      syncDelays({ journal_running: true, journal_poll_age_ms: 3 * MINUTE }, [])
        .length
    ).toBe(1);
    // not following the journal (no database) is not a delay
    expect(
      syncDelays({ journal_running: false, journal_poll_age_ms: null }, [])
    ).toEqual([]);
  });

  it("reports files FileProvider never put on disk", function () {
    expect(syncDelays({ fileprovider_gave_up_15m: 3 }, []).length).toBe(1);
    expect(syncDelays({ fileprovider_gave_up_15m: 2 }, [])).toEqual([]);
  });

  it("reports a slow median lag from enough pushes, ignoring old files copied in", function () {
    expect(syncDelays({}, lag(150, 160, 170, 180, 190)).length).toBe(1);
    // an even count takes the mean of the middle two: (1 + 180) / 2 < 120
    expect(syncDelays({}, lag(1, 1, 1, 180, 180, 180))).toEqual([]);
    // too few pushes to judge
    expect(syncDelays({}, lag(150, 160, 170, 180))).toEqual([]);
    // hours-old mtimes are copies of old files, not live edits
    expect(syncDelays({}, lag(5, 6, 7, 7200, 9000, 9500, 9999))).toEqual([]);
  });

  it("reports nothing delivered from iCloud for over twelve hours", function () {
    const HOUR = 60 * MINUTE;
    expect(
      syncDelays({ icloud_last_delivery_age_ms: 13 * HOUR }, []).length
    ).toBe(1);
    expect(syncDelays({ icloud_last_delivery_age_ms: 7 * HOUR }, [])).toEqual(
      []
    );
    // unknown (no database) is not a delay
    expect(syncDelays({ icloud_last_delivery_age_ms: null }, [])).toEqual([]);
  });

  it("copes with no stats", function () {
    expect(syncDelays(null, [])).toEqual([]);
  });
});
