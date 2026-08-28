-- Gives existing manager-based approval steps a fallback approver.
--
-- Every seeded route began with a `manager` step. Anyone at the top of the reporting
-- line has no manager, so the route could not resolve and the request was refused - a
-- chief executive could not raise an expense claim at all. The fallback keeps the
-- control intact (an administrator still approves) while making the route resolvable
-- for everyone. Separation of duties still prevents self-approval.

UPDATE approval_definitions
   SET routing = JSON_REPLACE(
         routing,
         '$[0].approver',
         JSON_OBJECT('type', 'manager',
                     'fallback', JSON_OBJECT('type', 'access_level', 'value', 'admin'))
       )
 WHERE JSON_UNQUOTE(JSON_EXTRACT(routing, '$[0].approver.type')) = 'manager'
   AND JSON_EXTRACT(routing, '$[0].approver.fallback') IS NULL;
