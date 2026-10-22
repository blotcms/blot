describe("scheduler renew-wildcard-ssl", function () {
  const crypto = require("crypto");
  const renew = require("../renew-wildcard-ssl");

  const DAY = 24 * 60 * 60 * 1000;
  const HOST = "blot.test";

  // A self-signed certificate for blot.test and *.blot.test, valid until
  // 2126, and its private key (generated for this spec, used nowhere else).
  const PEM = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBoTCCAUigAwIBAgIUSosXqqtnqGjm3jP/fRLBUXu+ruYwCgYIKoZIzj0EAwIw",
    "FDESMBAGA1UEAwwJYmxvdC50ZXN0MCAXDTI2MTAxNjE0MjAzNVoYDzIxMjYwOTIy",
    "MTQyMDM1WjAUMRIwEAYDVQQDDAlibG90LnRlc3QwWTATBgcqhkjOPQIBBggqhkjO",
    "PQMBBwNCAAQ2Uw6ZTA4PhJcW52SFKBOgLgxu3jUr3Wuuk8a1KecFwvIjR7Xhw3W1",
    "6BLFmoFHZlPCYXG9LRYWXyZOJ9VRGC3to3YwdDAdBgNVHQ4EFgQU+YWnnDUTvsGR",
    "Ye/D+iJAQrs3BTMwHwYDVR0jBBgwFoAU+YWnnDUTvsGRYe/D+iJAQrs3BTMwDwYD",
    "VR0TAQH/BAUwAwEB/zAhBgNVHREEGjAYgglibG90LnRlc3SCCyouYmxvdC50ZXN0",
    "MAoGCCqGSM49BAMCA0cAMEQCIBvPoVtuptTk4/oTgeJib7iqd2s1Jg9PrDWgwvia",
    "xgTtAiBIovKjQBSKY1C4n/e7xMQ5SWMYMJcRs3oxdv23ENZRXQ==",
    "-----END CERTIFICATE-----",
    "",
  ].join("\n");

  const CERT_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLGksTtUukjS6bFvm",
    "QdHGV34EckBPJcPb9kON1PPyVqihRANCAAQ2Uw6ZTA4PhJcW52SFKBOgLgxu3jUr",
    "3Wuuk8a1KecFwvIjR7Xhw3W16BLFmoFHZlPCYXG9LRYWXyZOJ9VRGC3t",
    "-----END PRIVATE KEY-----",
    "",
  ].join("\n");

  const EXPIRES = Date.parse(new crypto.X509Certificate(PEM).validTo);
  const KEY = "-----BEGIN PRIVATE KEY-----\nNEW-KEY\n-----END PRIVATE KEY-----";

  // Redis keys the proxy reads
  const PEM_KEY = "blot:openresty:ssl:pem";
  const KEY_KEY = "blot:openresty:ssl:key";
  const UPDATED_KEY = "blot:openresty:ssl:updated";

  function fakeRedis(initial = {}) {
    const store = new Map(Object.entries(initial));
    return {
      store,
      get: async (key) => (store.has(key) ? store.get(key) : null),
      set: async (key, value, options) => {
        if (options && options.NX && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      multi() {
        const writes = [];
        const chain = {
          set(key, value) {
            writes.push([key, value]);
            return chain;
          },
          exec: async () => writes.map(([key, value]) => store.set(key, value)),
        };
        return chain;
      },
    };
  }

  // Records the order of events, shared by the fake DNS and ACME client
  function fakes({ pem = PEM, failAt } = {}) {
    const events = [];
    const fail = (step) => {
      if (failAt === step) throw new Error("boom at " + step);
    };

    const challenge = (value) => ({ type: "dns-01", url: "chal-" + value });
    const authorizations = [
      { status: "pending", identifier: { value: HOST }, challenges: [challenge("a")] },
      { status: "pending", identifier: { value: HOST }, challenges: [challenge("b")] },
    ];

    const dns = {
      set: async (name, values) => {
        events.push(["dns.set", name, values]);
        fail("dns.set");
      },
      remove: async (name, values) => events.push(["dns.remove", name, values]),
    };

    const acmeClient = {
      createAccount: async (options) => events.push(["createAccount", options]),
      createOrder: async (order) => {
        events.push(["createOrder", order.identifiers.map((i) => i.value)]);
        return { id: "order" };
      },
      getAuthorizations: async () => authorizations,
      getChallengeKeyAuthorization: async (c) => "value-" + c.url,
      completeChallenge: async (c) => {
        events.push(["completeChallenge", c.url]);
        fail("completeChallenge");
      },
      waitForValidStatus: async (c) => events.push(["waitForValidStatus", c.url]),
      finalizeOrder: async (order, csr) => {
        events.push(["finalizeOrder", csr]);
        fail("finalizeOrder");
        return order;
      },
      getCertificate: async () => pem,
    };

    const acme = {
      Client: function (options) {
        events.push(["Client", options]);
        return acmeClient;
      },
      crypto: {
        createPrivateKey: async () => Buffer.from("ACCOUNT-KEY"),
        createPrivateEcdsaKey: async () => Buffer.from("ECDSA-KEY"),
        createCsr: async (data, key) => [
          Buffer.from(KEY),
          Buffer.from("CSR:" + data.altNames + ":" + key),
        ],
      },
    };

    return { events, dns, acme };
  }

  const names = (events) => events.map((e) => e[0]);

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err.message;
    }
    throw new Error("expected a rejection");
  }

  describe("renewal decision", function () {
    it("leaves a certificate with more than 30 days left alone", async function () {
      const client = fakeRedis({ [PEM_KEY]: PEM, [KEY_KEY]: CERT_KEY });
      const { events, dns, acme } = fakes();

      const result = await renew({ client, dns, acme, host: HOST, now: EXPIRES - 31 * DAY });

      expect(result).toEqual({ renewed: false, daysLeft: 31 });
      expect(events).toEqual([]);
      expect(client.store.get(KEY_KEY)).toEqual(CERT_KEY);
    });

    it("renews a certificate whose key is missing or does not match it", async function () {
      const other = crypto
        .generateKeyPairSync("ec", { namedCurve: "P-256" })
        .privateKey.export({ type: "pkcs8", format: "pem" });

      for (const key of [undefined, "garbage", other]) {
        const initial = { [PEM_KEY]: PEM };
        if (key !== undefined) initial[KEY_KEY] = key;
        const { dns, acme } = fakes();

        const result = await renew({
          client: fakeRedis(initial),
          dns,
          acme,
          host: HOST,
          now: EXPIRES - 80 * DAY,
        });

        expect(result.renewed).toBe(true);
      }
    });

    it("renews a certificate with 30 days or fewer left", async function () {
      const client = fakeRedis({ [PEM_KEY]: PEM, [KEY_KEY]: CERT_KEY });
      const { dns, acme } = fakes();

      const result = await renew({ client, dns, acme, host: HOST, now: EXPIRES - 30 * DAY });

      expect(result.renewed).toBe(true);
    });

    it("renews when there is no certificate, or it cannot be parsed", async function () {
      for (const initial of [{}, { [PEM_KEY]: "garbage" }]) {
        const { dns, acme } = fakes();
        const result = await renew({
          client: fakeRedis(initial),
          dns,
          acme,
          host: HOST,
          now: EXPIRES - 1000 * DAY,
        });

        expect(result.renewed).toBe(true);
      }
    });

    it("renews a healthy certificate when forced", async function () {
      const { dns, acme } = fakes();
      const result = await renew({
        client: fakeRedis({ [PEM_KEY]: PEM }),
        dns,
        acme,
        host: HOST,
        now: EXPIRES - 80 * DAY,
        force: true,
      });

      expect(result.renewed).toBe(true);
    });
  });

  describe("issuing", function () {
    const NOW = EXPIRES - 10 * DAY;

    it("publishes both challenge values together, then completes, then cleans up", async function () {
      const { events, dns, acme } = fakes();

      await renew({ client: fakeRedis(), dns, acme, host: HOST, now: NOW });

      expect(names(events)).toEqual([
        "Client",
        "createAccount",
        "createOrder",
        "dns.set",
        "completeChallenge",
        "completeChallenge",
        "waitForValidStatus",
        "waitForValidStatus",
        "finalizeOrder",
        "dns.remove",
      ]);

      const set = events.find((e) => e[0] === "dns.set");
      expect(set[1]).toEqual("_acme-challenge.blot.test");
      expect(set[2]).toEqual(["value-chal-a", "value-chal-b"]);
      expect(events.find((e) => e[0] === "dns.remove")).toEqual([
        "dns.remove",
        set[1],
        set[2],
      ]);
      expect(events.find((e) => e[0] === "createOrder")[1]).toEqual(["*.blot.test", "blot.test"]);
    });

    it("requests the certificate with an ECDSA key", async function () {
      const { events, dns, acme } = fakes();

      await renew({ client: fakeRedis(), dns, acme, host: HOST, now: NOW });

      const finalize = events.find((e) => e[0] === "finalizeOrder");
      expect(String(finalize[1])).toContain(":ECDSA-KEY");
    });

    it("uses Let's Encrypt production unless the config says otherwise", async function () {
      const { events, dns, acme } = fakes();

      await renew({ client: fakeRedis(), dns, acme, host: HOST, now: NOW });

      const options = events.find((e) => e[0] === "Client")[1];
      expect(options.directoryUrl).toEqual(
        require("config").wildcardSSL.directoryUrl
      );
      expect(options.accountKey).toEqual("ACCOUNT-KEY");
    });

    it("writes the key, chain and updated time to Redis", async function () {
      const client = fakeRedis();
      const { dns, acme } = fakes();

      const result = await renew({ client, dns, acme, host: HOST, now: NOW });

      expect(client.store.get(KEY_KEY)).toEqual(KEY + "\n");
      expect(client.store.get(PEM_KEY)).toEqual(PEM);
      expect(client.store.get(UPDATED_KEY)).toEqual(String(Math.floor(NOW / 1000)));
      expect(result).toEqual({ renewed: true, daysLeft: 10 });
    });

    it("reuses the stored ACME account key, and stores a new one the first time", async function () {
      const first = fakeRedis();
      const a = fakes();
      await renew({ client: first, dns: a.dns, acme: a.acme, host: HOST, now: NOW });
      expect(first.store.get(renew.ACCOUNT_KEY)).toEqual("ACCOUNT-KEY");

      const second = fakeRedis({ [renew.ACCOUNT_KEY]: "STORED-KEY" });
      const b = fakes();
      await renew({ client: second, dns: b.dns, acme: b.acme, host: HOST, now: NOW });
      expect(b.events.find((e) => e[0] === "Client")[1].accountKey).toEqual("STORED-KEY");
    });

    for (const step of ["dns.set", "completeChallenge", "finalizeOrder"]) {
      it("removes the TXT record and leaves Redis alone when " + step + " fails", async function () {
        const client = fakeRedis({ [PEM_KEY]: "old" });
        const { events, dns, acme } = fakes({ failAt: step });

        const message = await rejection(renew({ client, dns, acme, host: HOST, now: NOW }));

        expect(message).toEqual("boom at " + step);

        expect(names(events)).toContain("dns.remove");
        expect(client.store.get(PEM_KEY)).toEqual("old");
        expect(client.store.has(KEY_KEY)).toBe(false);
      });
    }

    it("does not store a certificate which does not cover the host", async function () {
      const client = fakeRedis();
      const { dns, acme } = fakes();

      const message = await rejection(
        renew({ client, dns, acme, host: "other.test", now: NOW })
      );

      expect(message).toMatch(/does not cover/);

      expect(client.store.has(PEM_KEY)).toBe(false);
    });

    it("skips DNS when every authorization is already valid", async function () {
      const { events, dns, acme } = fakes();
      const original = acme.Client;
      acme.Client = function (options) {
        const client = original(options);
        client.getAuthorizations = async () => [{ status: "valid" }, { status: "valid" }];
        return client;
      };

      await renew({ client: fakeRedis(), dns, acme, host: HOST, now: NOW });

      expect(names(events)).not.toContain("dns.set");
      expect(names(events)).not.toContain("dns.remove");
    });
  });

  describe("route53Dns", function () {
    function fakeSdk(statuses) {
      const sent = [];
      class Command {
        constructor(input) {
          this.input = input;
        }
      }
      class ChangeResourceRecordSetsCommand extends Command {}
      class GetChangeCommand extends Command {}

      const client = {
        send: async (command) => {
          sent.push(command);
          if (command instanceof ChangeResourceRecordSetsCommand) {
            return { ChangeInfo: { Id: "/change/C1", Status: "PENDING" } };
          }
          return { ChangeInfo: { Id: command.input.Id, Status: statuses.shift() } };
        },
      };

      return { sent, sdk: { ChangeResourceRecordSetsCommand, GetChangeCommand }, client };
    }

    it("upserts one TXT record set with every value and waits for INSYNC", async function () {
      const { sent, sdk, client } = fakeSdk(["PENDING", "PENDING", "INSYNC"]);
      const sleeps = [];
      const dns = renew.route53Dns({
        sdk,
        client,
        zoneId: "Z123",
        sleep: async (ms) => sleeps.push(ms),
      });

      await dns.set("_acme-challenge.blot.test", ["one", "two"]);

      expect(sent[0].input).toEqual({
        HostedZoneId: "Z123",
        ChangeBatch: {
          Changes: [
            {
              Action: "UPSERT",
              ResourceRecordSet: {
                Name: "_acme-challenge.blot.test",
                Type: "TXT",
                TTL: 60,
                ResourceRecords: [{ Value: '"one"' }, { Value: '"two"' }],
              },
            },
          ],
        },
      });
      expect(sent.slice(1).map((c) => c.input)).toEqual([
        { Id: "/change/C1" },
        { Id: "/change/C1" },
        { Id: "/change/C1" },
      ]);
      expect(sleeps.length).toEqual(2);
    });

    it("deletes the same record set", async function () {
      const { sent, sdk, client } = fakeSdk([]);
      const dns = renew.route53Dns({ sdk, client, zoneId: "Z123" });

      await dns.remove("_acme-challenge.blot.test", ["one", "two"]);

      const change = sent[0].input.ChangeBatch.Changes[0];
      expect(change.Action).toEqual("DELETE");
      expect(change.ResourceRecordSet.ResourceRecords).toEqual([
        { Value: '"one"' },
        { Value: '"two"' },
      ]);
    });
  });
});
