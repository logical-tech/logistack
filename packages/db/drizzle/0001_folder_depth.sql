-- Folders nest at most two levels: a folder with a parent cannot itself be a parent.
-- Mirrors checkFolderPlacement() in @logistack/core.
CREATE OR REPLACE FUNCTION folder_depth_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	parent_row folder%ROWTYPE;
BEGIN
	IF NEW.parent_id IS NULL THEN
		RETURN NEW;
	END IF;

	IF NEW.parent_id = NEW.id THEN
		RAISE EXCEPTION 'folder % cannot be its own parent', NEW.id USING ERRCODE = 'check_violation';
	END IF;

	-- FOR SHARE serializes against a concurrent move of the parent under another folder.
	SELECT * INTO parent_row FROM folder WHERE id = NEW.parent_id FOR SHARE;

	IF parent_row.organization_id <> NEW.organization_id THEN
		RAISE EXCEPTION 'folder % and its parent % belong to different organizations', NEW.id, NEW.parent_id
			USING ERRCODE = 'check_violation';
	END IF;

	IF parent_row.parent_id IS NOT NULL THEN
		RAISE EXCEPTION 'folder depth exceeds 2: parent % is already a subfolder', NEW.parent_id
			USING ERRCODE = 'check_violation';
	END IF;

	IF EXISTS (SELECT 1 FROM folder WHERE parent_id = NEW.id) THEN
		RAISE EXCEPTION 'folder depth exceeds 2: folder % has subfolders', NEW.id
			USING ERRCODE = 'check_violation';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER folder_depth
	BEFORE INSERT OR UPDATE OF parent_id, organization_id ON folder
	FOR EACH ROW EXECUTE FUNCTION folder_depth_check();
