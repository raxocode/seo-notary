import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("./site/", import.meta.url));
const PAGES = new Set(["broken", "fixed"]);

/** Serves demo/site/<page>/index.html at /<page>. Listens on 127.0.0.1 only. */
export async function startDemoServer(port = 0): Promise<{ server: Server; port: number; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const page = (req.url ?? "/").split("?")[0]?.replace(/^\/|\/$/g, "") ?? "";
    if (!PAGES.has(page)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found. Try /broken or /fixed.\n");
      return;
    }
    readFile(`${SITE}${page}/index.html`).then(
      (html) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html),
      () => res.writeHead(500).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startDemoServer(Number(process.env["PORT"] ?? 4173));
  console.log(`Demo site: http://127.0.0.1:${port}/broken and http://127.0.0.1:${port}/fixed`);
}
