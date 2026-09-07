This module allows us to transform
a file to some arbritrary JSON object
and persist that in the db. The file can
exist on disk or at a URL. This module
only applies the transformation function
to the same file once.

I use this module to upload images in blog
posts, but to only upload the same image once.
If it's already uploaded, this retrieves its
url and dimensions from the database.
As you can imagine, this massively speeds up
saving existing entries, since images don't need
to be reuploaded each time!


Non-goal: concurrent lookup de-duplication
------------------------------------------

The "only applies the transformation function to the same file once"
guarantee is about *repeat* lookups over time: once a result is cached
against the file's content hash, later lookups reuse it and never run the
transform again.

It is NOT a guarantee about lookups that are in flight at the same moment.
Note this does not happen within a single entry render: the image plugin
walks <img> tags with async.eachOfSeries (see build/plugins/eachEl.js), so
the same image referenced twice in one post is looked up one call after
the other, not concurrently. The race is between *independent* callers of
the same (blogID, name) store - e.g. two entries rebuilt in parallel that
reference the same URL. When that happens both lookups run the transform.

What the duplication costs depends on the transform:

  - A deterministic, side-effect-free transform (hash a file, read image
    dimensions): both runs produce an equal result, they write the same
    content-hash key, last write wins, and the only cost is the wasted
    second run.

  - A transform that writes files or is non-deterministic: it can leave
    debris. build/plugins/image/optimize.js mints a fresh uuid per call
    and uses it in BOTH the file it writes under _image_cache/ AND the src
    it returns. Two concurrent runs therefore persist two copies on disk
    and hand their two callers different URLs; only one result wins the
    Redis key, so the other file is orphaned (still referenced by the
    entry that made it, but unknown to flush()).

This is a deliberate, accepted trade-off. We are not going to add an
in-flight promise/lock map to collapse concurrent lookups: it adds shared
mutable state and failure-handling complexity (rejections, eviction, keys
that differ only by path vs. URL vs. case) to a hot path, in exchange for
saving a rare duplicate transform. Please do not re-report the missing
de-duplication itself as a bug - if it is costing something real (disk
filling with orphaned _image_cache copies, say), revisit it here with
numbers first.