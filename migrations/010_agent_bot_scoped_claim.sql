-- Scope conversation leases + batch claims by agent bot.
-- Lease PK becomes (account_id, conversation_id, agent_bot_id) so two bots
-- cannot share / overwrite one another's debounce lease.
-- NULL agent_bot_id is normalized to 0 (legacy global callers).
-- Helio-provisioned workflows pass the real agent bot id.
-- DROP the old 5-arg claim signature so Postgres does not reject calls as ambiguous.

ALTER TABLE bot_conversation_leases
  ADD COLUMN IF NOT EXISTS agent_bot_id BIGINT;

UPDATE bot_conversation_leases
SET agent_bot_id = 0
WHERE agent_bot_id IS NULL;

ALTER TABLE bot_conversation_leases
  ALTER COLUMN agent_bot_id SET DEFAULT 0,
  ALTER COLUMN agent_bot_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bot_conversation_leases_pkey'
      AND conrelid = 'bot_conversation_leases'::regclass
  ) THEN
    ALTER TABLE bot_conversation_leases DROP CONSTRAINT bot_conversation_leases_pkey;
  END IF;
END $$;

ALTER TABLE bot_conversation_leases
  ADD PRIMARY KEY (account_id, conversation_id, agent_bot_id);

CREATE INDEX IF NOT EXISTS bot_conversation_leases_agent_bot_ready_idx
  ON bot_conversation_leases (agent_bot_id, quiet_until, lease_until);

DROP FUNCTION IF EXISTS bot_claim_conversation_batch(bigint, bigint, text, integer, integer);

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
  v_agent_bot_id BIGINT := COALESCE(p_agent_bot_id, 0);
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
    COALESCE(p_raw_event, '{}'::jsonb), v_agent_bot_id
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
    v_agent_bot_id
  )
  ON CONFLICT (account_id, conversation_id, agent_bot_id) DO UPDATE
  SET quiet_until = GREATEST(
        bot_conversation_leases.quiet_until,
        clock_timestamp() + make_interval(secs => GREATEST(p_debounce_ms, 0)::DOUBLE PRECISION / 1000.0)
      ),
      updated_at = clock_timestamp();

  RETURN QUERY SELECT TRUE, v_event_id, 'accepted'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION bot_claim_conversation_batch(
  p_account_id BIGINT,
  p_conversation_id BIGINT,
  p_owner TEXT,
  p_wait_ms INTEGER DEFAULT 300000,
  p_lease_seconds INTEGER DEFAULT 300,
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
  v_claimed BOOLEAN := FALSE;
  v_reason TEXT;
  v_ids BIGINT[];
  v_context JSONB;
  v_content TEXT;
  v_batch_id TEXT;
  v_agent_bot_id BIGINT := COALESCE(p_agent_bot_id, 0);
BEGIN
  -- p_wait_ms is retained for backwards-compatible calls but intentionally
  -- ignored. Waiting belongs in n8n; this function makes one atomic attempt
  -- and never pins a Postgres connection while another execution is working.
  UPDATE bot_conversation_leases
  SET lease_owner = p_owner,
      lease_until = clock_timestamp() + make_interval(secs => GREATEST(p_lease_seconds, 30)),
      updated_at = clock_timestamp()
  WHERE account_id = p_account_id
    AND conversation_id = p_conversation_id
    AND agent_bot_id = v_agent_bot_id
    AND quiet_until <= clock_timestamp()
    AND (lease_until IS NULL OR lease_until <= clock_timestamp() OR lease_owner = p_owner)
    AND EXISTS (
      SELECT 1 FROM bot_inbound_events e
      WHERE e.account_id = p_account_id
        AND e.conversation_id = p_conversation_id
        AND e.status = 'pending'
        AND COALESCE(e.agent_bot_id, 0) = v_agent_bot_id
    )
  RETURNING TRUE INTO v_claimed;

  IF NOT COALESCE(v_claimed, FALSE) THEN
    SELECT CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM bot_inbound_events e
        WHERE e.account_id = p_account_id
          AND e.conversation_id = p_conversation_id
          AND e.status = 'pending'
          AND COALESCE(e.agent_bot_id, 0) = v_agent_bot_id
      ) THEN 'empty_queue'
      WHEN l.quiet_until > clock_timestamp() THEN 'quiet_window_open'
      WHEN l.lease_until > clock_timestamp() AND l.lease_owner IS DISTINCT FROM p_owner THEN 'lease_busy'
      ELSE 'claim_conflict'
    END
    INTO v_reason
    FROM bot_conversation_leases l
    WHERE l.account_id = p_account_id
      AND l.conversation_id = p_conversation_id
      AND l.agent_bot_id = v_agent_bot_id;

    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::BIGINT[], COALESCE(v_reason, 'missing_lease')::TEXT;
    RETURN;
  END IF;

  SELECT array_agg(e.id ORDER BY COALESCE(e.event_timestamp, e.received_at), e.id),
         string_agg(e.content, E'\n' ORDER BY COALESCE(e.event_timestamp, e.received_at), e.id),
         (array_agg(e.normalized_event ORDER BY COALESCE(e.event_timestamp, e.received_at) DESC, e.id DESC))[1]
  INTO v_ids, v_content, v_context
  FROM bot_inbound_events e
  WHERE e.account_id = p_account_id
    AND e.conversation_id = p_conversation_id
    AND e.status = 'pending'
    AND e.received_at <= clock_timestamp()
    AND COALESCE(e.agent_bot_id, 0) = v_agent_bot_id;

  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    UPDATE bot_conversation_leases
    SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
    WHERE account_id = p_account_id
      AND conversation_id = p_conversation_id
      AND agent_bot_id = v_agent_bot_id
      AND lease_owner = p_owner;
    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::BIGINT[], 'empty_queue'::TEXT;
    RETURN;
  END IF;

  v_batch_id := md5(
    p_account_id::TEXT || ':' || p_conversation_id::TEXT || ':' || v_agent_bot_id::TEXT || ':' || array_to_string(v_ids, ',')
  );

  UPDATE bot_inbound_events
  SET status = 'processing', batch_id = v_batch_id, processing_started_at = clock_timestamp(),
      attempts = attempts + 1, updated_at = clock_timestamp()
  WHERE id = ANY(v_ids);

  RETURN QUERY SELECT TRUE, v_batch_id, COALESCE(v_context, '{}'::jsonb), COALESCE(v_content, ''), v_ids, 'claimed'::TEXT;
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
  v_lease_bot_id BIGINT;
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
    AND (p_agent_bot_id IS NULL OR l.agent_bot_id = v_agent_bot_id);

  UPDATE bot_conversation_leases
  SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE lease_until <= clock_timestamp()
    AND (p_agent_bot_id IS NULL OR agent_bot_id = v_agent_bot_id);

  SELECT l.account_id, l.conversation_id, l.agent_bot_id
  INTO v_account_id, v_conversation_id, v_lease_bot_id
  FROM bot_conversation_leases l
  WHERE l.quiet_until <= clock_timestamp()
    AND (l.lease_until IS NULL OR l.lease_until <= clock_timestamp())
    AND (p_agent_bot_id IS NULL OR l.agent_bot_id = v_agent_bot_id)
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

