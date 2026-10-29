import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { FakeConnector } from "../packages/connectors/src/index.js";
import { MemoryTaskRepository } from "../packages/persistence/src/index.js";
import { IngestionService } from "../apps/api/src/index.js";
import { validateTaskContext } from "../packages/contracts/src/index.js";
import fixture from "../packages/contracts/fixtures/task-context.compatible.json" with { type: "json" };

const taskFixture = validateTaskContext(fixture);

test("manual ingestion routes, persists, and returns validated context", async () => {
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
  const result = await service.ingestIdentifier("FAKE-1");
  assert.equal(result.context.title, "Fixture task");
  assert.equal(result.receipt.contextRevision, 1);
});

test("signed duplicate webhook returns original durable receipt", async () => {
  const instanceId = taskFixture.source.instanceId;
  const repository = new MemoryTaskRepository();
  const route = "/api/v1/webhooks/fake";
  const service = new IngestionService({
    rules: [
      {
        id: "hook",
        revision: 1,
        enabled: true,
        priority: 100,
        matchKind: "webhook",
        pattern: route,
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
    repository,
  });
  const body = Buffer.from(JSON.stringify({ key: "FAKE-1" }));
  const timestamp = new Date().toISOString();
  const secret = Buffer.from("webhook secret");
  const signature = `sha256=${createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex")}`;
  const first = await service.ingestWebhook(
    route,
    body,
    { signature, timestamp, deliveryId: "delivery-1" },
    secret,
  );
  const second = await service.ingestWebhook(
    route,
    body,
    { signature, timestamp, deliveryId: "delivery-1" },
    secret,
  );
  assert.equal(first.receipt.duplicate, false);
  assert.equal(second.receipt.duplicate, true);
  assert.equal(second.receipt.taskId, first.receipt.taskId);
  await assert.rejects(
    service.ingestWebhook(route, body, { signature: "sha256=00", timestamp, deliveryId: "bad" }, secret),
    /WEBHOOK_SIGNATURE_INVALID/,
  );
});

test("Jira planning refresh creates a new immutable context revision on the same task", async () => {
  const repository = new MemoryTaskRepository();
  repository.ingest(taskFixture);
  const before = repository.getContext(taskFixture.taskId);
  const refreshed = validateTaskContext({
    ...taskFixture,
    taskId: "a1000000-0000-4000-8000-000000000099",
    source: { ...taskFixture.source, revision: "jira-revision-2" },
    provenance: { ...taskFixture.provenance, fetchedAt: "2026-10-28T18:00:00.000Z" },
    extensions: {
      "community.jira.planning": { plannedFor: "2026-10-29", field: "duedate" },
    },
  });
  const service = new IngestionService({
    rules: [],
    connectors: new Map([
      [
        taskFixture.source.instanceId,
        new FakeConnector(new Map([[taskFixture.source.externalId, refreshed]])),
      ],
    ]),
    connectorContexts: new Map([
      [
        taskFixture.source.instanceId,
        {
          instanceId: taskFixture.source.instanceId,
          repository: taskFixture.repository,
          fetchedAt: taskFixture.provenance.fetchedAt,
        },
      ],
    ]),
    repository,
  });
  const sync = await service.refreshTasks();
  assert.equal(sync.updated, 1);
  assert.equal(repository.list().length, 1);
  assert.equal(repository.list()[0]?.plannedFor, "2026-10-29");
  assert.equal(repository.list()[0]?.planningRevision, 2);
  assert.deepEqual(repository.getContext(taskFixture.taskId, 1), before);
});
