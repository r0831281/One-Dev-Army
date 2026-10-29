BEGIN;
-- Task keys such as ABC-44 are worked in the repository that claims their prefix (ABC).
ALTER TABLE repositories ADD COLUMN IF NOT EXISTS task_key_prefixes text[] NOT NULL DEFAULT '{}';
COMMIT;
