var debug = require("debug")("blot:clients:dropbox:sync");
var createClient = require("../util/createClient");
var Download = require("../util/download");
var _require = require("../util/constants");
var MAX_FILE_SIZE = _require.MAX_FILE_SIZE;
var hasUnsupportedExtension = _require.hasUnsupportedExtension;
var isDotfileOrDotfolder = _require.isDotfileOrDotfolder;
var hashFile = require("helper/hashFile");
var Database = require("../database");
var Path = require("path");
var join = Path.join;
var Delta = require("../delta");
var fs = require("fs-extra");
var async = require("async");
var Sync = require("sync");
var caseSensitivePath = require("helper/caseSensitivePath");

var MAX_CHECKS_WITHOUT_RESULTS = 5;

module.exports = function main(blog, callback) {
  debug("Blog:", blog.id, "Attempting to acquire lock on the blog folder.");

  // Redlock options to ensure we acquire a lock eventually...
  // pershaps we should keep track and only issue a second pending sync
  // to prevent an infinite stack of webhooks.
  Sync(blog.id, function (err, folder, done) {
    if (err) return callback(err);

    Database.set(
      blog.id,
      { last_sync: Date.now() },
      function (lastSyncErr) {
        if (lastSyncErr) {
          folder.log("Error setting pre-sync timestamp", lastSyncErr);
        }
      }
    );

    folder.log("Creating Dropbox client");
    // We need to look up the Dropbox account for this blog
    // to retrieve the access token used to create a new Dropbox
    // client to retrieve changes made to the user's Dropbox.
    createClient(blog.id, function (err, client, account) {
      if (err) {
        folder.log("Error creating client", err);
        return Database.set(
          blog.id,
          { error_code: err.status || 400 },
          function (err) {
            done(err, callback);
          }
        );
      }

      folder.log("Constructing methods to sync changes");

      var delta = new Delta(client, account.folder_id, blog.id);
      var apply = new Apply(client, folder.path, folder.log, folder.status);

      var checksWithoutResults = 0;

      // Delta retrieves changes to the folder on Dropbox for a given
      // blog. It returns a list of changes. It also adds a new property
      // to each change, relative_path. Use change.relative_path
      // as the 'Blot' path, this is the path of the change relative to the
      // blog folder in the user's Dropbox folder.
      folder.status("Fetching changes from Dropbox");
      delta(account.cursor, function handle(err, result) {
        if (err) {
          folder.log("Error fetching changes from Dropbox", err);
          return Database.set(
            blog.id,
            { error_code: err.status || 400 },
            function (err) {
              done(err, callback);
            }
          );
        }

        folder.log(`Fetched ${result.entries.length} changes from Dropbox`);

        // Now we attempt to apply the changes which occured in the
        // user's folder on Dropbox to the blog folder on Blot's server.
        // This means making any new directories, downloading any new
        // or changed files, and removing any deleted items.
        apply(result.entries, function (err) {
          if (err) {
            console.log("Blog", blog.id, "Dropbox Error:", err);
            return Database.set(
              blog.id,
              { error_code: err.status || 400 },
              function (err) {
                done(err, callback);
              }
            );
          }
          // we have successfully applied this batch of changes
          // to the user's Dropbox folder. Now we save the new
          // cursor and folderID and folder path to the database.
          // This means that future webhooks will invoke calls to
          // delta which return changes made after this point in time.
          account.error_code = 0;
          account.last_sync = Date.now();
          account.cursor = result.cursor;
          // we store account folder for use on the dashboard
          if (result.path_display) account.folder = result.path_display;

          debug("Storing latest cursor and folder information...", account);

          Database.set(blog.id, account, function (err) {
            if (err) return done(err, callback);

            // Now we report back to Blot about the changes made during
            // this synchronization. We don't care about errors because
            // those lie beyond the scope of this client. Its responsibilty
            // is to ensure the blog folder on Blot's server is in sync.
            // We must do this in series until entry.set becomes
            // atomic. Right now, making changes to the blog's
            // menu cannot be done concurrently, hence eachSeries!
            async.eachSeries(
              result.entries,
              function (item, next) {
                debug("Updating on Blot:", item.relative_path);

                // The items's relative path is computed by delta, based on the
                // current path to the blog's folder in the user's Dropbox.
                // The relative path is also lowercase. This is because Dropbox
                // is case-insensitive but the file system for Blot's server is not.
                // We therefore pass the name of the file, which has its case preserved
                // to update, so things like automatic title generation based on the
                // file can be computed nicely, along with the display path, which also
                // has case-preserved, for things like extracting tags from tag folders.
                // Use resolved_relative_path if available (set by determinePathOnDisk),
                // otherwise fall back to relative_path
                const pathToUpdate = item.resolved_relative_path || item.relative_path;
                folder.log(pathToUpdate, "Updating path");
                folder.update(
                  pathToUpdate,
                  function (err) {
                    // We don't want an error here to block other
                    // changes from being applied.
                    if (err) console.log("Dropbox client:", err);
                    next();
                  }
                );
              },
              function () {
                // If Dropbox says there are more changes
                // we get them before returning the callback.
                // This is important because a rename could
                // be split across two pages of file events.
                if (result.has_more) {
                  folder.log("There are more changes to fetch on Dropbox");
                  checksWithoutResults = 0;
                  return delta(result.cursor, handle);
                }

                // If a webhook arrived during this long sync...
                if (result.entries && result.entries.length) {
                  folder.log("Checking in case there are new changes to fetch");
                  checksWithoutResults = 0;
                  return delta(result.cursor, handle);
                }

                if (checksWithoutResults < MAX_CHECKS_WITHOUT_RESULTS) {
                  checksWithoutResults++;
                  let delay = checksWithoutResults * 100;
                  folder.log(`Waiting ${delay}ms to check for changes`);
                  return setTimeout(function () {
                    folder.log("Checking again for new changes");
                    delta(result.cursor, handle);
                  }, delay);
                }

                folder.log("Folder in sync with Dropbox");
                done(null, callback);
              }
            );
          });
        });
      });
    });
  });
};

