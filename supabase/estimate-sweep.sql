-- A sweep every 5 minutes for photos the estimator missed (run after estimate.sql).
-- Each new photo row starts the estimate-cover function straight away, but when a phone uploads a walk's
-- photos in a burst, Supabase refuses some of those starts (546 WORKER_RESOURCE_LIMIT) and nothing retried
-- them. The function itself only picks up photos not yet estimated (up to 5 per call), so calling it on a
-- timer is safe: when there's nothing to do it costs one small query.
-- To switch it off: select cron.unschedule('estimate-sweep');

create extension if not exists pg_cron;

select cron.unschedule('estimate-sweep') where exists (select 1 from cron.job where jobname = 'estimate-sweep');
select cron.schedule('estimate-sweep', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://kjllmohuevseekjaeqth.supabase.co/functions/v1/estimate-cover',
    body := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 150000);
$$);
