-- Infinity Workspace :: client organisations in global search
--
-- Organisations are now indexed as they are created and edited. This indexes the ones
-- that already exist. Search gates the 'client' type on external_org.read at query time,
-- so a company-wide ACL here does not expose client names to roles that cannot read them.
-- UUID() and INSERT ... SELECT ... ON DUPLICATE KEY UPDATE behave the same on MySQL 8
-- and MariaDB.

INSERT INTO search_documents
  (id, company_id, doc_type, resource_id, title, body, classification,
   acl_user_ids, acl_group_ids, acl_company_wide, link)
SELECT UUID(), o.company_id, 'client', o.id, o.name,
       CONCAT_WS(' ', o.name, o.contact_name, o.billing_email, o.city, o.country, o.website),
       'internal', JSON_ARRAY(), JSON_ARRAY(), 1, CONCAT('/clients/', o.id)
  FROM external_organizations o
ON DUPLICATE KEY UPDATE
  title = VALUES(title),
  body  = VALUES(body),
  link  = VALUES(link);
