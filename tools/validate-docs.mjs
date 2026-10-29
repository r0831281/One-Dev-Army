import assert from 'node:assert/strict';
import { readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { PGlite } from '@electric-sql/pglite';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFile(path.join(root, relative), 'utf8');
const findings = [];
async function filesUnder(relative) {
  const results = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) results.push(...await filesUnder(name));
    else results.push(name);
  }
  return results;
}
const markdown = ['README.md', ...(await filesUnder('docs')).filter(name => name.endsWith('.md'))];
const content = new Map(await Promise.all(markdown.map(async name => [name, await read(name)])));
assert.match(content.get('README.md'), /^# One Developer Army \(O-D-A\)/);
assert.equal(markdown.filter(name => /^docs\/0[1-9]-/.test(name)).length, 9);

function headings(source) {
  const counts = new Map();
  return new Set([...source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map(match => {
    const slug = match[1].toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    return count ? `${slug}-${count}` : slug;
  }));
}
let links = 0;
for (const [name, source] of content) {
  for (const match of source.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [filename, fragment] = target.split('#');
    const resolved = path.resolve(root, path.dirname(name), decodeURIComponent(filename || path.basename(name)));
    assert.ok(resolved.startsWith(root), `${name}: link leaves repository: ${target}`);
    await access(resolved).catch(() => assert.fail(`${name}: broken local link ${target}`));
    if (fragment && resolved.endsWith('.md')) {
      assert.ok(headings(await readFile(resolved, 'utf8')).has(decodeURIComponent(fragment)), `${name}: missing anchor ${target}`);
    }
    links++;
  }
}
findings.push(`${markdown.length} Markdown files and ${links} local links checked`);

const schema = JSON.parse(await read('docs/reference/schemas.json'));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const validators = new Map(Object.keys(schema.$defs).map(name => [name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` })]));
function validate(name, payload, label) {
  const validator = validators.get(name);
  assert.ok(validator, `Unknown schema ${name}`);
  assert.ok(validator(payload), `${label}: ${ajv.errorsText(validator.errors, { separator: '\n' })}`);
}
const assignments = {
  'docs/02-dashboard.md': ['GateDecisionInput'],
  'docs/03-observability.md': ['EventEnvelope'],
  'docs/04-onboarding.md': ['SetupConfig'],
  'docs/05-plugins-and-routing.md': ['PluginManifest', 'RpcRequest'],
  'docs/06-data-contracts.md': ['DecisionReceipt', 'ApiError'],
  'docs/07-agents-and-prompts.md': ['AgentProfile'],
};
let examples = 0;
for (const [name, source] of content) {
  const payloads = [...source.matchAll(/^```(json|yaml)\r?\n([\s\S]*?)^```\s*$/gm)];
  assert.equal(payloads.length, assignments[name]?.length ?? 0, `${name}: every JSON/YAML fence needs a schema assignment`);
  for (const [index, match] of payloads.entries()) {
    validate(assignments[name][index], match[1] === 'json' ? JSON.parse(match[2]) : parseYaml(match[2]), `${name} example ${index + 1}`);
    examples++;
  }
}
const task = JSON.parse(await read('docs/reference/task-context.example.json'));
const profile = JSON.parse(await read('docs/reference/agent-profile.example.json'));
validate('TaskContext', task, 'TaskContext fixture');
validate('AgentProfile', profile, 'AgentProfile fixture');
const gate = {
  protocolVersion: '1.0', runId: '10000000-0000-4000-8000-000000000001',
  workflowId: 'task/task-id/run/run-id', gateId: '30000000-0000-4000-8000-000000000001',
  expectedGateVersion: 1, idempotencyKey: '40000000-0000-4000-8000-000000000001', decision: 'APPROVE',
};
validate('GateDecisionInput', gate, 'Approve fixture');
for (const [name, value, label] of [
  ['GateDecisionInput', { ...gate, decision: 'REJECT' }, 'reject without reason'],
  ['GateDecisionInput', { ...gate, decision: 'REJECT', reason: '  \n ' }, 'blank rejection reason'],
  ['GateDecisionInput', { ...gate, reason: 'unexpected' }, 'approve with a reason'],
  ['GateDecisionInput', { ...gate, expectedGateVersion: 0 }, 'zero gate version'],
  ['AgentProfile', { ...profile, tools: ['host.root-shell'] }, 'unknown tool'],
  ['TaskContext', { ...task, unexpectedField: true }, 'unknown core property'],
  ['TaskContext', { ...task, repository: { ...task.repository, baseSha: '../escape' } }, 'invalid base SHA'],
]) assert.equal(validators.get(name)(value), false, `${label} must be rejected`);
findings.push(`${examples + 3} valid JSON/YAML examples and 7 rejection cases checked`);

const db = new PGlite();
try {
  await db.exec(await read('docs/reference/schema.sql'));
  const w = '50000000-0000-4000-8000-000000000001';
  const r = task.repository.id;
  const p = task.source.instanceId;
  const t = task.taskId;
  const run = gate.runId;
  const g = gate.gateId;
  const hash = 'a'.repeat(64);
  await db.query('INSERT INTO workspaces(id,name,journal_epoch) VALUES ($1,$2,$3)', [w, 'One Developer Army', '11111111-1111-4111-8111-111111111111']);
  await db.query('INSERT INTO repositories(id,workspace_id,name,approved_path,policy) VALUES ($1,$2,$3,$4,$5)', [r, w, 'app', '/approved/repository', {}]);
  await db.query('INSERT INTO source_plugins(id,workspace_id,plugin_id,package_version,image_digest,name,revision,manifest,config,grants) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)', [p, w, 'oda.fake', '1.0.0', `sha256:${hash}`, 'fake', {}, {}, {}]);
  await db.query('INSERT INTO tasks(id,workspace_id,source_plugin_id,external_id,source_key,title) VALUES ($1,$2,$3,$4,$5,$6)', [t, w, p, task.source.externalId, task.source.key, task.title]);
  await db.query('INSERT INTO task_contexts(task_id,revision,schema_version,context,sha256) VALUES ($1,1,$2,$3,$4)', [t, '1.0', task, hash]);
  await db.query('UPDATE tasks SET current_context_revision=1 WHERE id=$1', [t]);
  const insertRun = (id, workflow) => db.query('INSERT INTO workflow_runs(id,workspace_id,task_id,context_revision,repository_id,base_sha,workflow_id,state,manifest,manifest_sha256,budgets) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)', [id, w, t, r, task.repository.baseSha, workflow, 'AWAITING_PLAN', {}, hash, {}]);
  await insertRun(run, 'workflow-1');
  await assert.rejects(() => insertRun('10000000-0000-4000-8000-000000000002', 'workflow-2'), /one_active_run_per_task/);
  await db.query('INSERT INTO decision_gates(id,version,run_id,kind,state,proposal,artifact_hashes,opened_at) VALUES ($1,1,$2,$3,$4,$5,$6,now())', [g, run, 'PLAN_APPROVAL', 'PENDING', {}, [hash]]);
  const insertDecision = (id, key, decision, reason) => db.query('INSERT INTO gate_decisions(id,run_id,gate_id,gate_version,idempotency_key,payload_sha256,decision,reason,actor_id,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,now())', [id, run, g, key, hash, decision, reason, w]);
  await assert.rejects(() => insertDecision('70000000-0000-4000-8000-000000000001', gate.idempotencyKey, 'REJECT', '   '), /check constraint/);
  await insertDecision('70000000-0000-4000-8000-000000000001', gate.idempotencyKey, 'APPROVE', null);
  await assert.rejects(() => insertDecision('70000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002', 'APPROVE', null), /unique constraint/);
  await db.query('INSERT INTO agent_profiles(id,revision,workspace_id,name,role,schema_version,profile,sha256) VALUES ($1,1,$2,$3,$4,$5,$6,$7)', [profile.id, w, profile.name, profile.role, '1.0', profile, hash]);
  const step = 'a0000000-0000-4000-8000-000000000001';
  await db.query('INSERT INTO agent_steps(id,run_id,role,logical_iteration,profile_id,profile_revision,state) VALUES ($1,$2,$3,1,$4,1,$5)', [step, run, 'planner', profile.id, 'RUNNING']);
  await assert.rejects(() => db.query("INSERT INTO model_usage(id,run_id,step_id,operation_id,attempt,provider,requested_model,input_tokens,usage_status,pricing_status) VALUES ($1,$2,$3,'bad-usage',1,'ollama','local',-1,'FINAL','UNPRICED')", ['b0000000-0000-4000-8000-000000000001', run, step]), /check constraint/);
  await db.query('INSERT INTO workspace_event_counters(workspace_id) VALUES ($1)', [w]);
  await db.exec('BEGIN');
  await db.query('UPDATE workspace_event_counters SET last_seq=last_seq+1 WHERE workspace_id=$1', [w]);
  await db.exec('ROLLBACK');
  const counter = await db.query('SELECT last_seq FROM workspace_event_counters WHERE workspace_id=$1', [w]);
  assert.equal(Number(counter.rows[0].last_seq), 0, 'rolled-back event must not consume its cursor');
  const tables = await db.query("SELECT count(*)::int AS total FROM information_schema.tables WHERE table_schema='public'");
  findings.push(`${tables.rows[0].total} SQL tables created; active-run, decision, usage, and cursor constraints checked`);
} finally { await db.close(); }

const output = path.join(root, '.validation');
await mkdir(output, { recursive: true });
const compilation = spawnSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', 'tsconfig.reference.json'], { cwd: root, encoding: 'utf8' });
assert.equal(compilation.status, 0, `Strict reference compilation failed:\n${compilation.stdout}\n${compilation.stderr}`);
findings.push('Reference contracts and connectors compiled under strict TypeScript settings');
const connectorPath = path.join(output, 'reference', 'reference-connectors.js');
const { FakeConnector } = await import(pathToFileURL(connectorPath).href);
const fake = new FakeConnector(new Map([[task.source.externalId, task]]));
const pluginContext = { instanceId: task.source.instanceId, taskId: task.taskId, contextRevision: 1, repository: task.repository, fetchedAt: task.provenance.fetchedAt, http: { request: () => { throw new Error('Unexpected network request'); } } };
const ref = await fake.normalizePayload({ kind: 'identifier', identifier: task.source.externalId }, pluginContext);
const returnedTask = await fake.fetchTask(ref, pluginContext);
assert.deepEqual(returnedTask, task);
returnedTask.title = 'mutated';
assert.equal((await fake.fetchTask(ref, pluginContext)).title, task.title, 'fake must not leak mutable stored task references');
const comment = { ref, body: 'Approved report', operationId: 'comment-1' };
assert.equal((await fake.postComment(comment, pluginContext)).status, 'APPLIED');
assert.equal((await fake.postComment(comment, pluginContext)).status, 'ALREADY_APPLIED');
assert.equal(fake.comments.length, 1);
findings.push('Fake connector context isolation and comment operation replay checked');
await writeFile(path.join(output, 'documentation-report.json'), JSON.stringify({ checkedAt: new Date().toISOString(), findings }, null, 2));
for (const finding of findings) process.stdout.write(`${finding}\n`);
