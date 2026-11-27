-- 007 — Record *who* accepted or declined a public proposal.
--
-- Acceptance used to write only a status and a timestamp: the client's name went
-- into the activity log and nowhere else, so a proposal page could not show who
-- signed off. Declines had the same problem with the reason the client typed.
-- Both are needed for a real audit trail, so store them on the row.

alter table proposals add column accepted_by_name text;
alter table proposals add column rejected_reason text;
