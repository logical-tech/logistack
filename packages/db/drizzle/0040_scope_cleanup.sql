-- env_var and secret point at their scope polymorphically (scope, scope_id), so no FK removes
-- them with the scope. These triggers do: a deleted service, environment, project or folder
-- takes its variables and secrets with it. A secret still referenced from elsewhere stops the
-- delete (env_var.secret_id is ON DELETE RESTRICT).
-- Named `trg_*` so they fire after the RI cascade triggers (`RI_ConstraintTrigger_*` sorts first):
-- a project's services and their reference rows are already gone when its secrets are removed.
CREATE OR REPLACE FUNCTION scope_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_ARGV[0] <> 'folder' THEN
		DELETE FROM env_var WHERE scope = TG_ARGV[0]::env_var_scope AND scope_id = OLD.id;
	END IF;
	DELETE FROM secret WHERE scope = TG_ARGV[0]::secret_scope AND scope_id = OLD.id;
	RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_service_scope_cleanup AFTER DELETE ON service
	FOR EACH ROW EXECUTE FUNCTION scope_cleanup('service');
--> statement-breakpoint
CREATE TRIGGER trg_environment_scope_cleanup AFTER DELETE ON environment
	FOR EACH ROW EXECUTE FUNCTION scope_cleanup('environment');
--> statement-breakpoint
CREATE TRIGGER trg_project_scope_cleanup AFTER DELETE ON project
	FOR EACH ROW EXECUTE FUNCTION scope_cleanup('project');
--> statement-breakpoint
CREATE TRIGGER trg_folder_scope_cleanup AFTER DELETE ON folder
	FOR EACH ROW EXECUTE FUNCTION scope_cleanup('folder');
