// There are a few ways to point a domain to a blog on Blot
// You can create:
// A record pointing to 'ip'
// CNAME record pointing to 'host'
// ALIAS record pointing to 'host'
// Use Cloudflare or some other proxy service to forward requests to 'host'
// The goal of this function is to determine if the domain is correctly set up along any of these lines.

// If the domain is not set up correctly, we want to identify any issues and provide guidance on how to fix them.
// e.g. if there is an A record pointing to the wrong IP address, we want to tell the user to remove it.
// or if the domain is not pointing to the blog, we want to tell the user to update the CNAME record.
// We want to query the domain's nameservers to identify the DNS provider and then provide a link to the provider's
//  documentation on how to update the DNS records.

// This function should return true if any one of the following conditions are met:
// hostname resolves with an A record to the correct IP address (config.ip)
// hostname resolves with a CNAME record to the correct host (config.host)
// hostname returns the handle of the blog in the response body for a GET request to http://hostname/verify/domain-setup

// This function should raise an exception if:
// hostname's nameservers do not resolve
// hostname does not resolve to an IP address
// hostname resolves to a CNAME record that does not match config.host
// hostname resolves to different IP address(es) AND does not respond with the handle of the blog for a GET request to http://hostname/verify/domain-setup

// for every exception after the first, the exception should contain a property 'nameservers' that contains the nameserver addresses of the domain

const dns = require('dns').promises;
// The domain-setup check connects to an A-record this function resolved
// itself and sends Host: <hostname>. It goes through the airlock's proxy
// (helper/airlock.getViaIP, config/airlock/README.md) so the egress filter
// rejects an A-record that resolves to an internal address, while still
// pinning the exact resolved IP rather than letting the proxy re-resolve.
const airlock = require('helper/airlock');
const { parse } = require('tldts');

const VERIFICATION_TIMEOUT_MS = 5000;
const VERIFICATION_TIMEOUT_SECONDS = VERIFICATION_TIMEOUT_MS / 1000;
const VERIFICATION_TIMEOUT_LABEL = Number.isInteger(VERIFICATION_TIMEOUT_SECONDS)
    ? `${VERIFICATION_TIMEOUT_SECONDS} seconds`
    : `${VERIFICATION_TIMEOUT_SECONDS.toFixed(2)} seconds`;

function normalizeHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') return '';
    return hostname.toLowerCase().replace(/\.$/, '');
}

function isValidCNAMETarget(cnameHost, ourHost) {
    const normalizedCNAMEHost = normalizeHostname(cnameHost);
    const normalizedOurHost = normalizeHostname(ourHost);

    if (!normalizedCNAMEHost || !normalizedOurHost) return false;
    if (normalizedCNAMEHost === normalizedOurHost) return true;

    return (
        normalizedCNAMEHost.endsWith(`.organization.${normalizedOurHost}`) ||
        normalizedCNAMEHost.endsWith(`.organizations.${normalizedOurHost}`)
    );
}

