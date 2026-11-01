// The operations the server runs against a repository's store: push
// (receive-pack), materialize, and Blot's own one-file commit.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { layout, manifest: manifestModule } = require("../../../../app/clients/git/store");
const { mapLimit } = require("../../../../app/clients/git/store/limit");
const gitobj = require("./gitobj");
const { scanPack } = require("./packscan");
const { pkt, FLUSH } = require("./fetch");

const ZERO = "0".repeat(40);
const READ_CONCURRENCY = 8;

// Blobs are fetched this many at a time, which bounds the memory of the batch
const BATCH = 256;

function run(args, { cwd, env = {}, input, maxBuffer = 1024 ** 3 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error("git " + args.join(" ") + " failed: " + Buffer.concat(err).toString().trim().slice(0, 300)));
    });
    child.stdin.on("error", () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Writes `objects` ({ type, oid, data }) as loose objects under `dir`
async function writeLoose(dir, objects) {
  for (const { type, oid, data } of objects) {
    const file = path.join(dir, oid.slice(0, 2), oid.slice(2));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, zlib.deflateSync(Buffer.concat([Buffer.from(type + " " + data.length + "\0"), data]), { level: 1 }));
  }
}

// Adds the toxic which the run asked for at this point of a push, if any
async function inject(faults, point) {
  if (faults[point]) await require("./toxiproxy").add({ name: "fault-" + point, ...faults[point] });
}

