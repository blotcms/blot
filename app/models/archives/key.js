module.exports = {
  // Sorted set of entryIDs published in {yearMonth} ("YYYY-MM"), scored by dateStamp.
  bucket: function (blogID, yearMonth) {
    return "blog:" + blogID + ":archives:" + yearMonth;
  },
  // Sorted set of "YYYY-MM" strings that currently have at least one entry,
  // scored by the numeric YYYYMM so it can be read back in chronological order.
  months: function (blogID) {
    return "blog:" + blogID + ":archives:months";
  },
  // String holding the "YYYY-MM" bucket an entry currently belongs to, so the
  // next save knows which bucket to remove it from if it moves.
  entry: function (blogID, entryID) {
    return "blog:" + blogID + ":archives:entry:" + entryID;
  },
  // Flag set once the index has been fully (re)built for a blog.
  ready: function (blogID) {
    return "blog:" + blogID + ":archives:ready";
  },
  // Counter incremented by every set() write, watched by rebuild() to detect
  // a concurrent entry save during a rebuild's snapshot window.
  generation: function (blogID) {
    return "blog:" + blogID + ":archives:generation";
  },
};