async function validate({ hostname, handle, ourIP, ourIPv6, ourHost }) {
    
    const parsed = parse(hostname);
    const apexDomain = parsed.domain;

    let nameservers = [];

    try {
        nameservers = await dns.resolveNs(apexDomain);
    } catch (err) {
        const error = new Error('NO_NAMESERVERS');
        error.nameservers = nameservers;
        error.details = err && (err.code || err.message);
        throw error;
    }

    if (nameservers.length === 0) {
        const error = new Error('NO_NAMESERVERS');
        error.nameservers = nameservers;
        throw error;
    }

    const resolver = new dns.Resolver();
    const fallbackNameservers = ['1.1.1.1', '8.8.8.8'];
    const nameserverResolutionErrors = [];
    const nameserverIPs = [];

    for (const ns of nameservers) {
        try {
            const records = await dns.lookup(ns, { all: true });
            if (records.length === 0) {
                nameserverResolutionErrors.push(`${ns}: NO_IP_ADDRESSES`);
            }

            for (const record of records) {
                nameserverIPs.push(record.address);
            }
        } catch (err) {
            nameserverResolutionErrors.push(`${ns}: ${err.code || err.message}`);
        }
    }

    const nameserverDetails = nameserverResolutionErrors.length
        ? nameserverResolutionErrors.join(', ')
        : null;
    const noNameserverIPs = nameserverIPs.length === 0;

    const attachNameserverDetails = (error) => {
        if (nameserverDetails && !error.details) {
            error.details = nameserverDetails;
        } else if (noNameserverIPs && !error.details) {
            error.details = 'NO_NAMESERVER_IP_ADDRESSES';
        }

        return error;
    };

    const resolverNameservers = Array.from(
        new Set([...nameserverIPs, ...fallbackNameservers])
    );

    resolver.setServers(resolverNameservers);

    const [cnameHost, aRecordIPs, aaaaRecordIPs] = await Promise.all([
        resolver.resolveCname(hostname).then(cnames => cnames[0] || null).catch(() => null),
        resolver.resolve4(hostname).catch(() => []),
        resolver.resolve6(hostname).catch(() => [])
    ]);

    if (cnameHost) {
        if (isValidCNAMETarget(cnameHost, ourHost)) {
            // CNAME matches our host, return success
            return true;
        } else {
            const error = new Error('CNAME_RECORD_EXISTS_BUT_DOES_NOT_MATCH');
            error.nameservers = nameservers;
            throw attachNameserverDetails(error);
        }
    }

    const allAddressRecords = [...aRecordIPs, ...aaaaRecordIPs];
    const correctAddresses = [ourIP, ourIPv6].filter(Boolean);
    const isCorrectAddress = (value) => correctAddresses.includes(value);
    const hasCorrectAddress =
        correctAddresses.length > 0 && allAddressRecords.some(isCorrectAddress);

    if (hasCorrectAddress) {
        const incorrectRecords = Array.from(
            new Set(allAddressRecords.filter((value) => !isCorrectAddress(value)))
        );

        if (incorrectRecords.length === 0) {
            return true;
        }

        const error = new Error('MULTIPLE_ADDRESS_BUT_ONE_IS_CORRECT');
        error.recordToRemove = incorrectRecords;
        error.nameservers = nameservers;
        throw attachNameserverDetails(error);
    }

    if (aRecordIPs.length === 0) {
        const error = new Error('NO_A_RECORD');
        error.nameservers = nameservers;
        throw attachNameserverDetails(error);
    }

    let text;

    // Proceed with the verification using the resolved A record IP
    const controller = typeof AbortController !== 'undefined'
        ? new AbortController()
        : null;

    const timeout = controller
        ? setTimeout(() => controller.abort(), VERIFICATION_TIMEOUT_MS)
        : null;

    try {
        const response = await airlock.getViaIP(aRecordIPs[0], '/verify/domain-setup', {
            host: hostname,
            ...(controller
                ? { signal: controller.signal }
                : { timeout: VERIFICATION_TIMEOUT_MS })
        });

        text = response.text;

    } catch (err) {
        const error = new Error('HANDLE_VERIFICATION_REQUEST_FAILED');
        if (err.name === 'AbortError' || err.type === 'request-timeout') {
            error.message = 'REQUEST_TIMEOUT';
            error.details = `Verification request timed out after ${VERIFICATION_TIMEOUT_LABEL}.`;
        } else {
            error.message = err.message;
            if (err.type && !error.details) {
                error.details = err.type;
            }
        }
        error.nameservers = nameservers;
        throw attachNameserverDetails(error);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }

    // Verify the response text matches the handle
    if (text === handle || text.includes('domain is almost set up')) {
        return true;
    } else {
        const error = new Error('HANDLE_MISMATCH');
        error.expected = handle;
        error.received = text;
        error.nameservers = nameservers;
        throw attachNameserverDetails(error);
    }
}

module.exports = validate;
