// Harness tes probe egress: origin HTTPS, proxy HTTP CONNECT, dan penghitung.
// Origin hanya menghitung hit. Proxy menghitung CONNECT dan meneruskannya
// dari IP sumber yang ditentukan (localAddress) agar IP keluar bisa dibedakan.
//
// Sertifikat dibuat saat runtime di direktori temp dan dihapus oleh close().
// Tidak ada kunci privat yang disimpan di repo.
import https from "node:https";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function makeSelfSignedCert(dir) {
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

export async function startEgressHarness({ exitIp = "127.0.0.2", reportIp = null } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zenith-egress-"));
  const { key, cert } = makeSelfSignedCert(tmpDir);
  const counts = { origin: 0, connect: 0 };

  const origin = https.createServer({ key, cert }, (req, res) => {
    counts.origin++;
    res.setHeader("content-type", "text/plain");
    res.end(reportIp ?? exitIp);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = origin.address().port;

  const proxy = http.createServer((req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, client, head) => {
    counts.connect++;
    const [host, port] = req.url.split(":");
    const up = net.connect({ host, port: Number(port), localAddress: exitIp }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));

  return {
    originUrl: `https://127.0.0.1:${originPort}/ip`,
    proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
    caPem: cert,
    counts,
    close: () => {
      origin.close();
      proxy.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
