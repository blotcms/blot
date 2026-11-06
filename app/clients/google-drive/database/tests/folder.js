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

  it("can set and get metadata for a file", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";
    const metadata = { size: 1024, lastModified: "2025-02-21" };

    await folder.set(id, path, metadata);
    const retrievedMetadata = await folder.getMetadata(id);
    expect(retrievedMetadata).toEqual(metadata);
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

    const contents = await folder.readdir("/folder");
    expect(contents).toEqual([]);
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

  it("can reset all mappings and metadata", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";
    const metadata = { size: 1024, lastModified: "2025-02-21" };

    await folder.set(id, path, metadata);
    await folder.reset();

    const retrievedPath = await folder.get(id);
    const retrievedMetadata = await folder.getMetadata(id);

    expect(retrievedPath).toBeNull();
    expect(retrievedMetadata).toBeNull();
  });

  it("can list all files and folders with metadata", async function () {
    const id1 = "file_1";
    const id2 = "file_2";
    const path1 = "/folder/file1.txt";
    const path2 = "/folder/file2.txt";
    const metadata1 = { size: 1024, lastModified: "2025-02-21" };
    const metadata2 = { size: 2048, lastModified: "2025-02-22" };

    await folder.set(id1, path1, metadata1);
    await folder.set(id2, path2, metadata2);

    const results = await folder.listAll();

    expect(results).toEqual(
      jasmine.arrayWithExactContents([
        { id: id1, path: path1, metadata: metadata1 },
        { id: id2, path: path2, metadata: metadata2 },
      ])
    );
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
  
    expect(removedPaths.sort()).toEqual(["/", "/foo.txt", "/bar/foo.txt"].sort());
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

  it("can reset all mappings and metadata", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";
    const metadata = { size: 1024, lastModified: "2025-02-21" };
  
    await folder.set(id, path, metadata);
    await folder.reset();
  
    // Ensure all mappings, metadata, and keys are removed
    const retrievedPath = await folder.get(id);
    const retrievedMetadata = await folder.getMetadata(id);
    const allFiles = await folder.listAll();
  
    expect(retrievedPath).toBeNull();
    expect(retrievedMetadata).toBeNull();
    expect(allFiles).toEqual([]);
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
    const metadata = { size: 1024, lastModified: "2025-02-21" };
  
    try {
      await folder.set("", "/file1.txt", metadata);
      done.fail("Expected an error for empty ID");
    } catch (err) {
      expect(err.message).toBe("ID and path must be non-empty strings");
    }
  
    try {
      await folder.set("file_1", "", metadata);
      done.fail("Expected an error for empty path");
    } catch (err) {
      expect(err.message).toBe("ID and path must be non-empty strings");
    }
  
    try {
      await folder.set(null, null, metadata);
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
      expect(err.message).toBe(`No file or folder found for ID: ${nonExistentId}`);
    }
  
    done();
  });
  
  it("throws an error when trying to remove a nonexistent file or folder", async function (done) {
    const nonExistentId = "nonexistent_file";
  
    const removedPaths = await folder.remove(nonExistentId);
    expect(removedPaths).toEqual([]); // Should simply return an empty array
  
    done();
  });

  it("throws an error when metadata is not a valid object", async function (done) {
    const id = "file_1";
    const path = "/folder/file1.txt";
  
    try {
      await folder.set(id, path, "invalid_metadata");
      done.fail("Expected an error for invalid metadata");
    } catch (err) {
      expect(err.message).toBe("Metadata must be a valid object");
    }
  
    try {
      await folder.set(id, path, null); // Null metadata should still succeed
      done();
    } catch (err) {
      done.fail("Did not expect an error for null metadata");
    }
  });

  it("handles errors when metadata is corrupted or invalid", async function (done) {
    const id = "file_1";
  
    // Corrupt metadata in Redis
    await client.hSet(`${prefix}test_folder:metadata`, id, "corrupted_metadata_string");
  
    try {
      await folder.getMetadata(id);
      done.fail("Expected a SyntaxError for corrupted metadata");
    } catch (err) {
      expect(err instanceof SyntaxError).toBe(true);
    }
  
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

  it("can update metadata without changing the path", async function () {
    const id = "file_1";
    const path = "/folder/file1.txt";
    const oldMetadata = { size: 1024, lastModified: "2025-02-21" };
    const newMetadata = { size: 2048, lastModified: "2025-02-22" };
  
    await folder.set(id, path, oldMetadata);
    await folder.set(id, path, newMetadata);
  
    const retrievedMetadata = await folder.getMetadata(id);
    expect(retrievedMetadata).toEqual(newMetadata);
  
    const retrievedPath = await folder.get(id);
    expect(retrievedPath).toBe(path); // Path should remain unchanged
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
  
    const allFiles = await folder.listAll();
    expect(allFiles).toEqual([]); // Everything should be removed
  });

  it("returns null when requesting metadata for a nonexistent ID", async function () {
    const nonexistentId = "nonexistent_file";
  
    const metadata = await folder.getMetadata(nonexistentId);
    expect(metadata).toBeNull();
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

  it("returns entries sorted alphabetically by path", async function () {
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const subfolderId = "subfolder_1";
    const basePath = "/folder";
    const filePath1 = `${basePath}/fileB.txt`;
    const filePath2 = `${basePath}/fileA.txt`;
    const subfolderPath = `${basePath}/subfolder`;

    await folder.set(fileId1, filePath1);
    await folder.set(fileId2, filePath2);
    await folder.set(subfolderId, subfolderPath);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual([
      { id: fileId2, path: filePath2, metadata: null }, // fileA.txt
      { id: fileId1, path: filePath1, metadata: null }, // fileB.txt
      { id: subfolderId, path: subfolderPath, metadata: null }, // subfolder
    ]);
  });

  it("can list files and folders in a directory", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const subfolderId = "subfolder_1";
    const basePath = "/folder";
    const filePath1 = `${basePath}/file1.txt`;
    const filePath2 = `${basePath}/file2.txt`;
    const subfolderPath = `${basePath}/subfolder`;

    await folder.set(folderId, basePath);
    await folder.set(fileId1, filePath1);
    await folder.set(fileId2, filePath2);
    await folder.set(subfolderId, subfolderPath);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual(
      jasmine.arrayWithExactContents([
        { id: fileId1, path: filePath1, metadata: null },
        { id: fileId2, path: filePath2, metadata: null },
        { id: subfolderId, path: subfolderPath, metadata: null },
      ])
    );
  });

  it("returns an empty list for an empty directory", async function () {
    const folderId = "empty_folder";
    const basePath = "/empty";

    await folder.set(folderId, basePath);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual([]);
  });

  it("excludes nested directories and files", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const nestedFileId = "nested_file";
    const basePath = "/folder";
    const filePath1 = `${basePath}/file1.txt`;
    const filePath2 = `${basePath}/file2.txt`;
    const nestedFilePath = `${basePath}/subfolder/nested.txt`;

    await folder.set(folderId, basePath);
    await folder.set(fileId1, filePath1);
    await folder.set(fileId2, filePath2);
    await folder.set(nestedFileId, nestedFilePath);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual(
      jasmine.arrayWithExactContents([
        { id: fileId1, path: filePath1, metadata: null },
        { id: fileId2, path: filePath2, metadata: null },
      ])
    );
  });

  it("returns metadata for files and folders", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const basePath = "/folder";
    const filePath1 = `${basePath}/file1.txt`;
    const filePath2 = `${basePath}/file2.txt`;
    const metadata1 = { size: 1024, lastModified: "2025-02-21" };
    const metadata2 = { size: 2048, lastModified: "2025-02-22" };

    await folder.set(folderId, basePath);
    await folder.set(fileId1, filePath1, metadata1);
    await folder.set(fileId2, filePath2, metadata2);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual(
      jasmine.arrayWithExactContents([
        { id: fileId1, path: filePath1, metadata: metadata1 },
        { id: fileId2, path: filePath2, metadata: metadata2 },
      ])
    );
  });

  it("throws an error for invalid directory paths", async function (done) {
    try {
      await folder.readdir("");
      done.fail("Expected an error for an empty directory path");
    } catch (err) {
      expect(err.message).toBe("Directory path must be a non-empty string");
    }

    try {
      await folder.readdir(null);
      done.fail("Expected an error for a null directory path");
    } catch (err) {
      expect(err.message).toBe("Directory path must be a non-empty string");
    }

    done();
  });

  it("does not include entries outside the given directory", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const unrelatedFileId = "file_3";
    const basePath = "/folder";
    const unrelatedPath = "/other";
    const filePath1 = `${basePath}/file1.txt`;
    const filePath2 = `${basePath}/file2.txt`;
    const unrelatedFilePath = `${unrelatedPath}/file3.txt`;

    await folder.set(folderId, basePath);
    await folder.set(fileId1, filePath1);
    await folder.set(fileId2, filePath2);
    await folder.set(unrelatedFileId, unrelatedFilePath);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual(
      jasmine.arrayWithExactContents([
        { id: fileId1, path: filePath1, metadata: null },
        { id: fileId2, path: filePath2, metadata: null },
      ])
    );
  });

  it("handles case-sensitive paths correctly", async function () {
    const folderId = "folder_1";
    const fileId1 = "file_1";
    const fileId2 = "file_2";
    const basePath = "/Folder";
    const filePath1 = `${basePath}/file1.txt`;
    const filePath2 = `${basePath}/file2.txt`;

    await folder.set(folderId, basePath);
    await folder.set(fileId1, filePath1);
    await folder.set(fileId2, filePath2);

    const entries = await folder.readdir(basePath);

    expect(entries).toEqual(
      jasmine.arrayWithExactContents([
        { id: fileId1, path: filePath1, metadata: null },
        { id: fileId2, path: filePath2, metadata: null },
      ])
    );

    const entriesLowerCase = await folder.readdir(basePath.toLowerCase());
    expect(entriesLowerCase).toEqual([]); // Should not match a case-sensitive path
  });


  it("propagates client promise failures", async function () {
    const error = new Error("boom");
    spyOn(client, "hGet").and.callFake(() => Promise.reject(error));

    await expectAsync(folder.set("file_failure", "/folder/failure.txt")).toBeRejectedWith(error);
    expect(client.hGet).toHaveBeenCalled();
  });

});
