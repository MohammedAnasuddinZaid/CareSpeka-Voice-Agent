import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeDirectory = path.join(backendDirectory, "runtime");
const caPath = path.join(runtimeDirectory, "ca.crt");
const keyPath = path.join(runtimeDirectory, "server.key");
const certificatePath = path.join(runtimeDirectory, "server.crt");
const webPort = Number(process.env.VOICELINK_GATEWAY_PORT || 3443);
const caPort = Number(process.env.VOICELINK_CA_PORT || 3080);
const backendTarget = process.env.VOICELINK_BACKEND_TARGET || "http://127.0.0.1:8000";
const frontendTarget = process.env.VOICELINK_FRONTEND_TARGET || "http://127.0.0.1:3000";

function isPrivateAddress(address = "") {
  const value = address.replace(/^::ffff:/, "");
  return value === "::1" || value.startsWith("127.") || value.startsWith("10.") ||
    value.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

function privateAddress() {
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  return interfaces.find((item) => item.family === "IPv4" && !item.internal && isPrivateAddress(item.address))?.address || "127.0.0.1";
}

for (const file of [caPath, keyPath, certificatePath]) {
  if (!fs.existsSync(file)) {
    console.error(`Missing local TLS file: ${file}. Run setup.ps1 first.`);
    process.exit(1);
  }
}

fs.mkdirSync(runtimeDirectory, { recursive: true });
const proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true, xfwd: true });
proxy.on("error", (error, request, responseOrSocket) => {
  console.error(`Local proxy error: ${error.message}`);
  if (responseOrSocket && typeof responseOrSocket.writeHead === "function") {
    if (!responseOrSocket.headersSent) responseOrSocket.writeHead(502, { "Content-Type": "text/plain" });
    responseOrSocket.end("Local CareSpeak service is not running.");
  } else if (responseOrSocket && !responseOrSocket.destroyed) {
    responseOrSocket.destroy();
  }
  if (request?.url) console.error(`Request: ${request.url}`);
});

const appServer = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certificatePath),
    minVersion: "TLSv1.2",
  },
  (request, response) => {
    if (!isPrivateAddress(request.socket.remoteAddress)) {
      response.writeHead(403);
      response.end("Local network access only.");
      return;
    }
    const backendRequest = request.url?.startsWith("/api/voicelink/") || request.url === "/health";
    proxy.web(request, response, { target: backendRequest ? backendTarget : frontendTarget });
  },
);

appServer.on("upgrade", (request, socket, head) => {
  if (!isPrivateAddress(request.socket.remoteAddress) || request.url !== "/ws/voicelink") {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  proxy.ws(request, socket, head, { target: backendTarget });
});

const certificateServer = http.createServer((request, response) => {
  if (!isPrivateAddress(request.socket.remoteAddress)) {
    response.writeHead(403);
    response.end("Local network access only.");
    return;
  }
  if (request.url !== "/ca.crt" || request.method !== "GET") {
    response.writeHead(404);
    response.end("Not found.");
    return;
  }
  response.writeHead(200, {
    "Content-Type": "application/x-x509-ca-cert",
    "Content-Disposition": "attachment; filename=carespeak-local-ca.crt",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(caPath).pipe(response);
});

appServer.listen(webPort, "0.0.0.0", () => {
  console.log(`Phone web gateway: https://${privateAddress()}:${webPort}/voicelink`);
});
certificateServer.listen(caPort, "0.0.0.0", () => {
  console.log(`Local CA certificate: http://${privateAddress()}:${caPort}/ca.crt`);
});

function shutdown() {
  proxy.close();
  appServer.close();
  certificateServer.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
