const { parse } = require("tldts");

const nameserverProviders = [
  {
    domain: "123-reg.co.uk",
    name: "123-reg",
    id: "123reg",
    URL: "https://www.123-reg.co.uk/",
  },
  {
    domain: "bluehost.com",
    name: "Bluehost",
    id: "bluehost",
    URL: "https://www.bluehost.com/",
  },
  {
    domain: "dnsmadeeasy.com",
    name: "DNS Made Easy",
    id: "dnsmadeeasy",
    URL: "https://www.dnsmadeeasy.com/",
  },
  {
    domain: "domain.com",
    name: "Domain.com",
    id: "domaincom",
    URL: "https://www.domain.com/",
  },
  {
    domain: "name-services.com",
    name: "eNom",
    id: "enom",
    URL: "https://www.enom.com/",
  },
  {
    domain: "cloudflare.com",
    name: "Cloudflare",
    id: "cloudflare",
    URL: "https://www.cloudflare.com/",
  },
  {
    domain: "domaincontrol.com",
    name: "GoDaddy",
    id: "godaddy",
    URL: "https://www.godaddy.com/",
  },
  {
    domain: "googledomains.com",
    name: "Google Domains",
    id: "googledomains",
    URL: "https://domains.google/",
  },
  {
    domain: "hostmonster.com",
    name: "HostMonster",
    id: "hostmonster",
    URL: "https://www.hostmonster.com/",
  },
  {
    domain: "hover.com",
    name: "Hover",
    id: "hover",
    URL: "https://www.hover.com/",
  },
  {
    domain: "gandi.net",
    name: "Gandi",
    id: "gandi",
    URL: "https://www.gandi.net/",
  },
  {
    domain: "mediatemple.net",
    name: "Media Temple",
    id: "mediatemple",
    URL: "https://mediatemple.net/",
  },
  {
    domain: "rackspace.com",
    name: "Rackspace",
    id: "rackspace",
    URL: "https://www.rackspace.com/",
  },
  {
    domain: "register.com",
    name: "Register.com",
    id: "registercom",
    URL: "https://www.register.com/",
  },
  {
    domain: "registrar-servers.com",
    name: "Namecheap",
    id: "namecheap",
    URL: "https://www.namecheap.com/",
  },
  {
    domainRegEx: /awsdns-\d+.com/,
    name: "Amazon Web Services",
    id: "aws",
    URL: "https://aws.amazon.com/",
  },
];

const identifyNameServers = (nsAddresses) => {
  for (const address of nsAddresses) {
    const parsed = parse(address);

    if (!parsed || !parsed.domain) {
      continue;
    }

    const domain = parsed.domain;

    // Find matching provider by domain or domainRegEx
    for (const provider of nameserverProviders) {
      if (provider.domain && domain.endsWith(provider.domain)) {
        return provider;
      }
      if (provider.domainRegEx && provider.domainRegEx.test(domain)) {
        return provider;
      }
    }
  }

  return null;
};

module.exports = identifyNameServers;