function create({ store, cache, manifests, config, openRepo, faults }) {
  async function currentRepo() {
    const current = await manifests.read();
    return { current, repo: openRepo({ store, cache, manifest: current }) };
  }

  // ---- materialize -------------------------------------------------------
  //
  // Diffs two commits' trees by ranged reads, level by level (every tree of a
  // level is read in parallel), skipping identical subtrees by ID without
  // reading them; then reads the changed blobs and writes them to `sink`, a
  // directory standing in for the blog folder.
  async function materialize({ old, new: target, sink = true }) {
    const { repo } = await currentRepo();
    const started = Date.now();
    const treeOf = async (oid) => gitobj.parseCommit((await repo.read(oid)).data).tree;
    const [a, b] = await Promise.all([old ? treeOf(old) : null, treeOf(target)]);

    const changes = [];
    let level = [{ a, b, prefix: "" }];
    let levels = 0;
    let treesRead = 0;

    while (level.length) {
      levels++;
      await repo.prefetch(level.flatMap((pair) => [pair.a, pair.b].filter(Boolean)));
      const entries = await mapLimit(level, READ_CONCURRENCY, async (pair) => {
        const [x, y] = await Promise.all([
          pair.a ? repo.read(pair.a).then((r) => new Map(gitobj.parseTree(r.data).map((e) => [e.name, e]))) : new Map(),
          pair.b ? repo.read(pair.b).then((r) => new Map(gitobj.parseTree(r.data).map((e) => [e.name, e]))) : new Map(),
        ]);
        treesRead += (pair.a ? 1 : 0) + (pair.b ? 1 : 0);
        return { pair, x, y };
      });

      const next = [];
      for (const { pair, x, y } of entries) {
        for (const name of new Set([...x.keys(), ...y.keys()])) {
          const l = x.get(name);
          const r = y.get(name);
          if (l && r && l.oid === r.oid && l.mode === r.mode) continue;
          const lt = l && l.mode === "40000";
          const rt = r && r.mode === "40000";
          const p = pair.prefix + name;
          if (lt || rt) next.push({ a: lt ? l.oid : null, b: rt ? r.oid : null, prefix: p + "/" });
          if ((l && !lt) || (r && !rt)) {
            const kind = !l || lt ? "A" : !r || rt ? "D" : "M";
            changes.push({ kind, path: p, oid: r && !rt ? r.oid : null });
          }
        }
      }
      level = next;
    }

    const treeMs = Date.now() - started;
    let bytes = 0;
    const dir = sink ? await fsp.mkdtemp(path.join(config.cacheDir, "sink-")) : null;

    const wanted = changes.filter((c) => c.oid);
    for (let at = 0; at < wanted.length; at += BATCH) {
      const batch = wanted.slice(at, at + BATCH);
      await repo.prefetch(batch.map((c) => c.oid));
      await mapLimit(batch, READ_CONCURRENCY, async (change) => {
        const blob = await repo.reader.read(change.oid);
        if (!blob) throw new Error("Missing blob " + change.oid);
        bytes += blob.data.length;
        if (dir) {
          const file = path.join(dir, change.path);
          await fsp.mkdir(path.dirname(file), { recursive: true });
          await fsp.writeFile(file, blob.data);
        }
      });
      repo.forget();
    }
    if (dir) await fsp.rm(dir, { recursive: true, force: true });

    changes.sort((p, q) => (p.path < q.path ? -1 : 1));
    return {
      changes: changes.map((c) => c.kind + " " + c.path),
      count: changes.length,
      levels,
      treesRead,
      blobBytes: bytes,
      treeMs,
      ms: Date.now() - started,
      objectCache: repo.stats,
    };
  }

  // ---- Blot's one-file commit -------------------------------------------
  //
  // Hash the new blob, read the trees along its path by range, write the new
  // trees and the commit, write them as a small pack, upload it, swap the
  // manifest. All under the lock for the write itself (the swap), as the
  // design has it; reading the trees is done before.
  async function commit({ file, content, remove = false, message = "Update " + file }) {
    const started = Date.now();
    const { current, repo } = await currentRepo();
    const head = current.refs[current.head];
    const parent = head ? gitobj.parseCommit((await repo.read(head)).data) : { tree: null };

    const parts = file.split("/");
    const chain = [];
    let treeOid = parent.tree;
    for (let depth = 0; depth < parts.length; depth++) {
      const entries = treeOid ? gitobj.parseTree((await repo.read(treeOid)).data) : [];
      chain.push({ entries, name: parts[depth] });
      const next = entries.find((e) => e.name === parts[depth]);
      treeOid = next && next.mode === "40000" ? next.oid : null;
    }

    const pack = fs.mkdtempSync(path.join(config.cacheDir, "commit-"));
    const writer = gitobj.createPackWriter(path.join(pack, "new.pack"));
    const written = [];
    const cacheWrites = [];
    const emit = (type, body) => {
      const oid = gitobj.objectId(type, body);
      writer.whole(type, oid, body);
      written.push(oid);
      // the next commit reads these trees and this commit again
      if (type !== "blob") cacheWrites.push(cache.put(store.id + "/obj/" + oid, Buffer.concat([Buffer.from([{ commit: 1, tree: 2, tag: 4 }[type]]), body])));
      return oid;
    };

    let child = remove ? null : emit("blob", Buffer.from(content, "utf8"));
    for (let depth = parts.length - 1; depth >= 0; depth--) {
      const { entries, name } = chain[depth];
      const rest = entries.filter((e) => e.name !== name);
      if (child) rest.push({ name, mode: depth === parts.length - 1 ? "100644" : "40000", oid: child });
      child = rest.length ? emit("tree", gitobj.serializeTree(rest)) : null;
    }
    const tree = child || emit("tree", Buffer.alloc(0));
    const time = Math.floor(Date.now() / 1000);
    const commitOid = emit("commit", gitobj.serializeCommit({ tree, parents: head ? [head] : [], time, message }));

    const info = writer.finish();
    await Promise.all(cacheWrites);
    const name = info.name;
    await store.put(layout.packKey(name), await fsp.readFile(path.join(pack, "new.pack")));
    await store.put(layout.idxKey(name), info.idx);
    await fsp.rm(pack, { recursive: true, force: true });

    const refs = { ...current.refs, [current.head || "refs/heads/master"]: commitOid };
    const next = manifestModule.advance(current, {
      refs,
      head: current.head || "refs/heads/master",
      packs: [{ name, size: info.size, idxSize: info.idx.length, objects: info.objects }],
    });
    await manifests.swap({ base: current, next });
    return { commit: commitOid, objects: info.objects, packBytes: info.size, seq: next.seq, manifestBytes: manifestModule.serialize(next).length, ms: Date.now() - started };
  }

  // ---- receive-pack ------------------------------------------------------

  async function readCommands(req) {
    const source = req.headers["content-encoding"] === "gzip" ? req.pipe(zlib.createGunzip()) : req;
    const iterator = source[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0);
    const commands = [];
    let capabilities = "";

    for (;;) {
      while (buffer.length < 4) {
        const next = await iterator.next();
        if (next.done) throw new Error("The request ended before the commands");
        buffer = Buffer.concat([buffer, next.value]);
      }
      const length = parseInt(buffer.toString("latin1", 0, 4), 16);
      if (length === 0) {
        buffer = buffer.subarray(4);
        break;
      }
      while (buffer.length < length) {
        const next = await iterator.next();
        if (next.done) throw new Error("The request ended in a command");
        buffer = Buffer.concat([buffer, next.value]);
      }
      let line = buffer.subarray(4, length).toString("utf8").replace(/\n$/, "");
      buffer = buffer.subarray(length);
      const nul = line.indexOf("\0");
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      const [oldOid, newOid, ref] = line.split(" ");
      commands.push({ old: oldOid, new: newOid, ref });
    }
    return { commands, capabilities, rest: buffer, iterator };
  }

  function report(sideband, unpack, results) {
    const lines = [pkt("unpack " + unpack + "\n"), ...results.map((r) => pkt((r.error ? "ng " + r.ref + " " + r.error : "ok " + r.ref) + "\n")), FLUSH];
    const body = Buffer.concat(lines);
    return sideband ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), body])), FLUSH]) : body;
  }

  async function receive({ req, res }) {
    const facts = { scratch: 0 };
    const started = Date.now();
    const mark = (name) => (facts[name + "Ms"] = Date.now() - started);
    let reservation;
    let sideband = false;
    let commands = [];

    try {
      const parsed = await readCommands(req);
      commands = parsed.commands;
      sideband = /side-band-64k/.test(parsed.capabilities);
      const needsPack = commands.some((c) => c.new !== ZERO);

      let adoptedPack = null;
      if (needsPack) {
        // The incoming pack goes to scratch, which is reserved out of the cache's budget
        const declared = Number(req.headers["content-length"] || 0);
        reservation = await cache.reserve(Math.max(declared, 16 * 1024 * 1024));
        const incoming = path.join(reservation.dir, "incoming.pack");
        const out = fs.createWriteStream(incoming);
        let size = 0;
        const write = async (chunk) => {
          size += chunk.length;
          if (size > reservation.bytes) await reservation.extend(Math.max(chunk.length, 16 * 1024 * 1024));
          if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        };
        if (parsed.rest.length) await write(parsed.rest);
        for (;;) {
          const next = await parsed.iterator.next();
          if (next.done) break;
          await write(next.value);
        }
        await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
        facts.packBytesIn = size;
        mark("receive");

        // 1. which delta bases the pack needs and does not contain
        const buffer = await fsp.readFile(incoming);
        const scanned = scanPack(buffer);
        const wanted = [...scanned.bases].filter((oid) => !scanned.whole.has(oid));
        mark("scan");

        // 2. fetch those that the repository has, in a batch, into a scratch
        //    object directory which index-pack reads as an alternate
        const { current, repo } = await currentRepo();
        facts.baseCandidates = wanted.length;
        const bases = [];
        await repo.prefetch(wanted);
        await mapLimit(wanted, READ_CONCURRENCY, async (oid) => {
          const found = await repo.reader.read(oid);
          if (found) bases.push({ type: found.type, oid, data: found.data });
        });
        facts.basesFetched = bases.length;
        facts.baseBytes = bases.reduce((n, b) => n + b.data.length, 0);
        const alternates = path.join(reservation.dir, "bases");
        await writeLoose(alternates, bases);
        mark("bases");

        // 3. complete the pack with stock index-pack
        const gitDir = path.join(reservation.dir, "repo.git");
        await run(["init", "-q", "--bare", gitDir]);
        const indexed = (
          await run(["--git-dir=" + gitDir, "index-pack", "--stdin", "--fix-thin"], {
            input: buffer,
            env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates },
          })
        )
          .toString()
          .trim();
        const hash = indexed.split(/\s+/).pop();
        const packFile = path.join(gitDir, "objects", "pack", "pack-" + hash + ".pack");
        const idxFile = path.join(gitDir, "objects", "pack", "pack-" + hash + ".idx");
        mark("indexPack");

        // 4. connectivity, by index lookups. Every object in the repository
        //    is closed under what it points at, so what has to be checked is
        //    what the new commits introduce: each new commit's tree is
        //    compared with its first parent's, level by level, and only the
        //    entries which differ (and the parents) must be in the pack or
        //    in the repository. Entries which are the same as the parent's
        //    are known to be there.
        const listing = await run(["--git-dir=" + gitDir, "cat-file", "--batch-all-objects", "--batch"], { maxBuffer: 1024 ** 3 });
        const local = new Map();
        const everyReferent = new Set();
        let at = 0;
        while (at < listing.length) {
          const eol = listing.indexOf(10, at);
          const [oid, type, sizeText] = listing.toString("latin1", at, eol).split(" ");
          const length = Number(sizeText);
          const data = listing.subarray(eol + 1, eol + 1 + length);
          local.set(oid, type === "blob" ? { type } : { type, data: Buffer.from(data) });
          if (type === "commit") {
            const c = gitobj.parseCommit(data);
            everyReferent.add(c.tree);
            c.parents.forEach((p) => everyReferent.add(p));
          } else if (type === "tree") {
            for (const e of gitobj.parseTree(data)) if (e.mode !== "160000") everyReferent.add(e.oid);
          }
          at = eol + 1 + length + 1;
        }
        facts.referentsNaive = [...everyReferent].filter((oid) => !local.has(oid)).length;

        const toCheck = new Set();
        const anyObject = async (oid) => {
          const found = local.get(oid);
          return found && found.data ? found : repo.read(oid);
        };
        const entriesOf = (object) => new Map(gitobj.parseTree(object.data).map((e) => [e.name, e]));
        const seenPairs = new Set();
        let level = [];
        for (const [oid, object] of local) {
          if (object.type === "tag") toCheck.add(/^object (\w{40})/.exec(object.data.toString("latin1"))[1]);
          if (object.type !== "commit") continue;
          const c = gitobj.parseCommit(object.data);
          c.parents.forEach((p) => toCheck.add(p));
          toCheck.add(c.tree);
          const parent = c.parents[0] ? await anyObject(c.parents[0]) : null;
          level.push({ a: parent ? gitobj.parseCommit(parent.data).tree : null, b: c.tree });
        }
        while (level.length) {
          level = level.filter((pair) => !seenPairs.has(pair.a + ":" + pair.b) && seenPairs.add(pair.a + ":" + pair.b));
          await repo.prefetch(level.flatMap((pair) => [pair.a, pair.b]).filter((oid) => oid && !local.has(oid)));
          const next = [];
          for (const pair of level) {
            const newer = await anyObject(pair.b);
            if (!newer) continue;
            const older = pair.a ? await anyObject(pair.a) : null;
            const before = older ? entriesOf(older) : new Map();
            for (const [name, e] of entriesOf(newer)) {
              const was = before.get(name);
              if (e.mode === "160000" || (was && was.oid === e.oid && was.mode === e.mode)) continue;
              toCheck.add(e.oid);
              if (e.mode === "40000" && local.has(e.oid)) next.push({ a: was && was.mode === "40000" ? was.oid : null, b: e.oid });
            }
          }
          level = next;
        }

        const outside = [...toCheck].filter((oid) => !local.has(oid));
        const missing = [];
        await mapLimit(outside, READ_CONCURRENCY, async (oid) => {
          if (!(await repo.reader.has(oid))) missing.push(oid);
        });
        facts.newObjects = local.size;
        facts.referentsChecked = outside.length;
        if (missing.length) throw new Error("Missing objects: " + missing.slice(0, 3).join(" "));
        for (const c of commands) {
          if (c.new !== ZERO && !local.has(c.new) && !(await repo.reader.has(c.new))) throw new Error("Missing object for " + c.ref);
        }
        mark("connectivity");

        // 5. upload the pack and its index; nothing is acknowledged before this
        await inject(faults, "upload");
        const idx = await fsp.readFile(idxFile);
        const packSize = (await fsp.stat(packFile)).size;
        const name = "pack-" + hash;
        await store.put(layout.packKey(name), fs.createReadStream(packFile));
        await store.put(layout.idxKey(name), idx);
        facts.packBytesOut = packSize;
        mark("upload");
        adoptedPack = { name, size: packSize, idxSize: idx.length, objects: local.size, base: current };
      }

      // 6. the ref swap: the commands' old values must be the current ones
      const { current } = await currentRepo();
      const refs = { ...current.refs };
      const results = [];
      for (const c of commands) {
        const have = refs[c.ref] || ZERO;
        if (have !== c.old) results.push({ ref: c.ref, error: "stale info: the ref moved" });
        else {
          if (c.new === ZERO) delete refs[c.ref];
          else refs[c.ref] = c.new;
          results.push({ ref: c.ref });
        }
      }
      if (results.every((r) => r.error)) {
        res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
        res.end(report(sideband, "ok", results));
        return facts;
      }

      const next = manifestModule.advance(current, {
        refs,
        head: current.head || (refs["refs/heads/master"] ? "refs/heads/master" : current.head),
        packs: adoptedPack ? [{ name: adoptedPack.name, size: adoptedPack.size, idxSize: adoptedPack.idxSize, objects: adoptedPack.objects }] : [],
      });
      await manifests.swap({ base: current, next });
      mark("swap");
      facts.seq = next.seq;
      facts.manifestBytes = manifestModule.serialize(next).length;

      res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
      res.end(report(sideband, "ok", results));
      return facts;
    } catch (err) {
      // Never "ok": the client is told the push failed and why
      facts.error = err.message;
      if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
      res.end(
        report(sideband, err.message.replace(/\s+/g, " ").slice(0, 200), commands.map((c) => ({ ref: c.ref, error: "push failed" })))
      );
      return facts;
    } finally {
      if (reservation) await reservation.release();
    }
  }

  return { materialize, commit, receive };
}

module.exports = { create };