CREATE OR REPLACE FUNCTION bot_finalize_batch(
  p_batch_id TEXT,
  p_owner TEXT,
  p_error TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id BIGINT;
  v_conversation_id BIGINT;
  v_agent_bot_id BIGINT;
BEGIN
  SELECT account_id, conversation_id, COALESCE(agent_bot_id, 0)
  INTO v_account_id, v_conversation_id, v_agent_bot_id
  FROM bot_inbound_events
  WHERE batch_id = p_batch_id
  LIMIT 1;

  UPDATE bot_inbound_events
  SET status = CASE WHEN p_error IS NULL THEN 'processed' ELSE 'failed' END,
      processed_at = CASE WHEN p_error IS NULL THEN clock_timestamp() ELSE processed_at END,
      last_error = p_error, updated_at = clock_timestamp()
  WHERE batch_id = p_batch_id;

  UPDATE bot_conversation_leases
  SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE account_id = v_account_id
    AND conversation_id = v_conversation_id
    AND agent_bot_id = COALESCE(v_agent_bot_id, 0)
    AND lease_owner = p_owner;
END;
$$;

CREATE OR REPLACE FUNCTION bot_cleanup_idempotency(p_retention_days INTEGER DEFAULT 30)
RETURNS TABLE (inbound_deleted BIGINT, effects_deleted BIGINT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_inbound BIGINT;
  v_effects BIGINT;
BEGIN
  DELETE FROM bot_outbound_effects
  WHERE updated_at < clock_timestamp() - make_interval(days => GREATEST(p_retention_days, 1));
  GET DIAGNOSTICS v_effects = ROW_COUNT;

  DELETE FROM bot_inbound_events
  WHERE updated_at < clock_timestamp() - make_interval(days => GREATEST(p_retention_days, 1))
    AND status IN ('processed', 'dead_letter');
  GET DIAGNOSTICS v_inbound = ROW_COUNT;

  DELETE FROM bot_conversation_leases l
  WHERE l.updated_at < clock_timestamp() - make_interval(days => GREATEST(p_retention_days, 1))
    AND NOT EXISTS (
      SELECT 1 FROM bot_inbound_events e
      WHERE e.account_id = l.account_id
        AND e.conversation_id = l.conversation_id
        AND COALESCE(e.agent_bot_id, 0) = l.agent_bot_id
    );

  RETURN QUERY SELECT v_inbound, v_effects;
END;
$$;
