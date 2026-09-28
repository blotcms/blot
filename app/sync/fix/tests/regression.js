// Outcome-based regression ("characterisation") tests for sync/fix.
//
// Unlike the other specs in this directory (which spyOn Tags/Entry/client
// and assert *which calls were made*), these tests seed a real test blog,
// write real files to disk, run a real sync/rebuild so entries/lists/tags
// are populated exactly as production does it, corrupt the resulting Redis
// state the way real ghosts arise, run the public Fix() end-to-end, and
// assert the final Redis state, the files on disk and the report Fix()
// returns. They exist to pin *outcomes*, not implementation, so a refactor
// of how each check reads Redis (see PR #2003, and the larger redesign
// tracked in the root TODO) can be verified against them without rewriting
// the tests themselves.
//
// Several of the assertions below capture behaviour that looks like a bug
// but is what the current code actually does - see the comments marked
// "current behaviour" throughout. Do not "fix" these without checking
// whether production relies on them.

const { promisify } = require("util");
const fs = require("fs-extra");

const fix = require("../index");
const Entry = require("models/entry");
const Tags = require("models/tags");
const Blog = require("models/blog");
const client = require("models/client");
const pathIndex = require("models/entries/pathIndex");
const localPath = require("helper/localPath");

const fixAsync = promisify(fix);
const getEntry = (blogID, id) =>
  promisify((next) => Entry.get(blogID, id, (entry) => next(null, entry)))();
const getBlog = promisify((id, cb) => Blog.get({ id }, cb));

const LISTS = ["all", "created", "entries", "drafts", "scheduled", "pages"];

function listKey(blogID, list) {
  return "blog:" + blogID + ":" + list;
}

async function listIds(blogID, list) {
  return (await client.zRange(listKey(blogID, list), 0, -1)).sort();
}

async function allLists(blogID) {
  const out = {};
  for (const list of LISTS) out[list] = await listIds(blogID, list);
  return out;
}

async function pathIndexIds(blogID) {
  return (await client.zRange(pathIndex.lexKey(blogID), 0, -1)).sort();
}

async function tagSlugs(blogID) {
  return (await client.sMembers(Tags.key.all(blogID))).sort();
}

async function tagMembers(blogID, slug) {
  return (await client.zRange(Tags.key.sortedTag(blogID, slug), 0, -1)).sort();
}

// Raw entry-key corruption helper: reads the JSON stored at the entry's
// *current* Redis key and rewrites it in place, without going through
// Entry.set (which would repair tags/lists/menu as a side effect - exactly
// the machinery these tests are trying to bypass so Fix() has something to
// repair).
async function corruptEntryRaw(blogID, id, mutate) {
  const key = Entry.key.entry(blogID, id);
  const raw = await client.get(key);
  const entry = JSON.parse(raw);
  mutate(entry);
  await client.set(key, JSON.stringify(entry));
  return entry;
}

