describe("folder module", function () {
  const folderModule = require("clients/google-drive/database/folder");
  const client = require("models/client");
  const prefix = require("clients/google-drive/database/prefix");

  let folder;

  beforeEach(function () {
    const folderId = "test_folder";
    folder = folderModule(folderId); // Create a new folder instance for each test
  });

  // Clear Redis data after each test
  afterEach(async function () {
    const keys = await client.keys(`${prefix}*`);
    if (keys.length) {
      await client.del(keys);
    }
  });

  it("can set and get a mapping (ID → Path)", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";

    await folder.set(id, path);
    const retrievedPath = await folder.get(id);
    expect(retrievedPath).toBe(path);
  });

  it("can set and get a mapping (Path → ID)", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";

    await folder.set(id, path);
    const retrievedId = await folder.getByPath(path);
    expect(retrievedId).toBe(id);
  });

  it("can move a file to a new path", async function () {
    const id = "file_1";
    const oldPath = "/folder/old/file1.txt";
    const newPath = "/folder/new/file1.txt";

    await folder.set(id, oldPath);
    const movedPaths = await folder.move(id, newPath);

    // Ensure the correct move is recorded
    expect(movedPaths).toEqual([{ from: oldPath, to: newPath }]);

    // Ensure the file's path is updated
    const updatedPath = await folder.get(id);
    expect(updatedPath).toBe(newPath);
  });

  it("can move a folder and all its children", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const oldFolderPath = "/folder/old";
    const newFolderPath = "/folder/new";

    await folder.set(folderId, oldFolderPath);
    await folder.set(fileId1, `${oldFolderPath}/file1.txt`);
    await folder.set(fileId2, `${oldFolderPath}/file2.txt`);

    const movedPaths = await folder.move(folderId, newFolderPath);

    expect(movedPaths).toEqual([
      { from: oldFolderPath, to: newFolderPath },
      { from: `${oldFolderPath}/file1.txt`, to: `${newFolderPath}/file1.txt` },
      { from: `${oldFolderPath}/file2.txt`, to: `${newFolderPath}/file2.txt` },
    ]);

    const updatedFolderPath = await folder.get(folderId);
    const updatedFilePath1 = await folder.get(fileId1);
    const updatedFilePath2 = await folder.get(fileId2);

    expect(updatedFolderPath).toBe(newFolderPath);
    expect(updatedFilePath1).toBe(`${newFolderPath}/file1.txt`);
    expect(updatedFilePath2).toBe(`${newFolderPath}/file2.txt`);
  });

  it("refuses a missing folder ID, or one that reads undefined or null", function () {
    for (const folderId of [undefined, null, "", "undefined", "null"])
      expect(() => folderModule(folderId, "blog_a")).toThrowError(
        "Folder ID is required"
      );
  });

  it("throws an error when moving to or from root", async function () {
    const id = "file_1";
    const path = "/file1.txt";

    await folder.set(id, path);

    // Test moving to root
    try {
      await folder.move(id, "/");
      fail("Expected an error when moving to root");
    } catch (err) {
      expect(err.message).toBe("Cannot move to or from root");
    }

    // Test moving from root
    try {
      await folder.move("/", path);
      fail("Expected an error when moving from root");
    } catch (err) {
      expect(err.message).toBe("Cannot move to or from root");
    }
  });

  it("can remove a file", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";

    await folder.set(id, path);
    const removedPaths = await folder.remove(id);

    expect(removedPaths).toEqual([path]);

    const retrievedPath = await folder.get(id);
    expect(retrievedPath).toBeNull();

    const retrievedId = await folder.getByPath(path);
    expect(retrievedId).toBeNull();
  });

  it("can reset all mappings", async function () {
    await folder.set("file_1", "/folder/file1.txt");
    await folder.reset();

    expect(await folder.get("file_1")).toBeNull();
    expect(await folder.getByPath("/folder/file1.txt")).toBeNull();
  });

  it("can remove a folder and all its children", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const folderPath = "/folder";
    const filePath1 = `${folderPath}/file1.txt`;
    const filePath2 = `${folderPath}/file2.txt`;

    await folder.set(folderId, folderPath);
    await folder.set(fileId1, filePath1);
    await folder.set(fileId2, filePath2);

    const removedPaths = await folder.remove(folderId);

    expect(removedPaths.sort()).toEqual(
      [folderPath, filePath1, filePath2].sort()
    );

    const retrievedFolderPath = await folder.get(folderId);
    const retrievedFilePath1 = await folder.get(fileId1);
    const retrievedFilePath2 = await folder.get(fileId2);

    expect(retrievedFolderPath).toBeNull();
    expect(retrievedFilePath1).toBeNull();
    expect(retrievedFilePath2).toBeNull();
  });

  it("move won't clobber a similar file", async function () {
    const id1 = "file_1";
    const id2 = "folder_1";
    const id3 = "file_2";

    await folder.set(id1, "/bar (1).txt");
    await folder.set(id2, "/bar");
    await folder.set(id3, "/bar/foo.txt");

    await folder.move(id2, "/foo");

    expect(await folder.get(id1)).toBe("/bar (1).txt"); // Unaffected
    expect(await folder.get(id2)).toBe("/foo"); // Moved
    expect(await folder.get(id3)).toBe("/foo/foo.txt"); // Child moved with the folder
  });

  it("remove won't clobber a similar file", async function () {
    const id1 = "file_1";
    const id2 = "folder_1";
    const id3 = "file_2";

    await folder.set(id1, "/bar (1).txt");
    await folder.set(id2, "/bar");
    await folder.set(id3, "/bar/foo.txt");

    const removedPaths = await folder.remove(id2);

    expect(removedPaths).toEqual(["/bar", "/bar/foo.txt"]); // Only these paths are removed
    expect(await folder.get(id1)).toBe("/bar (1).txt"); // Unaffected
    expect(await folder.get(id2)).toBeNull(); // Removed
    expect(await folder.get(id3)).toBeNull(); // Removed
  });

  it("move returns a list of affected paths for a single file", async function () {
    const id = "file_1";
    const oldPath = "/bar.txt";
    const newPath = "/baz.txt";

    await folder.set(id, oldPath);
    const movedPaths = await folder.move(id, newPath);

    expect(movedPaths).toEqual([{ from: oldPath, to: newPath }]); // Correctly lists the affected paths
  });

  it("move returns a list of affected paths for a folder", async function () {
    const folderId = "folder_1";
    const fileId = "file_1";
    const oldFolderPath = "/foo";
    const newFolderPath = "/bar";

    await folder.set(folderId, oldFolderPath);
    await folder.set(fileId, `${oldFolderPath}/file1.txt`);

    const movedPaths = await folder.move(folderId, newFolderPath);

    expect(movedPaths.sort()).toEqual([
      { from: oldFolderPath, to: newFolderPath },
      { from: `${oldFolderPath}/file1.txt`, to: `${newFolderPath}/file1.txt` },
    ]);
  });

  it("remove removes all children for root", async function () {
    const rootId = "root";
    const fileId1 = "file_1";
    const fileId2 = "file_2";

    await folder.set(rootId, "/");
    await folder.set(fileId1, "/foo.txt");
    await folder.set(fileId2, "/bar/foo.txt");

    const removedPaths = await folder.remove(rootId);

    expect(removedPaths.sort()).toEqual(
      ["/", "/foo.txt", "/bar/foo.txt"].sort()
    );
    expect(await folder.get(rootId)).toBeNull();
    expect(await folder.get(fileId1)).toBeNull();
    expect(await folder.get(fileId2)).toBeNull();
  });

  it("can lookup an ID by path", async function () {
    const id1 = "file_1";
    const id2 = "file_2";

    await folder.set(id1, "/bar (1).txt");
    await folder.set(id2, "/bar/foo.txt");

    expect(await folder.getByPath("/bar (1).txt")).toBe(id1);
    expect(await folder.getByPath("/bar/foo.txt")).toBe(id2);
    expect(await folder.getByPath("/bar")).toBeNull(); // Nonexistent path
  });

  it("move handles folder children, including nested folders", async function () {
    const folderId = "folder_1";
    const nestedFolderId = "nested_folder";
    const fileId = "file_1";

    await folder.set(folderId, "/foo");
    await folder.set(nestedFolderId, "/foo/bar");
    await folder.set(fileId, "/foo/bar/file1.txt");

    await folder.move(folderId, "/baz");

    expect(await folder.get(folderId)).toBe("/baz");
    expect(await folder.get(nestedFolderId)).toBe("/baz/bar");
    expect(await folder.get(fileId)).toBe("/baz/bar/file1.txt");
  });

  it("throws an error when trying to set a mapping with an empty ID or path", async function (done) {
    try {
      await folder.set("", "/file1.txt");
      done.fail("Expected an error for empty ID");
    } catch (err) {
      expect(err.message).toBe("ID and path must be non-empty strings");
    }

    try {
      await folder.set("file_1", "");
      done.fail("Expected an error for empty path");
    } catch (err) {
      expect(err.message).toBe("ID and path must be non-empty strings");
    }

    try {
      await folder.set(null, null);
      done.fail("Expected an error for null ID and path");
    } catch (err) {
      expect(err.message).toBe("ID and path must be non-empty strings");
    }

    done();
  });

  it("throws an error when trying to move a nonexistent file or folder", async function (done) {
    const nonExistentId = "nonexistent_file";
    const newPath = "/new/path/file.txt";

    try {
      await folder.move(nonExistentId, newPath);
      done.fail("Expected an error for nonexistent ID");
    } catch (err) {
      expect(err.message).toBe(
        `No file or folder found for ID: ${nonExistentId}`
      );
    }

    done();
  });

  it("throws an error when trying to remove a nonexistent file or folder", async function (done) {
    const nonExistentId = "nonexistent_file";

    const removedPaths = await folder.remove(nonExistentId);
    expect(removedPaths).toEqual([]); // Should simply return an empty array

    done();
  });

  it("handles path collisions gracefully during move operations", async function (done) {
    const folderId1 = "folder_1";
    const folderId2 = "folder_2";

    await folder.set(folderId1, "/foo");
    await folder.set(folderId2, "/bar");

    try {
      await folder.move(folderId1, "/bar"); // Attempt to move /foo to /bar
      done.fail("Expected an error due to path collision");
    } catch (err) {
      expect(err.message).toBe("Target path already exists: /bar");
    }

    done();
  });

  it("replaces the path when the same ID is reused", async function () {
    const id = "file_1";
    const oldPath = "/folder/old/file1.txt";
    const newPath = "/folder/new/file1.txt";

    await folder.set(id, oldPath);
    await folder.set(id, newPath);

    const retrievedPath = await folder.get(id);
    expect(retrievedPath).toBe(newPath);

    // Ensure old path-to-ID mapping is removed
    const oldId = await folder.getByPath(oldPath);
    expect(oldId).toBeNull();
  });

  it("replaces the ID when the same path is reused", async function () {
    const id1 = "file_1";
    const id2 = "file_2";
    const path = "/folder/file.txt";

    await folder.set(id1, path);
    await folder.set(id2, path);

    const retrievedId = await folder.getByPath(path);
    expect(retrievedId).toBe(id2);

    // Ensure old ID-to-path mapping is removed
    const oldPath = await folder.get(id1);
    expect(oldPath).toBeNull();
  });

  it("throws an error when trying to move to an existing path", async function (done) {
    const folderId = "folder_1";
    const existingFolderId = "folder_2";
    const oldFolderPath = "/foo";
    const newFolderPath = "/bar";

    await folder.set(folderId, oldFolderPath);
    await folder.set(existingFolderId, newFolderPath);

    try {
      await folder.move(folderId, newFolderPath); // This should throw an error
      done.fail("Expected an error when moving to an existing path");
    } catch (err) {
      expect(err.message).toBe("Target path already exists: /bar");
    }

    done();
  });

  it("treats paths as case-sensitive", async function () {
    const id1 = "file_1";
    const id2 = "file_2";
    const path1 = "/Folder/File1.txt";
    const path2 = "/folder/file1.txt";

    await folder.set(id1, path1);
    await folder.set(id2, path2);

    const retrievedId1 = await folder.getByPath(path1);
    const retrievedId2 = await folder.getByPath(path2);

    expect(retrievedId1).toBe(id1);
    expect(retrievedId2).toBe(id2);
  });

  it("does not remove paths that are not direct children of a folder", async function () {
    const folderId = "folder_1";
    const unrelatedFileId = "file_1";
    const folderPath = "/foo";
    const unrelatedPath = "/foobar";

    await folder.set(folderId, folderPath);
    await folder.set(unrelatedFileId, unrelatedPath);

    const removedPaths = await folder.remove(folderId);

    expect(removedPaths).toEqual([folderPath]); // Only the folder should be removed
    expect(await folder.get(unrelatedFileId)).toBe(unrelatedPath); // Unrelated path remains
  });

  it("removes all data when reset is called, even with partial data", async function () {
    const id1 = "file_1";
    const id2 = "file_2";
    const path1 = "/folder/file1.txt";
    const path2 = "/folder/file2.txt";

    await folder.set(id1, path1);
    await folder.set(id2, path2);

    // Manually remove some Redis data
    await client.hDel(`${prefix}test_folder:path`, path1);

    await folder.reset();

    // Everything should be removed
    expect(await folder.get(id1)).toBeNull();
    expect(await folder.get(id2)).toBeNull();
    expect(await folder.getByPath(path2)).toBeNull();
  });

  it("throws an error when trying to move a folder to a subfolder of itself", async function (done) {
    const folderId = "folder_1";
    const oldFolderPath = "/foo";
    const newFolderPath = "/foo/bar";

    await folder.set(folderId, oldFolderPath);

    try {
      await folder.move(folderId, newFolderPath);
      done.fail("Expected an error when moving to a subfolder of itself");
    } catch (err) {
      expect(err.message).toBe("Cannot move a folder to a subfolder of itself");
    }

    done();
  });

  it("propagates client promise failures", async function () {
    const error = new Error("boom");
    spyOn(client, "hGet").and.callFake(() => Promise.reject(error));

    await expectAsync(
      folder.set("file_failure", "/folder/failure.txt")
    ).toBeRejectedWith(error);
    expect(client.hGet).toHaveBeenCalled();
  });
});