function Apply(client, blogFolder, log, status) {
  return function apply(changes, callback) {
    debug("Retrieved changes", changes);

    var deleted = changes
      .filter(function (item) {
        return item[".tag"] === "deleted";
      })
      .filter(function (item) {
        return !isDotfileOrDotfolder(item.relative_path);
      });

    var folders = changes
      .filter(function (item) {
        return item[".tag"] === "folder";
      })
      .filter(function (item) {
        return !isDotfileOrDotfolder(item.relative_path);
      });

    var files = changes
      .filter(function (item) {
        return item[".tag"] === "file";
      })
      .filter(function (item) {
        return !isDotfileOrDotfolder(item.relative_path);
      });

    function remove(item, callback) {
      determinePathOnDisk(blogFolder, item, function (err) {

        if (err) {
          log(item.relative_path, "Error determining path on disk for removal");
          return callback();
        }

        log(item.resolved_relative_path, "Removing from folder");
        status("Removing " + item.resolved_relative_path);
        fs.remove(item.path_on_disk, function (err) {
          if (err) {
            log(item.resolved_relative_path, "Error removing from folder", err);
            status("Error removing " + item.resolved_relative_path);
          } else {
            log(item.resolved_relative_path, "Removed from folder successfully");
          }

          // This error happens if you try to remove a non-existent file
          // inside a non-existent folder whose name happens to be the same
          // as an existent file. For example, create a file 'hello.txt' then
          // try to remove hello.txt/bar.txt, you will get this error.
          // Since we don't care, we suppress it.
          if (err && err.code === "ENOTDIR") return callback();

          // We should probably handle this somehow. Without this
          // we end up being unable to sync blogs with a single
          // file that has a long name
          if (err && err.code === "ENAMETOOLONG") return callback();

          // Swallow errors generally so we can proceed to next file
          // we might want to mark an error somehow
          callback();
        });
      });
    }

    function mkdir(item, callback) {
      determinePathOnDisk(blogFolder, item, function (err) {

        if (err) {
          log(item.relative_path, "Error determining path on disk for mkdir");
          return callback();
        }

        log(item.resolved_relative_path, "Making directory in folder");
        status("Creating directory " + item.resolved_relative_path);
        fs.ensureDir(item.path_on_disk, function (err) {
          // we have run into an EEXIST error here when a file exists
          // where a new folder needs to be. I decided against
          // just removing the file and replacing it with a folder
          // since this would reflect something badly out of sync with
          // dropbox (they would send the deletion before the creation?)
          // How could a file named for a folder have gotten here? could
          // blot have done it or is it just the user?

          if (err) {
            log(item.resolved_relative_path, "Error making directory in folder", err);
            status("Error making directory " + item.resolved_relative_path);
          } else {
            log(item.resolved_relative_path, "Made directory in folder successfully");
          }

          // Swallow errors generally so we can proceed to next file
          // we might want to mark an error somehow
          callback();
        });
      }); 
    }

    // Item.path_display is the full path to the item
    // in the user's Dropbox. Don't confuse it with the
    // relative path to an item, since the root of the
    // Dropbox folder might not be the root of the blog.
    function download(item, callback) {

      determinePathOnDisk(blogFolder, item, function (err) {

        if (err) {
          log(item.relative_path, "Error determining path on disk for download");
          return callback();
        }

        var pathForUnsupportedCheck = item.path_display || item.resolved_relative_path || "";

        if (hasUnsupportedExtension(pathForUnsupportedCheck)) {
          var unsupportedMessage =
            "Skipping download because file extension is unsupported";
          log(item.resolved_relative_path, unsupportedMessage);
          status("Skipping unsupported file " + item.resolved_relative_path);

          return fs.outputFile(
            item.path_on_disk,
            "",
            function (err) {
              if (err) {
                log(
                  item.resolved_relative_path,
                  "Error creating placeholder for unsupported file",
                  err
                );
                status("Error creating placeholder " + item.resolved_relative_path);
              }

              callback();
            }
          );
        }

        if (typeof item.size === "number" && item.size > MAX_FILE_SIZE) {
          var message =
            "Skipping download because file exceeds size limit (" +
            item.size +
            " > " +
            MAX_FILE_SIZE +
            ")";
          log(item.resolved_relative_path, message);
          status("Skipping oversized file " + item.resolved_relative_path);

          return fs.outputFile(
            item.path_on_disk,
            "",
            function (err) {
              if (err) {
                log(
                  item.resolved_relative_path,
                  "Error creating placeholder for oversized file",
                  err
                );
                status("Error creating placeholder " + item.resolved_relative_path);
              }

              callback();
            }
          );
        }

        status("Downloading " + item.resolved_relative_path);

        
        log(item.resolved_relative_path, "Hashing any existing file contents");

        hashFile(item.path_on_disk, function (
          err,
          content_hash
        ) {
          if (item.content_hash && content_hash && item.content_hash === content_hash) {
            log(item.resolved_relative_path, "Hash matches, don't download");
            return callback();
          }

          log(
            item.resolved_relative_path,
            "Hash does not match, downloading from Dropbox"
          );
          Download(
            client,
            item.path_display,
            item.path_on_disk,
            function (err) {
              if (err) {
                log(item.resolved_relative_path, "Error downloading from dropbox", err);
                status("Error downloading " + item.resolved_relative_path);
              } else {
                log(item.resolved_relative_path, "Downloaded to folder successfully");
              }

              // Seen in production: a Dropbox account stuck generating
              // ever-longer "(Conflict met exemplaar van ...)" copies of the
              // same file until the name exceeded the filesystem's max name
              // length. We can't write a placeholder here the way we do for
              // unsupported/oversized files above, because item.path_on_disk
              // is itself the too-long path – any write to it fails the same
              // way the download did. Without this check, the file's hash
              // never matches (it's never written), so every subsequent sync
              // and hourly validation run re-attempts and re-fails the same
              // download forever, spamming the logs and repeatedly flagging
              // the blog as having "unsynced changes".
              if (err && err.code === "ENAMETOOLONG") {
                log(
                  item.resolved_relative_path,
                  "Skipping download because destination path exceeds filesystem name limit"
                );
                status("Skipping " + item.resolved_relative_path + " (name too long)");
                return callback();
              }

              // Swallow the error that occur when the user has forbidden content
              // in their folder. We should surface this eventually. You can test
              // this error using the file in tests/files/will_flag_restricted_content.png
              // Warning: this looks like a more generic error!
              if (
                err &&
                err.statusCode === 409 &&
                err.statusMessage === "Conflict"
              ) {
                return callback();
              }

              // Swallow errors generally so we can proceed to next file
              // we might want to mark an error somehow
              callback();
            }
          );
        });
      });
    }

    debug("Deleted:", deleted);
    debug("Folders:", folders);
    debug("Files:", files);

    async.series(
      [
        async.apply(async.eachSeries, deleted, remove),
        async.apply(async.eachSeries, folders, mkdir),
        async.apply(async.eachSeries, files, download),
      ],
      callback
    );
  };
}

