-- Infinity Workspace :: client contacts in search open their organisation
--
-- Guests were indexed with a link to /people/:id, but the People directory does not list
-- them, so the result opened an empty page. New invitations now link to the client
-- organisation; this corrects the rows already indexed. Portable UPDATE ... JOIN, valid
-- on MySQL 8 and MariaDB.

UPDATE search_documents sd
  JOIN users u
    ON u.id = sd.resource_id AND u.company_id = sd.company_id AND u.access_level = 'guest'
  JOIN external_memberships m
    ON m.user_id = u.id AND m.company_id = u.company_id
   SET sd.link = CONCAT('/clients/', m.organization_id)
 WHERE sd.doc_type = 'person';
