-- Scope durable queue/lease recovery by agent bot.
-- Legacy 3-arg bot_recover_next_batch callers keep global behavior (p_agent_bot_id NULL).
-- Helio-provisioned workflows pass agent_bot_id as the 4th argument.

ALTER TABLE bot_inbound_events
  ADD COLUMN IF NOT EXISTS agent_bot_id BIGINT;

ALTER TABLE bot_conversation_leases
  ADD COLUMN IF NOT EXISTS agent_bot_id BIGINT;

ALTER TABLE bot_outbound_effects
  ADD COLUMN IF NOT EXISTS agent_bot_id BIGINT;

CREATE INDEX IF NOT EXISTS bot_inbound_events_agent_bot_queue_idx
  ON bot_inbound_events (agent_bot_id, status, account_id, conversation_id, received_at);

CREATE INDEX IF NOT EXISTS bot_conversation_leases_agent_bot_ready_idx
  ON bot_conversation_leases (agent_bot_id, quiet_until, lease_until);

-- Replace the 3-arg overload with a single 4-arg function (default NULL = global).
-- Leaving both signatures makes Postgres reject 3-arg calls as "not unique".
DROP FUNCTION IF EXISTS bot_recover_next_batch(text, integer, integer);

CREATE OR REPLACE FUNCTION bot_ingest_event(
  p_account_id BIGINT,
  p_conversation_id BIGINT,
  p_delivery_id TEXT,
  p_message_id TEXT,
  p_event_type TEXT,
  p_event_timestamp TIMESTAMPTZ,
  p_content TEXT,
  p_normalized_event JSONB,
  p_raw_event JSONB,
  p_debounce_ms INTEGER DEFAULT 2000,
  p_agent_bot_id BIGINT DEFAULT NULL
)
RETURNS TABLE (accepted BOOLEAN, event_id BIGINT, reason TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_event_id BIGINT;
BEGIN
  IF p_account_id IS NULL OR p_conversation_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::BIGINT, 'missing_conversation_key'::TEXT;
    RETURN;
  END IF;
  IF NULLIF(p_delivery_id, '') IS NULL AND NULLIF(p_message_id, '') IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::BIGINT, 'missing_idempotency_key'::TEXT;
    RETURN;
  END IF;

  INSERT INTO bot_inbound_events (
    account_id, conversation_id, delivery_id, message_id, event_type,
    event_timestamp, content, normalized_event, raw_event, agent_bot_id
  ) VALUES (
    p_account_id, p_conversation_id, NULLIF(p_delivery_id, ''),
    NULLIF(p_message_id, ''), COALESCE(NULLIF(p_event_type, ''), 'unknown'),
    p_event_timestamp, COALESCE(p_content, ''), COALESCE(p_normalized_event, '{}'::jsonb),
    COALESCE(p_raw_event, '{}'::jsonb), p_agent_bot_id
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::BIGINT, 'duplicate'::TEXT;
    RETURN;
  END IF;

  INSERT INTO bot_conversation_leases (account_id, conversation_id, quiet_until, agent_bot_id)
  VALUES (
    p_account_id,
    p_conversation_id,
    clock_timestamp() + make_interval(secs => GREATEST(p_debounce_ms, 0)::DOUBLE PRECISION / 1000.0),
    p_agent_bot_id
  )
  ON CONFLICT (account_id, conversation_id) DO UPDATE
  SET quiet_until = GREATEST(
        bot_conversation_leases.quiet_until,
        clock_timestamp() + make_interval(secs => GREATEST(p_debounce_ms, 0)::DOUBLE PRECISION / 1000.0)
      ),
      agent_bot_id = COALESCE(EXCLUDED.agent_bot_id, bot_conversation_leases.agent_bot_id),
      updated_at = clock_timestamp();

  RETURN QUERY SELECT TRUE, v_event_id, 'accepted'::TEXT;
END;
$$;

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
BEGIN
  UPDATE bot_inbound_events e
  SET status = CASE WHEN e.attempts >= p_max_attempts THEN 'dead_letter' ELSE 'pending' END,
      batch_id = CASE WHEN e.attempts >= p_max_attempts THEN e.batch_id ELSE NULL END,
      last_error = COALESCE(e.last_error, 'processing lease expired'),
      updated_at = clock_timestamp()
  FROM bot_conversation_leases l
  WHERE e.account_id = l.account_id
    AND e.conversation_id = l.conversation_id
    AND e.status = 'processing'
    AND l.lease_until <= clock_timestamp()
    AND (p_agent_bot_id IS NULL OR e.agent_bot_id IS NOT DISTINCT FROM p_agent_bot_id);

  UPDATE bot_conversation_leases
  SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE lease_until <= clock_timestamp()
    AND (p_agent_bot_id IS NULL OR agent_bot_id IS NOT DISTINCT FROM p_agent_bot_id);

  SELECT l.account_id, l.conversation_id
  INTO v_account_id, v_conversation_id
  FROM bot_conversation_leases l
  WHERE l.quiet_until <= clock_timestamp()
    AND (l.lease_until IS NULL OR l.lease_until <= clock_timestamp())
    AND (p_agent_bot_id IS NULL OR l.agent_bot_id IS NOT DISTINCT FROM p_agent_bot_id)
    AND EXISTS (
      SELECT 1 FROM bot_inbound_events e
      WHERE e.account_id = l.account_id
        AND e.conversation_id = l.conversation_id
        AND e.status = 'pending'
        AND (p_agent_bot_id IS NULL OR e.agent_bot_id IS NOT DISTINCT FROM p_agent_bot_id)
    )
  ORDER BY l.quiet_until
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::BIGINT[], 'no_recovery_work'::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT * FROM bot_claim_conversation_batch(v_account_id, v_conversation_id, p_owner, 0, p_lease_seconds);
END;
$$;
