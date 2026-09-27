import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

// Link previews fetch URLs that people paste in, so the server must never be
// talked into requesting its own network (localhost, cloud metadata, LAN, …).
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

// IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1) is checked as the IPv4 address it wraps.
// (Adding ::ffff:0:0/96 to the block list would block every IPv4 address in Node.)
function unmapIPv4(ip) {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

export function isPrivateAddress(ip) {
  const version = net.isIP(ip);
  if (!version) return true;
  const mapped = version === 6 && unmapIPv4(ip);
  if (mapped) return isPrivateAddress(mapped);
  return blocked.check(ip, version === 4 ? 'ipv4' : 'ipv6');
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
    if (!allowed.length) return callback(new Error(`Refusing to connect to private address for ${hostname}`));
    if (options.all) return callback(null, allowed);
    return callback(null, allowed[0].address, allowed[0].family);
  });
}

function decompress(response) {
  switch ((response.headers['content-encoding'] || '').trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return response.pipe(zlib.createGunzip());
    case 'deflate':
      return response.pipe(zlib.createInflate());
    case 'br':
      return response.pipe(zlib.createBrotliDecompress());
    default:
      return response;
  }
}

function requestOnce(url, { headers, timeoutMs, maxBytes, truncate, allowPrivate }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) {
      reject(new Error('Refusing to fetch a private address'));
      return;
    }
    const request = client.get(url, {
      headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
      lookup: allowPrivate ? undefined : guardedLookup,
      timeout: timeoutMs,
    });
    const timer = setTimeout(() => request.destroy(new Error('Timed out')), timeoutMs);
    request.on('timeout', () => request.destroy(new Error('Timed out')));
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on('response', (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        clearTimeout(timer);
        response.resume();
        resolve({ redirect: response.headers.location, status: response.statusCode });
        return;
      }
      const stream = decompress(response);
      const chunks = [];
      let size = 0;
      let done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      };
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          if (truncate) chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          request.destroy();
          finish(truncate ? null : new Error('Response too large'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('end', () => finish());
      stream.on('error', (error) => finish(truncate && chunks.length ? null : error));
    });
  });
}

/**
 * GET a URL from the public internet only. Follows up to 5 redirects,
 * checking each hop. Resolves to { url, status, headers, body }.
 */
export async function safeFetch(
  input,
  { headers = {}, timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024, truncate = false, allowPrivate = false } = {},
) {
  let url = new URL(input);
  for (let hop = 0; hop <= 5; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links are supported');
    const result = await requestOnce(url, { headers, timeoutMs, maxBytes, truncate, allowPrivate });
    if (!result.redirect) return { url: url.href, ...result };
    url = new URL(result.redirect, url);
  }
  throw new Error('Too many redirects');
}
