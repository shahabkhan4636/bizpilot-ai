-- Reverses 001_initial.up.sql. Destroys all tenant data: only for a disposable
-- environment (CI, staging, a developer machine). Never run in production.
drop table if exists rate_limits;
drop table if exists webhook_events;
drop table if exists audit_logs;
drop table if exists usage_records;
drop table if exists support_tickets;
drop table if exists notifications;
drop table if exists messages;
drop table if exists documents;
drop table if exists automation_executions;
drop table if exists automation_steps;
drop table if exists automations;
drop table if exists proposal_items;
drop table if exists proposals;
drop table if exists tasks;
drop table if exists activities;
drop table if exists lead_notes;
drop table if exists leads;
drop table if exists customers;
drop table if exists subscriptions;
drop table if exists plans;
drop table if exists org_invites;
drop table if exists organization_members;
drop table if exists organizations;
drop table if exists password_resets;
drop table if exists sessions;
drop table if exists profiles;
