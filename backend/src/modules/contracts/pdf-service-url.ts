import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
function privateAddress(host: string): boolean {
  const family = net.isIP(host);
  if (family === 4)
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return family === 6 && (host === '::1' || /^(fc|fd)[\da-f]{2}:/.test(host));
}
/** Only administrator-configured HTTPS or explicitly addressed private HTTP services. No redirects. */
export function validatePdfServiceUrl(value: string): URL {
  const u = new URL(value);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !['http:', 'https:'].includes(u.protocol)
  )
    throw new Error('PDF 服务地址不合法');
  if (forbiddenAddress(host) || /(^|\.)metadata(\.|$)/.test(host))
    throw new Error('禁止链路本地和云元数据地址');
  if (
    u.protocol === 'http:' &&
    !(host === 'localhost' || privateAddress(host))
  )
    throw new Error('HTTP 仅允许本机或显式受控私网地址');
  return u;
}
export function forbiddenAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!net.isIP(h)) return false;
  if (h.startsWith('::ffff:')) return true;
  if (net.isIP(h) === 4)
    return (
      h === '168.63.129.16' ||
      /^(0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(
        h,
      )
    );
  return (
    ['::', 'fd00:ec2::254', 'fd20:ce::254'].includes(h) ||
    /^fe[89ab]/.test(h) ||
    /^ff/.test(h)
  );
}
function assertResolvedAddresses(url: URL, addresses: { address: string }[]): void {
  if (!addresses.length || addresses.some(({ address }) =>
    !net.isIP(address) || forbiddenAddress(address) ||
    (url.protocol === 'http:' && !privateAddress(address.toLowerCase()))
  )) throw new Error('PDF 服务解析到受限地址');
}
export async function checkedPdfServiceUrl(value: string): Promise<URL> {
  const u = validatePdfServiceUrl(value);
  const addresses = await dns.lookup(u.hostname.replace(/^\[|\]$/g, ''), {
    all: true,
  });
  assertResolvedAddresses(u, addresses);
  return u;
}

/** Pin the connection to the checked address. The Host header and TLS name retain the configured origin. */
export async function pdfServiceJson(
  value: string,
  form: FormData,
  key: string | null,
  timeoutMs: number,
): Promise<unknown> {
  const url = validatePdfServiceUrl(value);
  const signal = AbortSignal.timeout(timeoutMs);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await Promise.race([
    dns.lookup(hostname, { all: true }),
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    ),
  ]);
  assertResolvedAddresses(url, addresses);
  const payload = new Request('http://localhost', {
    method: 'POST',
    body: form,
  });
  const body = Buffer.from(await payload.arrayBuffer());
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: addresses[0].address,
        port: url.port || undefined,
        path: `${url.pathname.replace(/\/$/, '')}/parse-pdf`,
        method: 'POST',
        signal,
        ...(url.protocol === 'https:' && !net.isIP(hostname)
          ? { servername: hostname }
          : {}),
        headers: {
          Host: url.host,
          'Content-Type': payload.headers.get('content-type')!,
          'Content-Length': body.length,
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
      },
      (res) => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          reject(new Error('PDF_RESPONSE'));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) {
            res.destroy(new Error('PDF_LIMIT'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
