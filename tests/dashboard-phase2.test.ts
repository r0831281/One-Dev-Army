import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("minimal dashboard exposes accessible gate controls and explicit operational states", async () => {
  const html = await readFile("apps/dashboard/index.html", "utf8");
  const styles = await readFile("apps/dashboard/styles/dashboard.css", "utf8");
  const script = await readFile("apps/dashboard/dashboard.js", "utf8");
  for (const text of [
    "Approve plan",
    "Request changes",
    "Reason for rejection (required)",
    "Stale gate",
    "Decision pending",
    "Cancel queued work",
  ])
    assert.ok(script.includes(text), `dashboard is missing state/control text: ${text}`);
  assert.match(html, /aria-label="Work"/);
  assert.match(html, /role="alert"/);
  assert.match(styles, /focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.doesNotMatch(html, /<style\b|\sstyle=/i);
  assert.match(html, /src="\.\/dashboard\.js"/);
  assert.doesNotMatch(html, /innerHTML/);
});
