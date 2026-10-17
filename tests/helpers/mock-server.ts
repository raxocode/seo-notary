import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface MockServer {
  port: number;
  url(path: string): string;
  hits: string[];
  openSockets(): number;
  close(): Promise<void>;
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

export async function startServer(handler: Handler, host = "127.0.0.1"): Promise<MockServer> {
  const sockets = new Set<Socket>();
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    handler(req, res);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hits,
    url: (path) => `http://${host.includes(":") ? `[${host}]` : host}:${port}${path}`,
    openSockets: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export async function waitForNoSockets(server: MockServer, ms = 2000): Promise<number> {
  const end = Date.now() + ms;
  while (server.openSockets() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return server.openSockets();
}

export const PAGE_OK = `<!doctype html><html><head><meta charset="utf-8">
<title>A perfectly fine page title</title>
<meta name="description" content="A description.">
<link rel="canonical" href="CANON">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Thing"}</script>
</head><body><h1>Hello</h1><p>one two three four five</p></body></html>`;
