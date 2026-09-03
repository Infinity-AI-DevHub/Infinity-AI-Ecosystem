-- Signing is limited to administrators.
--
-- A signature on a quotation, invoice or receipt commits the company to a number, and
-- the record written beside it names the account that did so. That is an authority
-- decision, not a seniority one, so it stops at admin and super_admin - `manager` held
-- it until now and no longer does.
--
-- Existing signatures are untouched: they record who signed and when, and rewriting
-- history because a permission changed would defeat the point of keeping it.
DELETE FROM role_capabilities
 WHERE capability IN ('document.sign', 'document.sign.client')
   AND role NOT IN ('admin', 'super_admin');
