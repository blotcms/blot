const identifyNameServers = require("../identifyNameServers"); // Adjust the path as necessary

describe("identifyNameServers", () => {
  it("should return null for empty nameserver list", () => {
    const result = identifyNameServers([]);
    expect(result).toBeNull();
  });

  it("should return null for nameservers with no matching provider", () => {
    const nsAddresses = [
      "ns1.unknown-provider.com",
      "ns2.unknown-provider.com",
    ];
    const result = identifyNameServers(nsAddresses);
    expect(result).toBeNull();
  });

  it("should return the correct provider for a known nameserver domain", () => {
    const nsAddresses = ["ns1.cloudflare.com", "ns2.cloudflare.com"];
    const result = identifyNameServers(nsAddresses);
    expect(result).toEqual({
      domain: "cloudflare.com",
      name: "Cloudflare",
      id: "cloudflare",
      URL: "https://www.cloudflare.com/",
    });
  });

  it("should return the correct provider for a known nameserver regex", () => {
    const nsAddresses = ["ns-123.awsdns-45.com"];
    const result = identifyNameServers(nsAddresses);
    expect(result).toEqual({
      domainRegEx: /awsdns-\d+.com/,
      name: "Amazon Web Services",
      id: "aws",
      URL: "https://aws.amazon.com/",
    });
  });

  it("should return the correct provider for nameserver with subdomain", () => {
    const nsAddresses = ["ns1.subdomain.cloudflare.com"];
    const result = identifyNameServers(nsAddresses);
    expect(result).toEqual({
      domain: "cloudflare.com",
      name: "Cloudflare",
      id: "cloudflare",
      URL: "https://www.cloudflare.com/",
    });
  });

  it("should handle invalid domain addresses gracefully", () => {
    const nsAddresses = ["invalid-domain"];
    const result = identifyNameServers(nsAddresses);
    expect(result).toBeNull();
  });

  it("should return the first matching provider for multiple matching nameservers", () => {
    const nsAddresses = ["ns1.cloudflare.com", "ns-123.awsdns-45.com"];
    const result = identifyNameServers(nsAddresses);
    expect(result).toEqual({
      domain: "cloudflare.com",
      name: "Cloudflare",
      id: "cloudflare",
      URL: "https://www.cloudflare.com/",
    });
  });
});