function determinePathOnDisk(blogFolder, item, callback) {
  console.log('[determinePathOnDisk] START', {
    blogFolder,
    relative_path: item.relative_path,
    path_display: item.path_display,
    tag: item[".tag"]
  });

  const normalizedRelativePath = (item.relative_path || "").replace(/^\/+/, "");
  if (normalizedRelativePath !== item.relative_path) {
    console.log('[determinePathOnDisk] Normalized relative_path', {
      from: item.relative_path,
      to: normalizedRelativePath
    });
    item.relative_path = normalizedRelativePath;
  }

  const parentDir = Path.dirname(item.relative_path);
  const filename = Path.basename(item.relative_path);
  
  console.log('[determinePathOnDisk] Parsed path', {
    parentDir,
    filename
  });

  caseSensitivePath(blogFolder, parentDir, function (err, resolvedParent) {

    // We don't want to fail the download just because
    // we couldn't resolve the case sensitive path – just log it and proceed.
    if (err) {
      console.log('[determinePathOnDisk] ERROR from caseSensitivePath', {
        relative_path: item.relative_path,
        parentDir,
        error: err.message || err,
        stack: err.stack
      });
      item.resolved_relative_path = item.relative_path;
      item.path_on_disk = join(blogFolder, item.relative_path);
      console.log('[determinePathOnDisk] Using fallback paths', {
        resolved_relative_path: item.resolved_relative_path,
        path_on_disk: item.path_on_disk
      });
      return callback(null); // resolvedParent will be undefined, fallback logic will handle it
    }

    console.log('[determinePathOnDisk] caseSensitivePath resolved', {
      parentDir,
      resolvedParent
    });

    // Use resolved parent directory if available and not root
    // parentDir === '.' means the file is at the root level
    // caseSensitivePath returns an absolute path, so we need to make it relative
    let resolvedRelativePath = item.relative_path;

    if (parentDir !== '.' && resolvedParent) {
      // Convert absolute path to relative path using Path.relative for robustness
      const resolvedRelativeParent = Path.relative(blogFolder, resolvedParent);
      
      console.log('[determinePathOnDisk] Computed relative parent', {
        blogFolder,
        resolvedParent,
        resolvedRelativeParent
      });
      
      // Safety check: ensure resolvedParent is actually inside blogFolder
      // Path.relative returns paths with '../' if the target is outside the base
      // Also handle empty string case (when paths are the same)
      if (resolvedRelativeParent && resolvedRelativeParent !== '' && !resolvedRelativeParent.startsWith('..')) {
        resolvedRelativePath = join(resolvedRelativeParent, filename);
        console.log('[determinePathOnDisk] Using resolved parent path', {
          resolvedRelativeParent,
          filename,
          resolvedRelativePath
        });
      } else {
        console.log('[determinePathOnDisk] Skipping resolved parent (outside blogFolder or empty)', {
          resolvedRelativeParent,
          using_fallback: item.relative_path
        });
      }
      // If resolvedParent is outside blogFolder or empty, fall back to item.relative_path
    } else {
      console.log('[determinePathOnDisk] Root level or no resolvedParent', {
        parentDir,
        resolvedParent,
        using_fallback: item.relative_path
      });
    }

    item.resolved_relative_path = resolvedRelativePath;
    item.path_on_disk = join(blogFolder, resolvedRelativePath);

    console.log('[determinePathOnDisk] FINAL RESULT', {
      relative_path: item.relative_path,
      resolved_relative_path: item.resolved_relative_path,
      path_on_disk: item.path_on_disk
    });

    callback(null);
  });
}
