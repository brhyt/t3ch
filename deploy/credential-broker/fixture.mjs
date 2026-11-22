import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
const secret = NodeFS.readFileSync("/run/credential", "utf8");
let mode = "ok";
let accepted = 0;
let trapped = 0;
NodeHttp.createServer((req, res) => {
  if (req.url !== "/fixture/ping") {
    trapped++;
    res.writeHead(403).end();
    return;
  }
  if (req.method !== "POST" || req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(401).end();
    return;
  }
  accepted++;
  if (mode === "redirect")
    res.writeHead(307, { location: "http://upstream:8080/trap" }).end(secret);
  else if (mode === "reflect") res.writeHead(500, { "x-secret": secret }).end(secret);
  else res.writeHead(204, { "x-secret": secret }).end();
}).listen(8080, "0.0.0.0");
NodeHttp.createServer((req, res) => {
  if (req.url === "/redirect") mode = "redirect";
  if (req.url === "/reflect") mode = "reflect";
  if (req.url === "/ok") mode = "ok";
  res.end(JSON.stringify({ accepted, trapped }));
}).listen(8081, "127.0.0.1");
process.stdout.write("ready\n");
