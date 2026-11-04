BEGIN;
-- Image bytes read from task sources (Odoo attachments, Jira attachments, inline data URIs), shared by the API that
-- fetches them and the worker that sends them to the model. Rows are keyed by source identity so a sync can skip
-- images it already holds; the bytes behind a key never change.
CREATE TABLE IF NOT EXISTS source_images (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  source_ref text NOT NULL CHECK(length(source_ref) BETWEEN 1 AND 300),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  media_type text NOT NULL CHECK(media_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  size_bytes integer NOT NULL CHECK(size_bytes > 0),
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id, source_ref)
);
CREATE INDEX IF NOT EXISTS source_images_sha ON source_images(workspace_id, sha256);
DROP TRIGGER IF EXISTS source_images_immutable ON source_images;
CREATE TRIGGER source_images_immutable BEFORE UPDATE ON source_images
FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
COMMIT;
