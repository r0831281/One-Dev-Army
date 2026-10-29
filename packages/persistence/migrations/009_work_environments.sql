BEGIN;
-- Where local Odoo work environments, backups and the restore script live, per workspace.
CREATE TABLE IF NOT EXISTS work_environment_settings (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  root text NOT NULL,
  backup_dir text NOT NULL,
  restore_script text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
