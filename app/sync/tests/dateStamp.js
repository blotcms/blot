describe("dateStamp", function () {
  // Set up a test blog before each test
  global.test.blog();

  it("resets a post's date to its created date when Date metadata is removed", async function (done) {
    const path = "/dated-post.txt";
    const metadataDate = 1577836800000; // 2020-01-01T00:00:00Z

    // Publish the post with an explicit Date in its metadata
    await this.blog.write({ path, content: "Date: 2020-01-01\n\nHello" });
    await this.blog.rebuild();

    const withDate = await this.blog.check({ path });
    expect(withDate.dateStamp).toEqual(metadataDate);

    // Remove the Date metadata and rebuild the same file
    await this.blog.write({ path, content: "Hello" });
    await this.blog.rebuild();

    const withoutDate = await this.blog.check({ path });

    // The stale date from the removed metadata must not linger
    expect(withoutDate.dateStamp).not.toEqual(metadataDate);

    // With no date in the metadata or the path, the post falls back
    // to the date it was first created on
    expect(withoutDate.dateStamp).toEqual(withoutDate.created);

    done();
  });

  it("recovers the Date metadata timestamp when it is added back", async function (done) {
    const path = "/toggled-date-post.txt";
    const metadataDate = 1577836800000; // 2020-01-01T00:00:00Z

    await this.blog.write({ path, content: "Hello" });
    await this.blog.rebuild();

    const withoutDate = await this.blog.check({ path });
    expect(withoutDate.dateStamp).toEqual(withoutDate.created);

    await this.blog.write({ path, content: "Date: 2020-01-01\n\nHello" });
    await this.blog.rebuild();

    const withDate = await this.blog.check({ path });
    expect(withDate.dateStamp).toEqual(metadataDate);

    done();
  });
});
