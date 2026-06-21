begin;

alter table public.interview_attempts
  drop constraint if exists chk_interview_attempts_termination_type;

alter table public.interview_attempts
  add constraint chk_interview_attempts_termination_type
  check (
    termination_type is null
    or termination_type in (
      'completed',
      'manual_exit',
      'browser_close',
      'tab_close',
      'disconnect',
      'timeout',
      'watchdog_timeout',
      'network_disconnect_timeout'
    )
  );

commit;
