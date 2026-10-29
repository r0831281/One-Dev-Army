import test from "node:test";
import assert from "node:assert/strict";
import { GitHubConnector, JiraConnector, type ScopedHttp } from "../packages/connectors/src/index.js";

class GitHubFixture implements ScopedHttp {
  readonly comments: Array<{ id: number; body: string; html_url: string }> = [];
  patches: unknown[] = [];
  failWrite = false;
  async request<T>(request: { method: string; url: string; body?: unknown }): Promise<T> {
    if (request.method === "GET" && request.url.includes("/comments?"))
      return structuredClone(this.comments) as T;
    if (request.method === "GET")
      return {
        id: 1,
        number: 42,
        title: "Issue",
        body: "Body",
        html_url: "https://github.test/acme/app/issues/42",
        updated_at: "2026-01-01T00:00:00Z",
        state: "open",
        labels: [],
        user: null,
      } as T;
    if (this.failWrite) throw new Error("timeout");
    if (request.method === "PATCH") {
      this.patches.push(request.body);
      return {} as T;
    }
    const body = String((request.body as { body: string }).body);
    const created = {
      id: this.comments.length + 1,
      body,
      html_url: `https://github.test/comments/${this.comments.length + 1}`,
    };
    this.comments.push(created);
    return created as T;
  }
}

test("GitHub writes reconcile markers, status mapping, and uncertain timeouts", async () => {
  const fixture = new GitHubFixture();
  const connector = new GitHubConnector("acme", "app", fixture, "https://api.github.test", {
    IN_PROGRESS: { state: "open", label: "in-progress" },
    DONE: { state: "closed" },
  });
  const ref = connector.normalize("acme/app#42");
  const first = await connector.postComment({ ref, body: "done", operationId: "op-1" });
  const replay = await connector.postComment({ ref, body: "done", operationId: "op-1" });
  assert.equal(first.status, "APPLIED");
  assert.equal(replay.status, "ALREADY_APPLIED");
  assert.equal(fixture.comments.length, 1);
  assert.equal(
    (await connector.updateStatus({ ref, status: "IN_PROGRESS", operationId: "status-1" })).status,
    "APPLIED",
  );
  assert.deepEqual(fixture.patches, [{ state: "open", labels: ["in-progress"] }]);
  fixture.failWrite = true;
  assert.equal(
    (await connector.postComment({ ref, body: "unknown", operationId: "op-2" })).status,
    "UNCERTAIN",
  );
});

class JiraFixture implements ScopedHttp {
  readonly comments: Array<{ id: string; body: unknown }> = [];
  transitions = 0;
  failWrite = false;
  async request<T>(request: { method: string; url: string; body?: unknown }): Promise<T> {
    if (request.method === "GET" && request.url.includes("/comment?"))
      return { comments: structuredClone(this.comments), startAt: 0, total: this.comments.length } as T;
    if (request.method === "GET" && request.url.endsWith("/transitions"))
      return { transitions: [{ id: "31", to: { id: "done" } }] } as T;
    if (request.method === "GET" && request.url.includes("?fields=status"))
      return { id: "100", key: "APP-1", fields: { status: { id: "open" } } } as T;
    if (this.failWrite) throw new Error("timeout");
    if (request.method === "POST" && request.url.endsWith("/transitions")) {
      this.transitions++;
      return {} as T;
    }
    const created = { id: String(this.comments.length + 1), body: (request.body as { body: unknown }).body };
    this.comments.push(created);
    return created as T;
  }
}

test("Jira writes reconcile ADF markers, transitions, and uncertain timeouts", async () => {
  const fixture = new JiraFixture();
  const connector = new JiraConnector("https://jira.test", "APP", fixture, {
    DONE: { transitionId: "31", targetStatusId: "done" },
  });
  const ref = connector.normalize("APP-1");
  assert.equal((await connector.postComment({ ref, body: "done", operationId: "op-1" })).status, "APPLIED");
  assert.equal(
    (await connector.postComment({ ref, body: "done", operationId: "op-1" })).status,
    "ALREADY_APPLIED",
  );
  assert.equal(fixture.comments.length, 1);
  assert.equal(
    (await connector.updateStatus({ ref, status: "DONE", operationId: "status-1" })).status,
    "APPLIED",
  );
  assert.equal(fixture.transitions, 1);
  fixture.failWrite = true;
  assert.equal(
    (await connector.postComment({ ref, body: "unknown", operationId: "op-2" })).status,
    "UNCERTAIN",
  );
});
