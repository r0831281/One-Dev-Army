BEGIN;
CREATE OR REPLACE FUNCTION oda_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable ledger: %', TG_TABLE_NAME; END $$;
DROP TRIGGER IF EXISTS task_contexts_immutable ON task_contexts;
CREATE TRIGGER task_contexts_immutable BEFORE UPDATE OR DELETE ON task_contexts
FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
DROP TRIGGER IF EXISTS outbox_events_immutable ON outbox_events;
CREATE TRIGGER outbox_events_immutable BEFORE UPDATE OR DELETE ON outbox_events
FOR EACH ROW EXECUTE FUNCTION oda_reject_mutation();
COMMIT;
