import test from "node:test";
import assert from "node:assert/strict";
import { FakeConnector } from "../packages/connectors/src/index.js";
import { MemoryTaskRepository } from "../packages/persistence/src/index.js";
import { createLocalApi, IngestionService } from "../apps/api/src/index.js";
import { validateTaskContext } from "../packages/contracts/src/index.js";
import fixture from "../packages/contracts/fixtures/task-context.compatible.json" with { type: "json" };

const taskFixture = validateTaskContext(fixture);

test("analyse rejects a malformed idempotency key before it changes the task", async () => {
  const instanceId = taskFixture.source.instanceId;
  const service = new IngestionService({
    rules: [
      {
        id: "fake",
        revision: 1,
        enabled: true,
        priority: 100,
        matchKind: "prefix",
        pattern: "FAKE-",
        pluginInstanceId: instanceId,
        repositoryId: taskFixture.repository.id,
      },
    ],
    connectors: new Map([[instanceId, new FakeConnector(new Map([["FAKE-1", taskFixture]]))]]),
    connectorContexts: new Map([
      [
        instanceId,
        { instanceId, repository: taskFixture.repository, fetchedAt: taskFixture.provenance.fetchedAt },
      ],
    ]),
    repository: new MemoryTaskRepository(),
  });
  const { context } = await service.ingestIdentifier("FAKE-1");
  // Any use of these would mean the handler went past the key check.
  const untouched = new Proxy(
    {},
    {
      get() {
        throw new Error("USED_BEFORE_KEY_CHECK");
      },
    },
  );
  const { server } = createLocalApi({
    service,
    sessionToken: "s",
    csrfToken: "c",
    runControl: untouched as never,
    configuration: untouched as never,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const post = (path: string, key?: string) =>
    fetch(`http://127.0.0.1:${address.port}/api/v1${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer s",
        "x-csrf-token": "c",
        "content-type": "application/json",
        ...(key === undefined ? {} : { "idempotency-key": key }),
      },
      body: "{}",
    });
  try {
    for (const path of [
      `/tasks/${context.taskId}/analyse`,
      `/tasks/${context.taskId}/runs`,
      "/runs/x/cancel",
    ]) {
      const response = await post(path, "live-test-sau325");
      assert.equal(response.status, 400, path);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "IDEMPOTENCY_KEY_INVALID",
      );
    }
    const missing = await post(`/tasks/${context.taskId}/runs`);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    assert.equal(service.getTask(context.taskId)!.revision, context.revision, "the task was not re-pinned");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
