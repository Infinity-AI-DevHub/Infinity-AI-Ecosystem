-- Folders can be renamed, removed and put in a deliberate order.
--
-- `sort_order` rather than sorting by name: a drive's folders have a working order that
-- is not alphabetical - the one people use most goes first - and every file manager that
-- refuses this is fought by its users renaming things "1 Admin", "2 Clients".
--
-- Defaulted to 0 so existing rows keep their current (path) ordering until somebody
-- drags one, at which point the whole set is written with explicit positions.
ALTER TABLE folders ADD COLUMN sort_order INT NOT NULL DEFAULT 0;

CREATE INDEX idx_folders_order ON folders (company_id, parent_id, sort_order);
