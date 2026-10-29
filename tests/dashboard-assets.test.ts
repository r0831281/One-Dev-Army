import test from "node:test";
import assert from "node:assert/strict";
import assets from "../apps/dashboard/assets.json" with { type: "json" };
import { createLocalApi, IngestionService } from "../apps/api/src/index.js";
import { MemoryTaskRepository } from "../packages/persistence/src/index.js";

test("the API serves dashboard modules and CSS with the correct MIME type and CSP", async () => {
  const service = new IngestionService({
    rules: [],
    connectors: new Map(),
    connectorContexts: new Map(),
    repository: new MemoryTaskRepository(),
  });
  const { server } = createLocalApi({ service });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") || "", /style-src 'self'/);
    const html = await page.text();
    assert.match(html, /src="\.\/dashboard\.js"/);
    assert.match(html, /href="\.\/styles\/dashboard\.css"/);
    for (const [path, mime] of Object.entries(assets)) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), mime, path);
      assert.doesNotMatch(await response.text(), /^<!doctype html>/i, path);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
