drop table if exists payment_refunds;
drop index if exists local_payment_requests_gateway_idx;
alter table local_payment_requests drop column gateway_provider;
alter table local_payment_requests drop column gateway_payment_id;
alter table local_payment_requests drop column paid_at;
