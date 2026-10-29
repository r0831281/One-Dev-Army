import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ContractValidationError, validateTaskContext } from "../packages/contracts/src/index.js";
import {
  compileSafeRegex,
  previewRoute,
  resolveRoute,
  RoutingError,
  type RoutingRule,
} from "../packages/routing/src/index.js";

test("authoritative schema accepts compatibility fixture and rejects malformed input", async () => {
  const compatible = JSON.parse(
    await readFile("packages/contracts/fixtures/task-context.compatible.json", "utf8"),
  );
  assert.equal(validateTaskContext(compatible).title, "Fixture task");
  const invalid = JSON.parse(await readFile("packages/contracts/fixtures/task-context.invalid.json", "utf8"));
  assert.throws(() => validateTaskContext(invalid), ContractValidationError);
});

test("routing uses priority then specificity and reports ambiguity", () => {
  const rules: RoutingRule[] = [
    {
      id: "fallback",
      revision: 1,
      enabled: true,
      priority: 0,
      matchKind: "fallback",
      pattern: "",
      pluginInstanceId: "f",
      repositoryId: "r",
    },
    {
      id: "prefix",
      revision: 1,
      enabled: true,
      priority: 10,
      matchKind: "prefix",
      pattern: "APP-",
      pluginInstanceId: "p",
      repositoryId: "r",
    },
    {
      id: "exact",
      revision: 1,
      enabled: true,
      priority: 10,
      matchKind: "exact",
      pattern: "APP-1",
      pluginInstanceId: "e",
      repositoryId: "r",
    },
  ];
  assert.equal(resolveRoute(rules, { kind: "identifier", value: "APP-1" }).id, "exact");
  rules.push({ ...rules[2]!, id: "exact-2", pluginInstanceId: "other" });
  assert.equal(previewRoute(rules, { kind: "identifier", value: "APP-1" }).ambiguous, true);
  assert.throws(
    () => resolveRoute(rules, { kind: "identifier", value: "APP-1" }),
    (error) => error instanceof RoutingError && error.code === "AMBIGUOUS_ROUTE",
  );
});

test("routing rejects malformed inputs and non-RE2 regex features", () => {
  assert.throws(() => compileSafeRegex("(a+)+$"), RoutingError);
  assert.throws(() => compileSafeRegex("(a)\\1"), RoutingError);
  assert.throws(() => previewRoute([], { kind: "identifier", value: "bad\u0000value" }), RoutingError);
});
