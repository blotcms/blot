const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const execFile = require("util").promisify(require("child_process").execFile);

describe("Redis systemd configuration", function () {
  it("generates idempotent mount ordering and Redis restart settings", async function () {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blot-redis-units-"));
    const script = path.resolve(__dirname, "../scripts/install-service-overrides.sh");
    try {
      await execFile("bash", [script, dir]);
      const overridePath = path.join(dir,"redis6.service.d/override.conf");
      const mountPath = path.join(dir,"blot-redis-backups-mount.service");
      const override = await fs.readFile(overridePath,"utf8");
      const mount = await fs.readFile(mountPath,"utf8");
      const sections = text => Object.fromEntries(text.trim().split(/\n\n/).map(section => {
        const [name,...lines] = section.split("\n"); return [name,lines];
      }));
      expect(sections(override)["[Unit]"]).toEqual([
        "Requires=blot-redis-backups-mount.service", "After=blot-redis-backups-mount.service",
      ]);
      expect(sections(override)["[Service]"]).toEqual(["Restart=always"]);
      expect(sections(mount)["[Unit]"]).toContain("Before=redis6.service");
      expect(sections(mount)["[Service]"]).toContain("Type=oneshot");
      expect(sections(mount)["[Service]"]).toContain("ExecStart=/bin/bash /home/ec2-user/scripts/mount-instance-store.sh");
      expect(mount).not.toContain("User=");
      await execFile("bash", [script, dir]);
      expect(await fs.readFile(overridePath,"utf8")).toBe(override);
      expect(await fs.readFile(mountPath,"utf8")).toBe(mount);
    } finally { await fs.rm(dir,{recursive:true,force:true}); }
  });
});
