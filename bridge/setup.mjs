import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import selfsigned from 'selfsigned';
import { X509Certificate } from 'node:crypto';

const directory = new URL('./private/', import.meta.url);
const certPath = new URL('cert.pem', directory);
const keyPath = new URL('key.pem', directory);
const caPath = new URL('ca.crt', directory);
const caKeyPath = new URL('ca-key.pem', directory);

export async function ensureCertificate(requiredIp = '127.0.0.1') {
  const addresses = ['127.0.0.1'];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal &&
          /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(entry.address)) {
        addresses.push(entry.address);
      }
    }
  }
  const now = new Date();
  const end = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  let ca;
  try {
    ca = { cert: await readFile(caPath, 'utf8'),
      private: await readFile(caKeyPath, 'utf8') };
    if (new Date(new X509Certificate(ca.cert).validTo) <= now) ca = null;
  } catch { ca = null; }
  if (!ca) {
    ca = await selfsigned.generate([{ name: 'commonName', value: 'RemoteDesk Local Root CA' }], {
      algorithm: 'sha256', notBeforeDate: now, notAfterDate: end,
      extensions: [
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
      ]
    });
    await mkdir(directory, { recursive: true });
    await writeFile(caPath, ca.cert, { mode: 0o600 });
    await writeFile(caKeyPath, ca.private, { mode: 0o600 });
  }
  try {
    const certificate = new X509Certificate(await readFile(certPath));
    await readFile(keyPath);
    if (certificate.checkIP(requiredIp) && new Date(certificate.validTo) > now &&
        certificate.verify(new X509Certificate(ca.cert).publicKey)) {
      return { certPath, keyPath, caPath };
    }
  } catch { /* Renew the server leaf certificate, keeping the trusted CA. */ }
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'RemoteDesk local' }], {
    algorithm: 'sha256',
    ca: { key: ca.private, cert: ca.cert },
    notBeforeDate: now,
    notAfterDate: end,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        ...[...new Set(addresses)].map(ip => ({ type: 7, ip }))
      ] }
    ]
  });
  await mkdir(directory, { recursive: true });
  await writeFile(certPath, pems.cert, { mode: 0o600 });
  await writeFile(keyPath, pems.private, { mode: 0o600 });
  return { certPath, keyPath, caPath };
}

export async function certificateFingerprint() {
  const { caPath } = await ensureCertificate();
  return new X509Certificate(await readFile(caPath)).fingerprint256;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await ensureCertificate();
  console.log('Local HTTPS certificate is ready in bridge/private/');
}
