const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  parseStorageOffsite,
  STORAGE_OFFSITE_KEY,
} = require("../../../app/scheduler/check-redis-host");

// Runs bin/offsite-sync.sh and bin/offsite-restore-test.sh against a fake
// root and fake rclone, aws, flock and redis6-cli. The fake rclone answers
// from files under fake/ and logs each call, with the remotes' settings it
// was given, to rclone-calls. The test image has no bash, so the scripts run
// under sh (they are written to work in both).
describe("storage offsite", function () {
  const BIN = path.join(__dirname, "..", "bin");
  const B2_SECRET = "b2-secret-for-tests";
  const S3_SECRET = "s3-secret-for-tests";
  let root;

  const file = (name) => path.join(root, name);
  const write = (name, text, mode) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), text);
    if (mode) fs.chmodSync(file(name), mode);
  };
  const stub = (name, body) =>
    write(`bin/${name}`, `#!/bin/sh\n${body}\n`, 0o755);
  const read = (name) =>
    fs.existsSync(file(name)) ? fs.readFileSync(file(name), "utf8") : "";
  const calls = () =>
    read("rclone-calls").trimEnd().split("\n").filter(Boolean);

  beforeEach(function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-"));

    write("tmp/.keep", "");
    write("etc/blot-redis/active", "");
    write("etc/blot/storage-offsite-bucket", "test-offsite\n");
    write(
      "etc/blot/secrets.env",
      [
        "BLOT_HOST=blot.test",
        "BLOT_STORAGE_BUCKET=test-storage",
        "BLOT_AWS_KEY=s3-key-id",
        `export BLOT_AWS_SECRET=${S3_SECRET}`,
        "",
      ].join("\n")
    );
    // Two blogs in the bucket; B2 also has a third that was deleted
    write("fake/source", "blog_a/\nblog_b/\n");
    write("fake/offsite", "blog_a/\nblog_b/\nblog_gone/\n");

    stub("flock", "exit 0");
    stub(
      "aws",
      `
case "$*" in
  "configure get aws_access_key_id --profile blot-b2-storage") [ -n "$NO_PROFILE" ] || echo b2-key-id ;;
  "configure get aws_secret_access_key --profile blot-b2-storage") [ -n "$NO_PROFILE" ] || echo ${B2_SECRET} ;;
  *) exit 1 ;;
esac
`
    );
    stub(
      "redis6-cli",
      `
case "$1" in
  SET) echo "$*" >> "${root}/redis-calls"; eval "\${SET_COMMAND:-:}" ;;
  GET) echo "$*" >> "${root}/redis-calls"
    case "$2" in handle:gittest) echo "\${GITTEST-blog_gt}" ;; *) echo "2026-11-05T02:40:00Z 10 1000" ;; esac ;;
  *) exit 1 ;;
esac
`
    );
    stub(
      "rclone",
      `
f=${root}/fake
echo "$* | config=$RCLONE_CONFIG s3=$RCLONE_CONFIG_STORAGE_TYPE,$RCLONE_CONFIG_STORAGE_PROVIDER,$RCLONE_CONFIG_STORAGE_REGION,$RCLONE_CONFIG_STORAGE_ACCESS_KEY_ID,$RCLONE_CONFIG_STORAGE_ENV_AUTH b2=$RCLONE_CONFIG_OFFSITE_TYPE,$RCLONE_CONFIG_OFFSITE_ACCOUNT,$RCLONE_CONFIG_OFFSITE_HARD_DELETE secrets=$([ "$RCLONE_CONFIG_STORAGE_SECRET_ACCESS_KEY" = ${S3_SECRET} ] && [ "$RCLONE_CONFIG_OFFSITE_KEY" = ${B2_SECRET} ] && echo set)" >> "${root}/rclone-calls"
for last; do :; done
prev=
for a; do [ "$prev" = --files-from-raw ] && cat "$a" >> "${root}/files-from.$1"; prev=$a; done
case "$1" in
  lsf)
    case "$*" in
      *storage:test-storage/blog_a/git/manifests) [ -z "$MANIFEST_LIST_FAILS" ] || { echo "AccessDenied" >&2; exit 1; }; printf "\${S3_MANIFESTS-0000000002.json\\n0000000003.json\\nlatest.json\\n}" ;;
      *offsite:test-offsite/storage/blog_a/git/manifests) printf '0000000001.json\n0000000002.json\nlatest.json\n' ;;
      */git/manifests) exit 3 ;;
      *--files-from-raw*) printf '2026-11-05 09:00:00  b.txt\\n' ;;
      *storage:*) [ -z "$LIST_FAILS" ] || { echo "AccessDenied" >&2; exit 1; }; cat "$f/source" ;;
      *storage/blog_a) printf 'folder/\\ngit/\\n' ;;
      *storage/blog_*) printf 'folder/\\n' ;;
      *) [ -e "$f/offsite" ] || exit 3; cat "$f/offsite" ;;
    esac ;;
  sync) case " $FAIL " in *" \${last##*/} "*) echo "ERROR : x.jpg: Failed to copy: 500" >&2; exit 1 ;; esac ;;
  size) echo '{"count":3,"bytes":1000000000000,"sizeless":0}' ;;
  delete) ;;
  cat)
    case "$last" in
      storage:test-storage/blog_a/git/manifests/latest.json) echo '{"seq":3}' ;;
      offsite:*/blog_a/git/manifests/latest.json) echo '{"seq":2}' ;;
      *) echo "not found" >&2; exit 1 ;;
    esac ;;
  rcat) cat >> "${root}/rcat" ;;
  copy) case "$last" in offsite:*) ;; *) mkdir -p "$last"; echo a > "$last/a.txt"; echo b > "$last/b.txt" ;; esac ;;
  check)
    while [ $# -gt 0 ]; do [ "$1" = --combined ] && out=$2; shift; done
    printf "\${CHECK:-= a.txt\\n= b.txt\\n}" > "$out"
    case "$CHECK" in *"*"* | *"+ "* | *"- "*) exit 1 ;; esac
    exit "\${CHECK_STATUS:-0}" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`
    );
  });

  afterEach(function () {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (script, args = [], env = {}) =>
    spawnSync("sh", [path.join(BIN, script), ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        BLOT_ROOT: root,
        TMPDIR: file("tmp"),
        PATH: path.join(root, "bin") + ":" + process.env.PATH,
        ...env,
      },
    });
  const sync = (args = ["--quick"], env) => run("offsite-sync.sh", args, env);

  describe("offsite-sync.sh", function () {
    it("syncs each blog to B2, hides a deleted one and records the copy", function () {
      const result = sync();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "quick sync of 2 blogs to B2 (1 gone from the bucket)"
      );
      expect(result.stdout).toContain("hid blog_gone, gone from the bucket");

      const syncs = calls().filter((c) => c.startsWith("sync "));
      expect(syncs.length).toBe(2);
      ["blog_a", "blog_b"].forEach((blog) => {
        const mine = syncs.filter((c) =>
          c.includes(
            ` storage:test-storage/${blog} offsite:test-offsite/storage/${blog} |`
          )
        );
        expect(mine.length).toBe(1);
        expect(mine[0]).toContain("--exclude /git/manifests/** ");
      });
      expect(
        calls().filter(
          (c) => c.startsWith("delete ") && !c.includes("--files-from-raw")
        )
      ).toEqual([
        jasmine.stringMatching(/ offsite:test-offsite\/storage\/blog_gone \|/),
      ]);

      const set = read("redis-calls").trim();
      expect(set).toMatch(
        /^SET blot:storage:offsite \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ 6 2000000000000$/
      );
      expect(STORAGE_OFFSITE_KEY).toBe("blot:storage:offsite");
      const record = parseStorageOffsite(set.split(" ").slice(2).join(" "));
      expect(record.objects).toBe(6);
      expect(record.bytes).toBe(2000000000000);
      expect(Math.abs(Date.now() - record.time)).toBeLessThan(60 * 1000);
      expect(result.stdout).toContain("done in");
    });

    it("copies a git blog's manifests listed before its packs, last, and hides the swept ones", function () {
      expect(sync().status).toBe(0);
      const order = calls()
        .filter(
          (c) =>
            c.includes("storage/blog_a") ||
            c.includes("storage:test-storage/blog_a")
        )
        .map((c) => c.split(" ")[0]);
      // latest.json and the list of manifests before the packs are synced,
      // then only the listed manifests, then latest.json as it was read
      expect(order.indexOf("cat")).toBeLessThan(order.indexOf("lsf"));
      expect(order.indexOf("lsf")).toBeLessThan(order.indexOf("sync"));
      expect(order.indexOf("sync")).toBeLessThan(order.indexOf("copy"));
      expect(order.indexOf("copy")).toBeLessThan(order.indexOf("rcat"));
      expect(read("files-from.copy")).toBe(
        "git/manifests/0000000002.json\ngit/manifests/0000000003.json\n"
      );
      expect(read("rcat")).toBe('{"seq":3}\n');
      expect(read("files-from.delete")).toBe("git/manifests/0000000001.json\n");
      // blog_b has no git store: no manifest copy, upload or hide
      expect(
        calls().filter(
          (c) => c.includes("blog_b") && /^(copy|rcat|delete) /.test(c)
        )
      ).toEqual([]);
    });

    it("leaves latest.json alone when B2's matches", function () {
      expect(
        sync([], { S3_MANIFESTS: "0000000002.json\\nlatest.json\\n" }).status
      ).toBe(0);
      expect(read("files-from.copy")).toBe("git/manifests/0000000002.json\n");
      expect(read("files-from.delete")).toBe("git/manifests/0000000001.json\n");
    });

    it("fails a blog, and hides none of its manifests, when its manifests cannot be listed", function () {
      const result = sync(["--quick"], { MANIFEST_LIST_FAILS: "1" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("blog_a: AccessDenied");
      expect(read("files-from.delete")).toBe("");
      expect(read("redis-calls")).toBe("");
    });

    it("builds the remotes from the environment, with the app's key and the B2 profile, and never hard deletes", function () {
      sync();

      calls().forEach((c) => {
        expect(c).toContain(
          "config=/dev/null s3=s3,AWS,us-west-2,s3-key-id,false b2=b2,b2-key-id,false secrets=set"
        );
        expect(c).not.toContain("hard-delete");
        expect(c).not.toMatch(/^purge /);
      });
    });

    it("never prints a key", function () {
      const result = sync([], { BLOT_STORAGE_OFFSITE_LOG_LEVEL: "INFO" });
      expect(result.stdout + result.stderr).not.toContain(B2_SECRET);
      expect(result.stdout + result.stderr).not.toContain(S3_SECRET);
    });

    it("compares by the times S3 lists daily, and reads each object's on --full", function () {
      sync(["--quick"]);
      calls()
        .filter((c) => c.startsWith("sync "))
        .forEach((c) =>
          expect(c).toContain(
            "--fast-list --transfers 4 --checkers 8 --bwlimit 10M"
          )
        );
      calls()
        .filter((c) => c.startsWith("sync "))
        .forEach((c) => expect(c).toContain("--update --use-server-modtime"));

      fs.rmSync(file("rclone-calls"));
      const result = sync(["--full"]);
      expect(result.stdout).toContain("full sync of 2 blogs");
      calls()
        .filter((c) => c.startsWith("sync "))
        .forEach((c) => {
          expect(c).not.toContain("--update");
          expect(c).not.toContain("--use-server-modtime");
          expect(c).not.toContain("--checksum");
        });
    });

    it("is off without a bucket file, and skips on a drill host or one not marked active", function () {
      fs.rmSync(file("etc/blot/storage-offsite-bucket"));
      let result = sync();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "off (no bucket in /etc/blot/storage-offsite-bucket)"
      );

      write("etc/blot/storage-offsite-bucket", "test-offsite\n");
      write("etc/blot/drill", "");
      result = sync();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("skipped: drill host");

      fs.rmSync(file("etc/blot/drill"));
      fs.rmSync(file("etc/blot-redis/active"));
      result = sync();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("not marked as the active host");

      expect(calls()).toEqual([]);
      expect(read("redis-calls")).toBe("");
    });

    it("fails, and records nothing, when a blog fails", function () {
      const result = sync(["--quick"], { FAIL: "blog_b" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("blog_b: ERROR : x.jpg: Failed to copy");
      expect(result.stdout).toContain("WARNING: 1 blogs failed");
      expect(result.stdout).toContain("blog_b");
      expect(read("redis-calls")).toBe("");
    });

    it("hides nothing, and fails, when too many blogs are gone", function () {
      const result = sync(["--quick"], { BLOT_STORAGE_OFFSITE_MAX_HIDE: "0" });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "1 blogs are in B2 but not in the bucket, more than 0: hiding none of them"
      );
      // Only blog_a's swept manifest, never a whole blog
      expect(
        calls().filter(
          (c) => c.startsWith("delete ") && !c.includes("--files-from-raw")
        )
      ).toEqual([]);
      expect(calls().filter((c) => c.startsWith("sync ")).length).toBe(2);
      expect(read("redis-calls")).toBe("");
    });

    it("refuses an empty or failed listing of the bucket", function () {
      write("fake/source", "");
      let result = sync();
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("lists no directories; refusing");

      result = sync([], { LIST_FAILS: "1" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "could not list the storage bucket: AccessDenied"
      );
      expect(calls().filter((c) => /^(sync|delete) /.test(c))).toEqual([]);
    });

    it("copies everything on the first run, when B2 has nothing yet", function () {
      fs.rmSync(file("fake/offsite"));
      const result = sync();
      expect(result.status).toBe(0);
      expect(calls().filter((c) => c.startsWith("sync ")).length).toBe(2);
    });

    it("fails without the B2 profile, saying so", function () {
      const result = sync([], { NO_PROFILE: "1" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(
        "WARNING: no blot-b2-storage profile with a key in ~/.aws/credentials"
      );
      expect(calls()).toEqual([]);
    });

    it("still succeeds when Redis refuses the record", function () {
      const result = sync([], { SET_COMMAND: "echo READONLY; exit 1" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("could not record the sync in Redis");
    });

    it("refuses an unknown option", function () {
      expect(sync(["--now"]).status).toBe(2);
    });
  });

  describe("offsite-restore-test.sh", function () {
    const restore = (args, env) => run("offsite-restore-test.sh", args, env);

    it("restores a blog's folder from B2 and finds it matches the bucket", function () {
      const result = restore(["blog_a"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Last recorded sync: 2026-11-05T02:40:00Z 10 1000"
      );
      expect(result.stdout).toContain("2 match");
      expect(result.stdout).toContain(
        "OK: the copy of blog_a/folder matches the bucket"
      );

      const copy = calls().find((c) => c.startsWith("copy "));
      expect(copy).toContain("offsite:test-offsite/storage/blog_a/folder ");
      const check = calls().find((c) => c.startsWith("check "));
      expect(check).toContain("--download");
      expect(check).toContain(" storage:test-storage/blog_a/folder ");
    });

    it("is read-only: no sync, delete or Redis write", function () {
      restore(["blog_a", "git"]);
      calls().forEach((c) => expect(c).toMatch(/^(copy|check|size|lsf) /));
      expect(calls().find((c) => c.startsWith("copy "))).toContain(
        "offsite:test-offsite/storage/blog_a/git "
      );
      expect(read("redis-calls").trim()).toBe("GET blot:storage:offsite");
      // The scratch directory is gone afterwards
      expect(
        fs
          .readdirSync(file("tmp"))
          .filter((f) => f.startsWith("blot-offsite-restore"))
      ).toEqual([]);
    });

    it("lists each difference with the bucket's time, and fails", function () {
      // rclone check: "+" is missing on the destination (the copy), "-"
      // missing on the source (the bucket)
      const result = restore(["blog_a"], {
        CHECK: "= a.txt\\n* b.txt\\n+ c.txt\\n- d.txt\\n",
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("1 match");
      expect(result.stdout).toContain("1 differ");
      expect(result.stdout).toContain("1 in the bucket but not in the copy");
      expect(result.stdout).toContain(
        "1 in the copy but no longer in the bucket"
      );
      expect(result.stdout).toContain("* b.txt  (bucket: 2026-11-05 09:00:00)");
      expect(result.stdout).toContain("+ c.txt");
      expect(result.stdout).toContain(
        "+ only in the bucket, - only in the copy"
      );
      expect(result.stdout).toContain("FAILED");
    });

    it("fails when rclone check stops part way, even with a clean report", function () {
      const result = restore(["blog_a"], { CHECK_STATUS: "143" });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("rclone check exited 143");
      expect(result.stdout).not.toContain("OK:");
    });

    it("keeps the restored files with --keep", function () {
      const result = restore(["--keep", "blog_a"]);
      const kept = result.stdout.match(/kept (\S+)/)[1];
      expect(fs.existsSync(path.join(kept, "restored", "a.txt"))).toBe(true);
    });

    it("refuses anything but a blog ID and a relative path", function () {
      expect(restore(["../etc"]).status).toBe(2);
      expect(restore(["blog_a/folder"]).status).toBe(2);
      expect(restore(["blog_a", "../blog_b"]).status).toBe(2);
      expect(restore([]).status).toBe(2);
      expect(restore(["--git", "../etc"]).status).toBe(2);
      expect(restore(["--git", "--sample", "x"]).status).toBe(2);
      expect(calls()).toEqual([]);
    });

    describe("--git", function () {
      // A fake docker: the unit has the checker unless NO_CHECKER is set,
      // and the checker exits CHECK_STATUS after recording what it was given
      // and which repositories it found.
      beforeEach(function () {
        write("var/instance-ssd/tmp/.keep", "");
        stub(
          "docker",
          `
echo "$*" >> "${root}/docker-calls"
case "$*" in
  "exec -u 1000 blot-blue test -f scripts/git/check-store.js") [ -z "$NO_CHECKER" ] ;;
  "exec -u 1000 blot-blue node scripts/git/check-store.js --dir "*" --all-blogs --deep --scratch "*)
    dir=$8; ls "$dir" > "${root}/checked"
    for repo in "$dir"/*; do [ -f "$repo/git/a.txt" ] || exit 3; done
    exit \${CHECK_STATUS:-0} ;;
  *) exit 99 ;;
esac
`
        );
      });

      it("restores the named, gittest and sampled git blogs' repositories and runs the store check on them", function () {
        const result = restore(["--git", "blog_named"]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Sampled 1 git blogs from B2");
        expect(result.stdout).toContain(
          "OK: the restored repositories pass the store check"
        );
        // blog_a is the only blog in B2 with a git/ directory
        expect(read("checked").trim().split("\n")).toEqual([
          "blog_a",
          "blog_gt",
          "blog_named",
        ]);
        ["blog_a", "blog_gt", "blog_named"].forEach((blog) =>
          expect(
            calls().some(
              (c) =>
                c.startsWith(`copy `) &&
                c.includes(` offsite:test-offsite/storage/${blog}/git `)
            )
          ).toBe(true)
        );
        const dir = read("docker-calls").match(/--dir (\S+)/)[1];
        expect(
          dir.startsWith(file("var/instance-ssd/tmp/blot-offsite-restore."))
        ).toBe(true);
        expect(dir).toMatch(/\/repos$/);
        // Deep clones go to scratch space beside it, on the instance store
        const scratch = read("docker-calls").match(/--scratch (\S+)/)[1];
        expect(scratch).toBe(dir.replace(/\/repos$/, "/scratch"));
        expect(fs.existsSync(dir)).toBe(false);
      });

      it("is read-only", function () {
        restore(["--git"]);
        calls().forEach((c) => expect(c).toMatch(/^(copy|lsf) /));
        expect(read("redis-calls").trim().split("\n")).toEqual([
          "GET handle:gittest",
          "GET blot:storage:offsite",
        ]);
      });

      it("fails with the checker's findings, saying to rerun after the next sync", function () {
        const result = restore(["--git"], { CHECK_STATUS: "1" });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("rerun after the next sync");
      });

      it("is skipped, with a message, when the unit has no checker", function () {
        const result = restore(["--git"], { NO_CHECKER: "1" });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          "Skipped: blot-blue has no scripts/git/check-store.js"
        );
        expect(calls()).toEqual([]);
      });

      it("works without a gittest blog or a sample", function () {
        const result = restore(["--git", "--sample", "0", "blog_named"], {
          GITTEST: "",
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("No gittest blog in Redis");
        expect(read("checked").trim()).toBe("blog_named");
      });
    });
  });
});