describe("sync/fix regression (outcome-based)", function () {
  global.test.blog();

  beforeEach(function () {
    this.fake = global.test.fake;
  });

  // ---------------------------------------------------------------------
  // 1. Clean blog
  // ---------------------------------------------------------------------

  it("leaves a clean blog with entries, tags, drafts, pages and a menu unchanged", async function () {
    const blog = this.blog;

    await blog.write({ path: "/post-one.txt", content: "Tags: sun, sea\n\n# Post one" });
    await blog.write({ path: "/post-two.txt", content: "Tags: sea, sand\n\n# Post two" });
    await blog.write({ path: "/draft.txt", content: "Draft: yes\n\n# A draft" });
    await blog.write({ path: "/about.txt", content: "Page: yes\n\n# About" });
    await blog.write({ path: "/future.txt", content: "Date: 1/1/2099\n\n# Future post" });

    await blog.rebuild();

    const before = {
      lists: await allLists(blog.id),
      pathIndex: await pathIndexIds(blog.id),
      tags: await tagSlugs(blog.id),
      menu: (await getBlog(blog.id)).menu,
      cacheID: (await getBlog(blog.id)).cacheID,
    };

    const report = await fixAsync(blog);

    expect(report).toEqual({});

    const after = {
      lists: await allLists(blog.id),
      pathIndex: await pathIndexIds(blog.id),
      tags: await tagSlugs(blog.id),
      menu: (await getBlog(blog.id)).menu,
      cacheID: (await getBlog(blog.id)).cacheID,
    };

    expect(after).toEqual(before);
  });

  // ---------------------------------------------------------------------
  // 2. entry-ghosts
  // ---------------------------------------------------------------------

  describe("entry-ghosts", function () {
    it("drops an entry whose file was deleted from disk", async function () {
      const blog = this.blog;
      await blog.write({ path: "/ghost.txt", content: "Tags: orphaned\n\n# Ghost" });
      await blog.rebuild();

      await blog.remove("/ghost.txt");

      const report = await fixAsync(blog);

      expect(report["entry-ghosts"]).toEqual(
        jasmine.arrayContaining([
          jasmine.stringMatching(/missing from the disk/),
        ])
      );

      const entry = await getEntry(blog.id, "/ghost.txt");
      expect(entry.deleted).toBe(true);
      expect(entry.tags).toEqual([]);

      // current behaviour: dropped entries are removed from every visibility
      // list, but the "all" list keeps every id forever (see
      // models/entry/_assign.js - "all" is added to unconditionally, and
      // there is no code path that ever drops from it).
      const lists = await allLists(blog.id);
      expect(lists.all).toContain("/ghost.txt");
      expect(lists.entries).not.toContain("/ghost.txt");
      expect(lists.pages).not.toContain("/ghost.txt");
      expect(lists.drafts).not.toContain("/ghost.txt");

      expect(await tagMembers(blog.id, "orphaned")).not.toContain("/ghost.txt");

      // idempotent: deleted entries are skipped entirely on the next run
      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });

    it("corrects an entry's path when the file exists on disk under a different case, but does not rename its Redis key or id", async function () {
      const blog = this.blog;
      await blog.write({ path: "/Case/Foo.txt", content: "# Foo" });
      await blog.rebuild();

      await fs.move(
        localPath(blog.id, "/Case/Foo.txt"),
        localPath(blog.id, "/case/foo.txt")
      );

      const report = await fixAsync(blog);

      expect(report["entry-ghosts"]).toEqual(
        jasmine.arrayContaining([
          jasmine.stringMatching(/different case/),
        ])
      );

      // current behaviour: only the "path" field is corrected. The entry
      // stays stored under its original (now stale-cased) Redis key and id.
      const original = await getEntry(blog.id, "/Case/Foo.txt");
      expect(original).toBeTruthy();
      expect(original.id).toBe("/Case/Foo.txt");
      expect(original.path).toBe("/case/foo.txt");

      const underNewCase = await getEntry(blog.id, "/case/foo.txt");
      expect(underNewCase).toBeUndefined();

      // idempotent: resolvePath now resolves entry.path ("/case/foo.txt")
      // straight to the file on disk, so nothing more to do.
      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });

    it("drops a folder ('+') post whose source folder is gone", async function () {
      const blog = this.blog;
      await blog.write({ path: "/Album+/one.md", content: "# One" });
      await blog.write({ path: "/Album+/two.md", content: "# Two" });
      await blog.rebuild();

      const folderEntry = await getEntry(blog.id, "/Album");
      expect(folderEntry).toBeTruthy();

      await fs.remove(localPath(blog.id, "/Album+"));

      const report = await fixAsync(blog);

      expect(report["entry-ghosts"]).toEqual(
        jasmine.arrayContaining([
          jasmine.stringMatching(/missing from the disk/),
        ])
      );

      const entry = await getEntry(blog.id, "/Album");
      expect(entry.deleted).toBe(true);

      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });

    it("drops a folder post whose folder has been replaced by a plain file", async function () {
      const blog = this.blog;
      await blog.write({ path: "/Trip+/one.md", content: "# One" });
      await blog.write({ path: "/Trip+/two.md", content: "# Two" });
      await blog.rebuild();

      expect(await getEntry(blog.id, "/Trip")).toBeTruthy();

      await fs.remove(localPath(blog.id, "/Trip+"));
      await fs.outputFile(localPath(blog.id, "/Trip+"), "not a folder anymore");

      const report = await fixAsync(blog);

      expect(report["entry-ghosts"]).toEqual(
        jasmine.arrayContaining([
          jasmine.stringMatching(/missing from the disk/),
        ])
      );

      const entry = await getEntry(blog.id, "/Trip");
      expect(entry.deleted).toBe(true);
    });
  });

  // ---------------------------------------------------------------------
  // 3. list-ghosts / pruneMissing
  // ---------------------------------------------------------------------

  describe("list-ghosts", function () {
    it("silently prunes a list member whose entry key is entirely missing, without reporting it or bumping cacheID", async function () {
      const blog = this.blog;
      await blog.write({ path: "/vanish.txt", content: "# Vanish" });
      await blog.rebuild();

      const before = await getBlog(blog.id);
      expect((await listIds(blog.id, "entries")).indexOf("/vanish.txt")).not.toBe(-1);

      // Raw corruption: the entry key itself disappears (eg. a botched
      // manual Redis operation) while the entry stays listed everywhere.
      await client.del(Entry.key.entry(blog.id, "/vanish.txt"));

      const report = await fixAsync(blog);

      // current behaviour: list-ghosts' pruneMissing() (Entries.pruneMissing)
      // removes the id from every list *before* list-ghosts's own
      // ghost-detection loop ever sees it, and pruneMissing does not feed
      // anything into the report. So a purely-missing-entry-with-no-tag
      // corruption is fixed with an entirely empty report, and Fix()
      // therefore never bumps the blog's cacheID even though state changed.
      expect(report).toEqual({});
      expect(await listIds(blog.id, "entries")).not.toContain("/vanish.txt");
      expect(await listIds(blog.id, "all")).not.toContain("/vanish.txt");
      expect((await getBlog(blog.id)).cacheID).toBe(before.cacheID);
    });

    it("removes a list member stored under a stale id and re-sets the entry under its real id, leaving the orphaned key behind", async function () {
      const blog = this.blog;
      await blog.write({ path: "/stale.txt", content: "# Stale" });
      await blog.rebuild();

      expect(await listIds(blog.id, "entries")).toContain("/stale.txt");

      const corrupted = await corruptEntryRaw(blog.id, "/stale.txt", (entry) => {
        entry.id = "/stale-real.txt";
      });

      const report = await fixAsync(blog);

      expect(report["list-ghosts"]).toEqual(
        jasmine.arrayContaining([["entries", "MISMATCH", "/stale.txt"]])
      );

      const lists = await allLists(blog.id);
      expect(lists.entries).not.toContain("/stale.txt");
      expect(lists.entries).toContain("/stale-real.txt");
      expect(lists.all).not.toContain("/stale.txt");
      expect(lists.all).toContain("/stale-real.txt");

      const repaired = await getEntry(blog.id, "/stale-real.txt");
      expect(repaired.id).toBe("/stale-real.txt");

      // current behaviour: the original, now-orphaned Redis key is never
      // deleted - list-ghosts only re-sets the entry under its real id, it
      // does not clean up the key it found the ghost under.
      const orphan = await getEntry(blog.id, "/stale.txt");
      expect(orphan).toBeTruthy();
      expect(orphan.title).toBe(corrupted.title);

      // idempotent: the orphaned key is invisible to every check from here
      // on (it's not referenced by any list, tag or the menu any more).
      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
      expect(await getEntry(blog.id, "/stale.txt")).toBeTruthy();
    });

    it("fixes a stale id that appears in several lists at once (a page is in both 'all' and 'pages')", async function () {
      const blog = this.blog;
      await blog.write({ path: "/stale-page.txt", content: "Page: yes\n\n# Stale page" });
      await blog.rebuild();

      await corruptEntryRaw(blog.id, "/stale-page.txt", (entry) => {
        entry.id = "/stale-page-real.txt";
      });

      const report = await fixAsync(blog);

      expect(report["list-ghosts"]).toEqual(
        jasmine.arrayContaining([
          ["all", "MISMATCH", "/stale-page.txt"],
          ["pages", "MISMATCH", "/stale-page.txt"],
        ])
      );

      const lists = await allLists(blog.id);
      expect(lists.all).toContain("/stale-page-real.txt");
      expect(lists.pages).toContain("/stale-page-real.txt");
      expect(lists.all).not.toContain("/stale-page.txt");
      expect(lists.pages).not.toContain("/stale-page.txt");
    });
  });

  // ---------------------------------------------------------------------
  // 4. tag-ghosts
  // ---------------------------------------------------------------------

  describe("tag-ghosts", function () {
    it("removes a tag member whose entry key is missing entirely (and list-ghosts's pruneMissing does not race it out from under it)", async function () {
      const blog = this.blog;
      await blog.write({ path: "/tagged-ghost.txt", content: "Tags: sunshine\n\n# Tagged" });
      await blog.rebuild();

      expect(await tagMembers(blog.id, "sunshine")).toContain("/tagged-ghost.txt");

      await client.del(Entry.key.entry(blog.id, "/tagged-ghost.txt"));

      const report = await fixAsync(blog);

      expect(report["tag-ghosts"]).toEqual([["MISSING", "/tagged-ghost.txt"]]);
      expect(await tagMembers(blog.id, "sunshine")).not.toContain("/tagged-ghost.txt");

      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });

    it("re-keys a tag member stored under a stale id", async function () {
      const blog = this.blog;
      await blog.write({ path: "/chair.txt", content: "Tags: chairs\n\n# Chair" });
      await blog.rebuild();

      await corruptEntryRaw(blog.id, "/chair.txt", (entry) => {
        entry.id = "/chair-real.txt";
      });

      const report = await fixAsync(blog);

      expect(report["tag-ghosts"]).toEqual([["MISMATCH", "/chair.txt", "/chair-real.txt"]]);

      const members = await tagMembers(blog.id, "chairs");
      expect(members).toContain("/chair-real.txt");
      expect(members).not.toContain("/chair.txt");
    });

    // current behaviour (bug): a single entry's tags all share ONE reverse
    // key, Tags.key.entry(blogID, entry.id) - eg. an entry tagged alpha,
    // beta and gamma has one Redis set at .../tags:entry:<id> containing
    // all three slugs, not one set per tag. When tag-ghosts finds a stale
    // id it renames that whole reverse key from the old id to the new id
    // as part of repairing the FIRST tag it processes. Every subsequent
    // tag that also references the same stale id then tries to rename the
    // same reverse key again - but it was already renamed away, so Redis
    // returns "no such key", the transaction's exec() rejects, and that
    // error propagates all the way out of Fix() uncaught. A single entry
    // that is stale in more than one tag therefore makes the *entire*
    // Fix() run fail with an error instead of repairing anything, rather
    // than cleanly fixing all three tags.
    it("errors out instead of cleanly repairing a stale id that is shared by more than one tag", async function () {
      const blog = this.blog;
      await blog.write({
        path: "/multi-tag.txt",
        content: "Tags: alpha, beta, gamma\n\n# Multi tag",
      });
      await blog.rebuild();

      await corruptEntryRaw(blog.id, "/multi-tag.txt", (entry) => {
        entry.id = "/multi-tag-real.txt";
      });

      await expectAsync(fixAsync(blog)).toBeRejected();

      // Whichever tag tag-ghosts happened to repair first before erroring
      // out is left pointing at the real id; the others are left stale.
      const bySlug = {};
      for (const tag of ["alpha", "beta", "gamma"]) {
        bySlug[tag] = await tagMembers(blog.id, tag);
      }
      const repairedCount = Object.values(bySlug).filter((members) =>
        members.includes("/multi-tag-real.txt")
      ).length;
      const staleCount = Object.values(bySlug).filter((members) =>
        members.includes("/multi-tag.txt")
      ).length;
      expect(repairedCount).toBe(1);
      expect(staleCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // 5. menu-ghosts
  // ---------------------------------------------------------------------

  describe("menu-ghosts", function () {
    it("removes a menu item whose entry was marked deleted outside the normal drop path", async function () {
      const blog = this.blog;
      await blog.write({ path: "/menu-page.txt", content: "Page: yes\n\n# Menu page" });
      await blog.rebuild();

      expect((await getBlog(blog.id)).menu.map((i) => i.id)).toContain("/menu-page.txt");

      // Raw corruption again: mark deleted without going through Entry.set,
      // which would otherwise clean the menu up itself via _assign.js's
      // dropFromMenu - that's exactly the maintenance path menu-ghosts
      // exists to catch when it doesn't run.
      await corruptEntryRaw(blog.id, "/menu-page.txt", (entry) => {
        entry.deleted = true;
      });

      const report = await fixAsync(blog);

      expect(report["menu-ghosts"]).toEqual([
        ["Delete", jasmine.objectContaining({ id: "/menu-page.txt" })],
      ]);

      const menu = (await getBlog(blog.id)).menu;
      expect(menu.map((i) => i.id)).not.toContain("/menu-page.txt");
    });

    it("removes a duplicate menu item pointing at the same entry", async function () {
      const blog = this.blog;
      await blog.write({ path: "/dup.txt", content: "Page: yes\n\n# Duplicated" });
      await blog.rebuild();

      const blogBefore = await getBlog(blog.id);
      const original = blogBefore.menu.find((i) => i.id === "/dup.txt");
      const duplicate = Object.assign({}, original, { label: "Duplicate link" });

      await promisify(Blog.set)(blog.id, {
        menu: blogBefore.menu.concat([duplicate]),
      });

      const report = await fixAsync(blog);

      expect(report["menu-ghosts"]).toEqual([
        ["Delete duplicate", jasmine.objectContaining({ label: "Duplicate link" })],
      ]);

      const menu = (await getBlog(blog.id)).menu;
      expect(menu.filter((i) => i.id === "/dup.txt").length).toBe(1);
      expect(menu.find((i) => i.id === "/dup.txt").label).toBe(original.label);
    });

    it("updates a stale label, url and metadata to match the current entry", async function () {
      const blog = this.blog;
      await blog.write({ path: "/renamed-page.txt", content: "Page: yes\n\n# New Title" });
      await blog.rebuild();

      const blogBefore = await getBlog(blog.id);
      const menu = blogBefore.menu.map((item) =>
        item.id === "/renamed-page.txt"
          ? Object.assign({}, item, {
              label: "Old Title",
              url: "/old-url",
              metadata: { stale: true },
            })
          : item
      );
      await promisify(Blog.set)(blog.id, { menu });

      const report = await fixAsync(blog);

      expect(report["menu-ghosts"]).toEqual(
        jasmine.arrayContaining([
          ["Changed label of", jasmine.objectContaining({ label: "New Title" })],
          ["Changed URL of", jasmine.any(Object)],
          ["Changed metadata of", jasmine.any(Object)],
        ])
      );

      const item = (await getBlog(blog.id)).menu.find(
        (i) => i.id === "/renamed-page.txt"
      );
      const entry = await getEntry(blog.id, "/renamed-page.txt");
      expect(item.label).toBe(entry.title);
      expect(item.url).toBe(entry.url);
      expect(item.metadata).toEqual(entry.metadata);
    });
  });

  // ---------------------------------------------------------------------
  // 6. entries-path-index
  // ---------------------------------------------------------------------

  describe("entries-path-index", function () {
    it("backfills the path index when its count no longer matches the entries list", async function () {
      const blog = this.blog;
      await blog.write({ path: "/indexed-one.txt", content: "# One" });
      await blog.write({ path: "/indexed-two.txt", content: "# Two" });
      await blog.rebuild();

      const entriesCount = await client.zCard(listKey(blog.id, "entries"));
      await client.zRem(pathIndex.lexKey(blog.id), "/indexed-one.txt");

      const report = await fixAsync(blog);

      expect(report["entries-path-index"]).toEqual([
        ["MISMATCH", { entries: entriesCount, pathIndex: entriesCount - 1 }],
        ["BACKFILLED", entriesCount],
      ]);

      const ids = await pathIndexIds(blog.id);
      expect(ids).toEqual(await listIds(blog.id, "entries"));

      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });
  });

  // ---------------------------------------------------------------------
  // 7. Interactions
  // ---------------------------------------------------------------------

  describe("interactions between checks", function () {
    it("fully cleans up an entry-ghosts drop that also had tags, list membership and a menu entry, because Entry.drop already routes through the same tag/list machinery", async function () {
      const blog = this.blog;
      await blog.write({
        path: "/combo-ghost.txt",
        content: "Tags: combo\n\n# Combo ghost",
      });
      await blog.rebuild();

      expect(await tagMembers(blog.id, "combo")).toContain("/combo-ghost.txt");

      await blog.remove("/combo-ghost.txt");

      const report = await fixAsync(blog);

      expect(Object.keys(report)).toEqual(["entry-ghosts"]);

      const entry = await getEntry(blog.id, "/combo-ghost.txt");
      expect(entry.deleted).toBe(true);
      expect(await tagMembers(blog.id, "combo")).not.toContain("/combo-ghost.txt");
      expect(await listIds(blog.id, "entries")).not.toContain("/combo-ghost.txt");

      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });

    it("leaves the menu pointing at an orphaned copy of a stale-id entry after tag-ghosts and list-ghosts repair the tag and lists (current behaviour)", async function () {
      const blog = this.blog;
      await blog.write({
        path: "/combo.txt",
        content: "Page: yes\nTags: combo2\n\n# Combo",
      });
      await blog.rebuild();

      const original = await getEntry(blog.id, "/combo.txt");
      const menuItemBefore = (await getBlog(blog.id)).menu.find(
        (i) => i.id === "/combo.txt"
      );
      expect(menuItemBefore).toBeTruthy();

      await corruptEntryRaw(blog.id, "/combo.txt", (entry) => {
        entry.id = "/combo-real.txt";
      });

      const report = await fixAsync(blog);

      // tag-ghosts and list-ghosts both fire, menu-ghosts finds nothing to
      // change because Entry.get(item.id) still resolves - against the
      // orphaned copy still sitting under the old key.
      expect(report["tag-ghosts"]).toEqual([["MISMATCH", "/combo.txt", "/combo-real.txt"]]);
      expect(report["list-ghosts"]).toEqual(
        jasmine.arrayContaining([["all", "MISMATCH", "/combo.txt"]])
      );
      expect(report["menu-ghosts"]).toBeUndefined();

      expect(await tagMembers(blog.id, "combo2")).toEqual(["/combo-real.txt"]);
      const lists = await allLists(blog.id);
      expect(lists.all).toContain("/combo-real.txt");
      expect(lists.all).not.toContain("/combo.txt");

      // current behaviour: the menu item still has the stale id, and the
      // orphaned entry under that id is still sitting in Redis, untouched.
      const menuAfter = (await getBlog(blog.id)).menu.find(
        (i) => i.url === original.url
      );
      expect(menuAfter.id).toBe("/combo.txt");
      expect(await getEntry(blog.id, "/combo.txt")).toBeTruthy();

      // idempotent from here: nothing left for any check to find.
      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });
  });

  // ---------------------------------------------------------------------
  // 8. Larger blog
  // ---------------------------------------------------------------------

  describe("a larger blog", function () {
    global.test.timeout(60 * 1000);

    it("Fix() is a no-op on a clean 200+ entry blog, and touches only the entries that were corrupted", async function () {
      const blog = this.blog;
      const TOTAL = 220;

      for (let i = 0; i < TOTAL; i++) {
        const tags = ["group-" + (i % 5), "group-" + (i % 7)];
        await blog.write({
          path: "/bulk-" + i + ".txt",
          content: "Tags: " + tags.join(", ") + "\n\n# Post " + i,
        });
      }

      await blog.rebuild();

      const cleanReport = await fixAsync(blog);
      expect(cleanReport).toEqual({});

      // Corrupt a handful of entries in different ways.
      await blog.remove("/bulk-1.txt"); // entry-ghosts: missing file
      await blog.remove("/bulk-2.txt");
      await corruptEntryRaw(blog.id, "/bulk-3.txt", (entry) => {
        entry.id = "/bulk-3-real.txt";
      }); // tag-ghosts + list-ghosts: stale id
      await corruptEntryRaw(blog.id, "/bulk-4.txt", (entry) => {
        entry.id = "/bulk-4-real.txt";
      });

      const report = await fixAsync(blog);

      const missingReport = report["entry-ghosts"].find((row) =>
        Array.isArray(row)
      );
      expect(missingReport.length).toBe(2);
      expect(missingReport.map((r) => r.path).sort()).toEqual([
        "/bulk-1.txt",
        "/bulk-2.txt",
      ]);

      const listMismatches = report["list-ghosts"].filter(
        (row) => row[0] === "entries" || row[0] === "all"
      );
      expect(
        listMismatches.some((row) => row[2] === "/bulk-3.txt")
      ).toBe(true);
      expect(
        listMismatches.some((row) => row[2] === "/bulk-4.txt")
      ).toBe(true);

      expect(await getEntry(blog.id, "/bulk-1.txt")).toEqual(
        jasmine.objectContaining({ deleted: true })
      );
      expect(await getEntry(blog.id, "/bulk-2.txt")).toEqual(
        jasmine.objectContaining({ deleted: true })
      );
      expect(await getEntry(blog.id, "/bulk-3-real.txt")).toBeTruthy();
      expect(await getEntry(blog.id, "/bulk-4-real.txt")).toBeTruthy();

      // Every untouched entry is unaffected.
      const untouched = await getEntry(blog.id, "/bulk-100.txt");
      expect(untouched.deleted).toBe(false);

      const secondReport = await fixAsync(blog);
      expect(secondReport).toEqual({});
    });
  });
});
