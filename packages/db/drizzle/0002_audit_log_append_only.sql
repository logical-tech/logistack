-- audit_log is append-only. DELETE stays allowed for retention until monthly partitions replace it.
CREATE OR REPLACE FUNCTION audit_log_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only
	BEFORE UPDATE ON audit_log
	FOR EACH ROW EXECUTE FUNCTION audit_log_no_update();
