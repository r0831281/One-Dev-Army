BEGIN;
ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_state_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_state_check CHECK(state IN ('QUEUED','CONTEXT_REVIEW','AWAITING_CONTEXT','PLANNING','AWAITING_PLAN','IMPLEMENTING','TESTING','REVIEWING','AWAITING_FINAL','REPORTING','REPORT_PENDING','COMPLETED','FAILED','CANCELLING','CANCELLED','NEEDS_ATTENTION')) NOT VALID;
ALTER TABLE workflow_runs VALIDATE CONSTRAINT workflow_runs_state_check;
ALTER TABLE decision_gates DROP CONSTRAINT IF EXISTS decision_gates_kind_check;
ALTER TABLE decision_gates ADD CONSTRAINT decision_gates_kind_check CHECK(kind IN ('CLARIFICATION','PLAN_APPROVAL','RECOVERY','FINAL_APPROVAL')) NOT VALID;
ALTER TABLE decision_gates VALIDATE CONSTRAINT decision_gates_kind_check;

CREATE TABLE IF NOT EXISTS agent_profiles (
  id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  profile jsonb NOT NULL,
  profile_sha256 text NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(id,revision), UNIQUE(workspace_id,name,revision)
);
CREATE TABLE IF NOT EXISTS prompt_artifacts (
  id uuid PRIMARY KEY,
  profile_id uuid NOT NULL,
  profile_revision integer NOT NULL,
  prompt_sha256 text NOT NULL CHECK(prompt_sha256 ~ '^[a-f0-9]{64}$'),
  compiler_version text NOT NULL,
  template_revision integer NOT NULL,
  schema_sha256 text NOT NULL CHECK(schema_sha256 ~ '^[a-f0-9]{64}$'),
  policy_sha256 text NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'),
  artifact jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(profile_id,profile_revision,prompt_sha256),
  FOREIGN KEY(profile_id,profile_revision) REFERENCES agent_profiles(id,revision)
);
CREATE TABLE IF NOT EXISTS pricing_snapshots (
  id uuid PRIMARY KEY, provider text NOT NULL, model text NOT NULL, currency text NOT NULL DEFAULT 'USD', prices jsonb NOT NULL,
  effective_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider,model,effective_at)
);
CREATE TABLE IF NOT EXISTS model_usage (
  attempt_id uuid PRIMARY KEY, operation_id uuid NOT NULL UNIQUE, run_id uuid NOT NULL REFERENCES workflow_runs(id), step_id uuid REFERENCES agent_steps(id),
  provider text NOT NULL, model text NOT NULL, category text NOT NULL CHECK(category IN ('model','sandbox-compute')),
  input_tokens bigint CHECK(input_tokens >= 0), output_tokens bigint CHECK(output_tokens >= 0), cache_read_tokens bigint CHECK(cache_read_tokens >= 0),
  cache_write_tokens bigint CHECK(cache_write_tokens >= 0), reasoning_tokens bigint CHECK(reasoning_tokens >= 0), amount_microusd bigint CHECK(amount_microusd >= 0),
  pricing_snapshot_id uuid REFERENCES pricing_snapshots(id), usage jsonb NOT NULL, observed_at timestamptz NOT NULL,
  CHECK((amount_microusd IS NULL) = (pricing_snapshot_id IS NULL))
);
CREATE TABLE IF NOT EXISTS usage_adjustments (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL REFERENCES model_usage(attempt_id), delta_microusd bigint, final_usage jsonb NOT NULL,
  reason text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_reservations (
  operation_id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), max_microusd bigint, state text NOT NULL CHECK(state IN ('RESERVED','CONSUMED','RELEASED')),
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_instances (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), backend text NOT NULL CHECK(backend IN ('docker','e2b')), external_handle text,
  policy_sha256 text NOT NULL CHECK(policy_sha256 ~ '^[a-f0-9]{64}$'), state text NOT NULL CHECK(state IN ('PROVISIONING','READY','DESTROYING','DESTROYED','LEAKED')),
  expires_at timestamptz NOT NULL, destroyed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sandbox_command_receipts (
  operation_id uuid PRIMARY KEY, sandbox_id uuid NOT NULL REFERENCES sandbox_instances(id), request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('RUNNING','COMPLETED','CANCELLED','TIMED_OUT','OUTPUT_LIMIT')), receipt jsonb NOT NULL,
  started_at timestamptz NOT NULL, completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS candidate_artifacts (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), generation integer NOT NULL CHECK(generation >= 0), candidate_sha256 text NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),
  base_sha text NOT NULL, diff_locator text NOT NULL, sealed_at timestamptz NOT NULL, superseded_at timestamptz, UNIQUE(run_id,generation), UNIQUE(run_id,candidate_sha256)
);
CREATE TABLE IF NOT EXISTS execution_evidence (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES workflow_runs(id), candidate_sha256 text NOT NULL CHECK(candidate_sha256 ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('test','static','review','usage','final-bundle')), operation_id uuid NOT NULL UNIQUE, artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
  passed boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS telemetry_logs (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), run_id uuid REFERENCES workflow_runs(id), seq bigint NOT NULL,
  level text NOT NULL, body jsonb NOT NULL, body_sha256 text NOT NULL CHECK(body_sha256 ~ '^[a-f0-9]{64}$'), redaction_version integer NOT NULL,
  occurred_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, UNIQUE(workspace_id,seq)
);
CREATE TABLE IF NOT EXISTS journal_epochs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id), epoch uuid NOT NULL, starts_at_seq bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,epoch)
);

DROP TRIGGER IF EXISTS agent_profiles_immutable ON agent_profiles;
CREATE TRIGGER agent_profiles_immutable BEFORE UPDATE OR DELETE ON agent_profiles FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS prompt_artifacts_immutable ON prompt_artifacts;
CREATE TRIGGER prompt_artifacts_immutable BEFORE UPDATE OR DELETE ON prompt_artifacts FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS pricing_snapshots_immutable ON pricing_snapshots;
CREATE TRIGGER pricing_snapshots_immutable BEFORE UPDATE OR DELETE ON pricing_snapshots FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS model_usage_immutable ON model_usage;
CREATE TRIGGER model_usage_immutable BEFORE UPDATE OR DELETE ON model_usage FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS usage_adjustments_immutable ON usage_adjustments;
CREATE TRIGGER usage_adjustments_immutable BEFORE UPDATE OR DELETE ON usage_adjustments FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS execution_evidence_immutable ON execution_evidence;
CREATE TRIGGER execution_evidence_immutable BEFORE UPDATE OR DELETE ON execution_evidence FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
COMMIT;
