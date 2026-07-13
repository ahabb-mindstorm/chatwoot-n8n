-- Unscoped recover (p_agent_bot_id NULL) must only touch legacy agent_bot_id = 0
-- rows. Otherwise old full-bot workflows with 3-arg recover steal Helio ingress
-- events and process them under the wrong credentials.

CREATE OR REPLACE FUNCTION bot_recover_next_batch(
  p_owner TEXT,
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_attempts INTEGER DEFAULT 5,
  p_agent_bot_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  should_process BOOLEAN,
  batch_id TEXT,
  event_context JSONB,
  combined_content TEXT,
  event_ids BIGINT[],
  reason TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id BIGINT;
  v_conversation_id BIGINT;
  v_lease_bot_id BIGINT;
  -- NULL means legacy/global queue only (agent_bot_id 0), never Helio-scoped bots.
  v_agent_bot_id BIGINT := COALESCE(p_agent_bot_id, 0);
BEGIN
  UPDATE bot_inbound_events e
  SET status = CASE WHEN e.attempts >= p_max_attempts THEN 'dead_letter' ELSE 'pending' END,
      batch_id = CASE WHEN e.attempts >= p_max_attempts THEN e.batch_id ELSE NULL END,
      last_error = COALESCE(e.last_error, 'processing lease expired'),
      updated_at = clock_timestamp()
  FROM bot_conversation_leases l
  WHERE e.account_id = l.account_id
    AND e.conversation_id = l.conversation_id
    AND COALESCE(e.agent_bot_id, 0) = l.agent_bot_id
    AND e.status = 'processing'
    AND l.lease_until <= clock_timestamp()
    AND l.agent_bot_id = v_agent_bot_id;

  UPDATE bot_conversation_leases
  SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE lease_until <= clock_timestamp()
    AND agent_bot_id = v_agent_bot_id;

  SELECT l.account_id, l.conversation_id, l.agent_bot_id
  INTO v_account_id, v_conversation_id, v_lease_bot_id
  FROM bot_conversation_leases l
  WHERE l.quiet_until <= clock_timestamp()
    AND (l.lease_until IS NULL OR l.lease_until <= clock_timestamp())
    AND l.agent_bot_id = v_agent_bot_id
    AND EXISTS (
      SELECT 1 FROM bot_inbound_events e
      WHERE e.account_id = l.account_id
        AND e.conversation_id = l.conversation_id
        AND e.status = 'pending'
        AND COALESCE(e.agent_bot_id, 0) = l.agent_bot_id
    )
  ORDER BY l.quiet_until
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::BIGINT[], 'no_recovery_work'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM bot_claim_conversation_batch(
    v_account_id,
    v_conversation_id,
    p_owner,
    0,
    p_lease_seconds,
    v_lease_bot_id
  );
END;
$$;
