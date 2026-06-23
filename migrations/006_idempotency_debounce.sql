-- Durable Chatwoot delivery idempotency, conversation serialization, debounce,
-- and outbound-effect tracking for the ProGolf support workflow.
-- Apply after the existing bot support-state migrations.

CREATE TABLE IF NOT EXISTS bot_inbound_events (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  delivery_id TEXT,
  message_id TEXT,
  event_type TEXT NOT NULL,
  event_timestamp TIMESTAMPTZ,
  content TEXT NOT NULL DEFAULT '',
  normalized_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  batch_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  processing_started_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (delivery_id IS NOT NULL OR message_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_inbound_events_delivery_uidx
  ON bot_inbound_events (account_id, delivery_id)
  WHERE delivery_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bot_inbound_events_message_uidx
  ON bot_inbound_events (account_id, message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bot_inbound_events_queue_idx
  ON bot_inbound_events (status, account_id, conversation_id, received_at);

CREATE TABLE IF NOT EXISTS bot_conversation_leases (
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  quiet_until TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS bot_conversation_leases_ready_idx
  ON bot_conversation_leases (quiet_until, lease_until);

CREATE TABLE IF NOT EXISTS bot_outbound_effects (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  batch_id TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  request_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed', 'dead_letter')),
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 1,
  response_data JSONB,
  remote_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT bot_outbound_effects_effect_key_key UNIQUE (effect_key)
);

CREATE INDEX IF NOT EXISTS bot_outbound_effects_batch_idx
  ON bot_outbound_effects (batch_id, status);

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
  p_debounce_ms INTEGER DEFAULT 2000
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
    event_timestamp, content, normalized_event, raw_event
  ) VALUES (
    p_account_id, p_conversation_id, NULLIF(p_delivery_id, ''),
    NULLIF(p_message_id, ''), COALESCE(NULLIF(p_event_type, ''), 'unknown'),
    p_event_timestamp, COALESCE(p_content, ''), COALESCE(p_normalized_event, '{}'::jsonb),
    COALESCE(p_raw_event, '{}'::jsonb)
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_event_id;

  IF v_event_id IS NULL THEN
    RETURN QUERY SELECT FALSE, NULL::BIGINT, 'duplicate'::TEXT;
    RETURN;
  END IF;

  INSERT INTO bot_conversation_leases (account_id, conversation_id, quiet_until)
  VALUES (
    p_account_id,
    p_conversation_id,
    clock_timestamp() + make_interval(secs => GREATEST(p_debounce_ms, 0)::DOUBLE PRECISION / 1000.0)
  )
  ON CONFLICT (account_id, conversation_id) DO UPDATE
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
  p_lease_seconds INTEGER DEFAULT 300
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
    AND quiet_until <= clock_timestamp()
    AND (lease_until IS NULL OR lease_until <= clock_timestamp() OR lease_owner = p_owner)
    AND EXISTS (
      SELECT 1 FROM bot_inbound_events e
      WHERE e.account_id = p_account_id
        AND e.conversation_id = p_conversation_id
        AND e.status = 'pending'
    )
  RETURNING TRUE INTO v_claimed;

  IF NOT COALESCE(v_claimed, FALSE) THEN
    SELECT CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM bot_inbound_events e
        WHERE e.account_id = p_account_id
          AND e.conversation_id = p_conversation_id
          AND e.status = 'pending'
      ) THEN 'empty_queue'
      WHEN l.quiet_until > clock_timestamp() THEN 'quiet_window_open'
      WHEN l.lease_until > clock_timestamp() AND l.lease_owner IS DISTINCT FROM p_owner THEN 'lease_busy'
      ELSE 'claim_conflict'
    END
    INTO v_reason
    FROM bot_conversation_leases l
    WHERE l.account_id = p_account_id AND l.conversation_id = p_conversation_id;

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
    AND e.received_at <= clock_timestamp();

  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    UPDATE bot_conversation_leases
    SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
    WHERE account_id = p_account_id AND conversation_id = p_conversation_id AND lease_owner = p_owner;
    RETURN QUERY SELECT FALSE, NULL::TEXT, NULL::JSONB, NULL::TEXT, NULL::BIGINT[], 'empty_queue'::TEXT;
    RETURN;
  END IF;

  v_batch_id := md5(p_account_id::TEXT || ':' || p_conversation_id::TEXT || ':' || array_to_string(v_ids, ','));

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
  p_max_attempts INTEGER DEFAULT 5
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
    AND l.lease_until <= clock_timestamp();

  UPDATE bot_conversation_leases
  SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE lease_until <= clock_timestamp();

  SELECT l.account_id, l.conversation_id
  INTO v_account_id, v_conversation_id
  FROM bot_conversation_leases l
  WHERE l.quiet_until <= clock_timestamp()
    AND (l.lease_until IS NULL OR l.lease_until <= clock_timestamp())
    AND EXISTS (
      SELECT 1 FROM bot_inbound_events e
      WHERE e.account_id = l.account_id AND e.conversation_id = l.conversation_id AND e.status = 'pending'
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

CREATE OR REPLACE FUNCTION bot_claim_outbound_effect(
  p_account_id BIGINT,
  p_conversation_id BIGINT,
  p_batch_id TEXT,
  p_effect_key TEXT,
  p_effect_type TEXT,
  p_request_data JSONB,
  p_owner TEXT,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (should_run BOOLEAN, effect_key TEXT, reason TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
BEGIN
  INSERT INTO bot_outbound_effects (
    account_id, conversation_id, batch_id, effect_key, effect_type,
    request_data, request_hash, lease_owner, lease_until
  ) VALUES (
    p_account_id, p_conversation_id, p_batch_id, p_effect_key, p_effect_type,
    COALESCE(p_request_data, '{}'::jsonb), md5(COALESCE(p_request_data, '{}'::jsonb)::TEXT),
    p_owner, clock_timestamp() + make_interval(secs => GREATEST(p_lease_seconds, 30))
  )
  ON CONFLICT ON CONSTRAINT bot_outbound_effects_effect_key_key DO NOTHING;

  SELECT status INTO v_status FROM bot_outbound_effects WHERE bot_outbound_effects.effect_key = p_effect_key;
  IF v_status = 'completed' THEN
    RETURN QUERY SELECT FALSE, p_effect_key, 'completed'::TEXT;
    RETURN;
  END IF;

  UPDATE bot_outbound_effects
  SET status = 'processing', lease_owner = p_owner,
      lease_until = clock_timestamp() + make_interval(secs => GREATEST(p_lease_seconds, 30)),
      attempts = CASE WHEN lease_owner IS DISTINCT FROM p_owner THEN attempts + 1 ELSE attempts END,
      updated_at = clock_timestamp()
  WHERE bot_outbound_effects.effect_key = p_effect_key
    AND (lease_owner = p_owner OR lease_until IS NULL OR lease_until <= clock_timestamp() OR status = 'failed');

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, p_effect_key, 'claimed'::TEXT;
  ELSE
    RETURN QUERY SELECT FALSE, p_effect_key, 'busy'::TEXT;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION bot_complete_outbound_effect(
  p_effect_key TEXT,
  p_response_data JSONB DEFAULT '{}'::jsonb,
  p_remote_id TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE bot_outbound_effects
  SET status = 'completed', response_data = COALESCE(p_response_data, '{}'::jsonb),
      remote_id = COALESCE(p_remote_id, remote_id), completed_at = clock_timestamp(),
      lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE effect_key = p_effect_key;
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
BEGIN
  SELECT account_id, conversation_id INTO v_account_id, v_conversation_id
  FROM bot_inbound_events WHERE batch_id = p_batch_id LIMIT 1;

  UPDATE bot_inbound_events
  SET status = CASE WHEN p_error IS NULL THEN 'processed' ELSE 'failed' END,
      processed_at = CASE WHEN p_error IS NULL THEN clock_timestamp() ELSE processed_at END,
      last_error = p_error, updated_at = clock_timestamp()
  WHERE batch_id = p_batch_id;

  UPDATE bot_conversation_leases
  SET lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
  WHERE account_id = v_account_id AND conversation_id = v_conversation_id AND lease_owner = p_owner;
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
      WHERE e.account_id = l.account_id AND e.conversation_id = l.conversation_id
    );

  RETURN QUERY SELECT v_inbound, v_effects;
END;
$$;
