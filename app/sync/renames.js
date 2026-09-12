var Entries = require("models/entries");
var async = require("async");
var Entry = require("models/entry");
var Blog = require("models/blog");
var clfdate = require("helper/clfdate");
var DateStamp = require("build/prepare/dateStamp");

const { isDraft } = require("sync/update/drafts");

module.exports = function (blogID, callback) {
  var RENAME_PERIOD = 1000 * 30; // 30 seconds
  var after = Date.now() - RENAME_PERIOD;

  var renames = {};

  Entries.getCreated(blogID, after, function (err, createdEntries) {
    if (err) return callback(err);

    Entries.getDeleted(blogID, after, function (err, deletedEntries) {
      if (err) return callback(err);

      // filter out deleted entries without guids
      deletedEntries = deletedEntries.filter(function (entry) {
        return entry.guid;
      });

      createdEntries.forEach(function (createdEntry) {
        var deletedEntriesOfSameSize;
        var deletedEntriesOfSameTitle;
        var deletedEntry;

        // ensure we only detect entries of the same size
        // if the size is defined and non-zero
        deletedEntriesOfSameSize = deletedEntries.filter(function (
          deletedEntry
        ) {
          return deletedEntry.size && deletedEntry.size === createdEntry.size;
        });

        deletedEntriesOfSameTitle = deletedEntries.filter(function (
          deletedEntry
        ) {
          return deletedEntry.title === createdEntry.title;
        });

        if (deletedEntriesOfSameSize.length === 1) {
          deletedEntry = deletedEntriesOfSameSize.pop();
        } else if (deletedEntriesOfSameTitle.length === 1) {
          deletedEntry = deletedEntriesOfSameTitle.pop();
        } else {
          return;
        }

        deletedEntries = deletedEntries.filter(function (entry) {
          return deletedEntry.path !== entry.path;
        });

        renames[createdEntry.path] = {
          createdEntry: createdEntry,
          deletedEntry: deletedEntry,
        };
      });

      if (!Object.keys(renames).length) return callback();

      // The created entry was built (and its dateStamp computed) before
      // this rename was detected, so a date-only metadata value couldn't
      // yet be compared against the file's true original creation time -
      // that only becomes available below, via deletedEntry.created. Once
      // we know it, we can recompute the dateStamp exactly as a normal
      // rebuild would. Loading the blog here is best-effort: if it fails,
      // we simply skip that recomputation and fall through to prior
      // behaviour.
      Blog.get({ id: blogID }, function (err, blog) {
        async.eachOfSeries(
          renames,
          function (rename, deletedPath, next) {
            var createdEntry = rename.createdEntry;
            var deletedEntry = rename.deletedEntry;
            var updates = {
              url: deletedEntry.url,
              guid: deletedEntry.guid,
            };

            // If the deleted entry did not have a path specified
            // in its path or its metadata (which we determine by
            // comparing its publish dateStamp with the time it was
            // created on blot) if the new created entry is the same
            // then set the publish dateStamp for the created entry
            // to the publish date of the deleted entry. I amended
            // this logic to fix a bug caused by renaming x.jpg to
            // 2018_10_06.jpg. The newly specified date was clobbered.
            if (
              deletedEntry.dateStamp === deletedEntry.created &&
              createdEntry.dateStamp === createdEntry.created
            ) {
              updates.dateStamp = deletedEntry.dateStamp;
            }

            isDraft(blogID, deletedEntry.path, function (err, draft) {

              // if the deleted entry was a draft, we reset the created date
              // otherwise we use the old created date of the renamed file
              if (!draft) {
                updates.created = deletedEntry.created;

                // Recompute the dateStamp now that the entry's true created
                // date is known, unless the legacy check above already
                // decided it.
                if (updates.dateStamp === undefined && blog) {
                  var recomputed = DateStamp(
                    blog,
                    createdEntry.path,
                    createdEntry.metadata,
                    updates.created
                  );

                  if (recomputed !== undefined) updates.dateStamp = recomputed;
                }
              }

              console.log(
                clfdate(),
                blogID.slice(0, 12),
                "rename",
                deletedEntry.path
              );

              console.log(
                clfdate(),
                blogID.slice(0, 12),
                "----->",
                createdEntry.path
              );

              // we need to remove the guid of the deleted entry
              // so it is only renamed once
              Entry.set(blogID, createdEntry.path, updates, (err) => {
                if (err) return next(err);

                Entry.set(blogID, deletedEntry.path, { guid: '' }, next);
              });
            });
          },
          callback
        );
      });
    });
  });
};
