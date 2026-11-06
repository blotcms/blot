describe("google drive database.blog", function () {
  const database = require("clients/google-drive/database");
  const client = require("models/client");
  const prefix = require("clients/google-drive/database/prefix");

  afterEach(async function () {
    const keys = await client.keys(`${prefix}*`);

    if (keys.length) {
      await client.del(keys);
    }
  });

  it("can store and retrieve account information", async function () {
    const blogID = "blog_" + Date.now().toString();
    await database.blog.store(blogID, { foo: "bar" });
    const account = await database.blog.get(blogID);
    expect(account).toEqual({ foo: "bar" });
    await database.blog.store(blogID, { baz: null, bat: 123 });
    const updatedAccount = await database.blog.get(blogID);
    expect(updatedAccount).toEqual({ foo: "bar", baz: null, bat: 123 });
  });

  it("can list all blog IDs", async function () {
    const blogID1 = "blog_" + Date.now().toString();
    const blogID2 = "blog_" + (Date.now() + 1).toString();

    await database.blog.store(blogID1, { foo: "bar" });
    await database.blog.store(blogID2, { baz: "bat" });

    const blogIDs = await database.blog.list();

    // Sort both arrays before comparing
    expect(blogIDs.sort()).toEqual([blogID1, blogID2].sort());
  });

  it("can delete a blog and clean up related data", async function () {
    const blogID = "blog_" + Date.now().toString();

    await database.blog.store(blogID, { foo: "bar" });
    const account = await database.blog.get(blogID);
    expect(account).toEqual({ foo: "bar" });

    await database.blog.delete(blogID);

    // Ensure the blog hash is deleted
    const deletedAccount = await database.blog.get(blogID);
    expect(deletedAccount).toBeNull();

    // Ensure the blog ID is removed from the global set
    const blogIDs = await database.blog.list();
    expect(blogIDs).not.toContain(blogID);
  });

  it("can iterate over all blogs and apply a callback", async function () {
    const blogID1 = "blog_" + Date.now().toString();
    const blogID2 = "blog_" + (Date.now() + 1).toString();

    await database.blog.store(blogID1, { foo: "bar" });
    await database.blog.store(blogID2, { baz: "bat" });

    const result = [];
    await database.blog.iterate((blogID, blogData) => {
      result.push({ blogID, blogData });
    });

    result.sort((a, b) => a.blogID.localeCompare(b.blogID));
    const expected = [
      { blogID: blogID1, blogData: { foo: "bar" } },
      { blogID: blogID2, blogData: { baz: "bat" } },
    ];
    expected.sort((a, b) => a.blogID.localeCompare(b.blogID));
    expect(result).toEqual(expected);
  });
  it("returns null for a non-existent blog", async function () {
    const nonExistentblogID = "blog_non_existent";

    const account = await database.blog.get(nonExistentblogID);
    expect(account).toBeNull();
  });

  it("can update blog fields without overwriting existing ones", async function () {
    const blogID = "blog_" + Date.now().toString();

    // Initial store
    await database.blog.store(blogID, { foo: "bar" });
    const initialAccount = await database.blog.get(blogID);
    expect(initialAccount).toEqual({ foo: "bar" });

    // Ensure no unexpected fields exist
    expect(initialAccount.baz).toBeUndefined();

    // Update with new field
    await database.blog.store(blogID, { baz: "bat" });
    const updatedAccount = await database.blog.get(blogID);
    expect(updatedAccount).toEqual({ foo: "bar", baz: "bat" });

    // Ensure no unexpected fields exist
    expect(updatedAccount.qux).toBeUndefined();

    // Update an existing field
    await database.blog.store(blogID, { foo: "updated" });
    const finalAccount = await database.blog.get(blogID);
    expect(finalAccount).toEqual({ foo: "updated", baz: "bat" });

    // Ensure no unexpected fields exist
    expect(finalAccount.qux).toBeUndefined();
  });

  it("can store and list multiple blogs independently", async function () {
    const blogID1 = "blog_" + Date.now().toString();
    const blogID2 = "blog_" + (Date.now() + 1).toString();

    await database.blog.store(blogID1, { foo: "bar" });
    await database.blog.store(blogID2, { baz: "bat" });

    const blogIDs = await database.blog.list();
    expect(blogIDs.sort()).toEqual([blogID1, blogID2].sort());

    const account1 = await database.blog.get(blogID1);
    const account2 = await database.blog.get(blogID2);

    expect(account1).toEqual({ foo: "bar" });
    expect(account2).toEqual({ baz: "bat" });
  });

  it("can delete a non-existent blog without errors", async function () {
    const nonExistentblogID = "blog_non_existent";

    // Attempt to delete a blog that doesn't exist
    await database.blog.delete(nonExistentblogID);

    // Ensure no blog ID exists in the global set
    const blogIDs = await database.blog.list();
    expect(blogIDs).not.toContain(nonExistentblogID);
  });

  it("does not overwrite fields when updating with an empty object", async function () {
    const blogID = "blog_" + Date.now().toString();
    await database.blog.store(blogID, { foo: "bar", baz: "bat" });

    // Update with an empty object
    await database.blog.store(blogID, {});

    // Ensure fields remain unchanged
    const account = await database.blog.get(blogID);
    expect(account).toEqual({ foo: "bar", baz: "bat" });
  });

  it("maintains global set integrity across multiple operations", async function () {
    const blogID1 = "blog_" + Date.now().toString();
    const blogID2 = "blog_" + (Date.now() + 1).toString();

    await database.blog.store(blogID1, { foo: "bar" });
    await database.blog.store(blogID2, { baz: "bat" });

    // Initial check
    let blogIDs = await database.blog.list();
    expect(blogIDs.sort()).toEqual([blogID1, blogID2].sort());

    // Delete one blog
    await database.blog.delete(blogID1);

    // Ensure the global set is updated
    blogIDs = await database.blog.list();
    expect(blogIDs).toEqual([blogID2]);

    // Add the blog back
    await database.blog.store(blogID1, { foo: "bar" });

    // Ensure both blog IDs are back
    blogIDs = await database.blog.list();
    expect(blogIDs.sort()).toEqual([blogID1, blogID2].sort());
  });

  it("throws an error when storing with invalid input", async function () {
    const blogID = "blog_" + Date.now().toString();

    // Attempt to store invalid inputs
    await expectAsync(database.blog.store(blogID, null)).toBeRejected();
    await expectAsync(database.blog.store(blogID, undefined)).toBeRejected();
    await expectAsync(database.blog.store(blogID, "")).toBeRejected();
  });

  it("returns an empty list if no blogs are stored", async function () {
    const blogIDs = await database.blog.list();
    expect(blogIDs).toEqual([]);
  });

  it("handles concurrent operations correctly", async function () {
    const blogID1 = "blog_" + Date.now().toString();
    const blogID2 = "blog_" + (Date.now() + 1).toString();

    // Perform concurrent store operations
    await Promise.all([
      database.blog.store(blogID1, { foo: "bar" }),
      database.blog.store(blogID2, { baz: "bat" }),
    ]);

    // Ensure both blogs are stored
    const blogIDs = await database.blog.list();
    expect(blogIDs.sort()).toEqual([blogID1, blogID2].sort());
  });

  it("can handle storing a blog with a large number of fields", async function () {
    const blogID = "blog_large_" + Date.now().toString();

    const largeData = {};
    for (let i = 0; i < 1000; i++) {
      largeData[`field_${i}`] = `value_${i}`;
    }

    await database.blog.store(blogID, largeData);

    const account = await database.blog.get(blogID);
    expect(Object.keys(account).length).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      expect(account[`field_${i}`]).toBe(`value_${i}`);
    }
  });

  it("should store a blog and add it to the correct serviceAccountId set", async function () {
    const blogID = "blog_" + Date.now().toString();
    const serviceAccountId = "account_1";

    await database.blog.store(blogID, { foo: "bar", serviceAccountId });

    // Collect blogs from the serviceAccountId set
    const serviceAccountBlogs = [];
    await database.blog.iterateByServiceAccountId(serviceAccountId, (id) => {
      serviceAccountBlogs.push(id);
    });

    expect(serviceAccountBlogs).toContain(blogID);
  });

  it("should iterate over blogs by serviceAccountId", async function () {
    const serviceAccountId = "account_1";

    const blogID1 = "blog_" + Date.now().toString();
    const blogID2 = "blog_" + (Date.now() + 1).toString();

    await database.blog.store(blogID1, { foo: "bar", serviceAccountId });
    await database.blog.store(blogID2, { baz: "bat", serviceAccountId });

    const result = [];
    await database.blog.iterateByServiceAccountId(
      serviceAccountId,
      (blogID, blogData) => {
        result.push({ blogID, blogData });
      }
    );

    expect(result.sort((a, b) => a.blogID.localeCompare(b.blogID))).toEqual(
      [
        { blogID: blogID1, blogData: { foo: "bar", serviceAccountId } },
        { blogID: blogID2, blogData: { baz: "bat", serviceAccountId } },
      ].sort((a, b) => a.blogID.localeCompare(b.blogID))
    );
  });

  it("should remove a blog from the old serviceAccountId set when the serviceAccountId changes", async function () {
    const blogID = "blog_" + Date.now().toString();
    const oldServiceAccountId = "account_1";
    const newServiceAccountId = "account_2";

    await database.blog.store(blogID, {
      foo: "bar",
      serviceAccountId: oldServiceAccountId,
    });

    // Change serviceAccountId
    await database.blog.store(blogID, {
      foo: "bar",
      serviceAccountId: newServiceAccountId,
    });

    // Check the old serviceAccountId set
    const oldSetBlogs = [];
    await database.blog.iterateByServiceAccountId(oldServiceAccountId, (id) => {
      oldSetBlogs.push(id);
    });
    expect(oldSetBlogs).not.toContain(blogID);

    // Check the new serviceAccountId set
    const newSetBlogs = [];
    await database.blog.iterateByServiceAccountId(newServiceAccountId, (id) => {
      newSetBlogs.push(id);
    });
    expect(newSetBlogs).toContain(blogID);
  });

  it("should remove a blog from the serviceAccountId set when the blog is deleted", async function () {
    const blogID = "blog_" + Date.now().toString();
    const serviceAccountId = "account_1";

    await database.blog.store(blogID, { foo: "bar", serviceAccountId });

    // Delete blog
    await database.blog.delete(blogID);

    // Collect blogs from the serviceAccountId set
    const serviceAccountBlogs = [];
    await database.blog.iterateByServiceAccountId(serviceAccountId, (id) => {
      serviceAccountBlogs.push(id);
    });

    expect(serviceAccountBlogs).not.toContain(blogID);
  });

  it("should handle storing a blog without a serviceAccountId", async function () {
    const blogID = "blog_" + Date.now().toString();

    await database.blog.store(blogID, { foo: "bar" });

    // Iterate over all serviceAccountIds to ensure the blog is not in any set
    const serviceAccountIds = ["account_1", "account_2", "account_3"]; // Replace or dynamically fetch known serviceAccountIds if needed
    for (const serviceAccountId of serviceAccountIds) {
      const serviceAccountBlogs = [];
      await database.blog.iterateByServiceAccountId(serviceAccountId, (id) => {
        serviceAccountBlogs.push(id);
      });
      expect(serviceAccountBlogs).not.toContain(blogID);
    }

    // Alternatively, verify the blog exists globally but without a serviceAccountId
    const allBlogs = [];
    await database.blog.iterate((id) => {
      allBlogs.push(id);
    });
    expect(allBlogs).toContain(blogID);
  });

  it("should update the serviceAccountId when adding a new field", async function () {
    const blogID = "blog_" + Date.now().toString();
    const oldServiceAccountId = "account_1";
    const newServiceAccountId = "account_2";

    await database.blog.store(blogID, {
      foo: "bar",
      serviceAccountId: oldServiceAccountId,
    });

    // Update with new field and change serviceAccountId
    await database.blog.store(blogID, {
      baz: "bat",
      serviceAccountId: newServiceAccountId,
    });

    // Check old set
    const oldSetBlogs = [];
    await database.blog.iterateByServiceAccountId(oldServiceAccountId, (id) => {
      oldSetBlogs.push(id);
    });
    expect(oldSetBlogs).not.toContain(blogID);

    // Check new set
    const newSetBlogs = [];
    await database.blog.iterateByServiceAccountId(newServiceAccountId, (id) => {
      newSetBlogs.push(id);
    });
    expect(newSetBlogs).toContain(blogID);

    // Ensure new data is stored
    const blogData = await database.blog.get(blogID);
    expect(blogData).toEqual({
      foo: "bar",
      baz: "bat",
      serviceAccountId: newServiceAccountId,
    });
  });

  it("should iterate over blogs correctly when no blogs are assigned to a serviceAccountId", async function () {
    const serviceAccountId = "non_existent_account";

    const result = [];
    await database.blog.iterateByServiceAccountId(
      serviceAccountId,
      (blogID, blogData) => {
        result.push({ blogID, blogData });
      }
    );

    expect(result).toEqual([]);
  });

  it("should allow storing a blog with a null serviceAccountId", async function () {
    const blogID = "blog_" + Date.now().toString();

    await database.blog.store(blogID, { foo: "bar", serviceAccountId: null });

    // Ensure no serviceAccountId set contains the blog
    const keys = await client.keys(`${prefix}serviceAccountId:*`);

    for (const key of keys) {
      const serviceAccountBlogs = await client.sMembers(key);
      expect(serviceAccountBlogs).not.toContain(blogID);
    }

    const blogData = await database.blog.get(blogID);
    expect(blogData).toEqual({ foo: "bar", serviceAccountId: null });
  });

  it("does not clobber the iterateByServiceId when updating the blog", async function () {
    const blogID = "blog_" + Date.now().toString();
    const serviceAccountId = "account_1";
    await database.blog.store(blogID, { foo: "bar", serviceAccountId });

    const blogIDs = [];

    await database.blog.iterateByServiceAccountId(serviceAccountId, (id) => {
      blogIDs.push(id);
    });

    expect(blogIDs).toContain(blogID);

    await database.blog.store(blogID, { baz: "bat" });

    const updatedBlogIDs = [];

    await database.blog.iterateByServiceAccountId(serviceAccountId, (id) => {
      updatedBlogIDs.push(id);
    });

    expect(updatedBlogIDs).toContain(blogID);
  });

  it("propagates client promise failures", async function () {
    const error = new Error("boom");
    spyOn(client, "hSet").and.callFake(() => Promise.reject(error));

    await expectAsync(
      database.blog.store("blog_failure", { foo: "bar" })
    ).toBeRejectedWith(error);
    expect(client.hSet).toHaveBeenCalled();
  });
});
