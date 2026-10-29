import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assets from "../apps/dashboard/assets.json" with { type: "json" };

const root = fileURLToPath(new URL("../apps/dashboard", import.meta.url));
export async function startDashboardPreview({ port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Demo preview is read-only; connector requests require the API." },
        }),
      );
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const index = pathname === "/" || pathname === "/dashboard";
    if (index && !url.searchParams.has("fixture") && !url.searchParams.has("live")) {
      res.writeHead(302, { location: "/?fixture=demo", "cache-control": "no-store" });
      res.end();
      return;
    }
    const type = index ? "text/html; charset=utf-8" : assets[pathname];
    if (!type) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Asset not found. Use ?fixture=demo for the standalone demo." } }),
      );
      return;
    }
    try {
      const content = await readFile(join(root, index ? "index.html" : pathname.slice(1)));
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch {
      res.writeHead(500);
      res.end("Dashboard asset unavailable");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startDashboardPreview({ port: Number(process.env.ODA_DASHBOARD_PORT || 4321) });
  console.log(`Dashboard demo: http://127.0.0.1:${server.address().port}/?fixture=demo`);
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
