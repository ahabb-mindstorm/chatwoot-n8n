-- Atomic SupportRuntime turn receipts, optimistic ticket state, and typed effects.

CREATE TABLE IF NOT EXISTS bot_support_turns (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  agent_bot_id BIGINT NOT NULL,
  delivery_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed_closed')),
  runtime_revision TEXT NOT NULL,
  policy_version INTEGER,
  state_version INTEGER,
  effect_ids TEXT[] NOT NULL DEFAULT '{}',
  failure_code TEXT,
  receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT bot_support_turns_delivery_unique UNIQUE (agent_bot_id, delivery_id)
);

CREATE INDEX IF NOT EXISTS bot_support_turns_ticket_idx
  ON bot_support_turns (agent_bot_id, account_id, conversation_id, created_at DESC);

ALTER TABLE bot_outbound_effects
  DROP CONSTRAINT IF EXISTS bot_outbound_effects_status_check;

ALTER TABLE bot_outbound_effects
  ADD CONSTRAINT bot_outbound_effects_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter'));

CREATE OR REPLACE FUNCTION bot_commit_support_turn(
  p_account_id BIGINT,
  p_conversation_id BIGINT,
  p_agent_bot_id BIGINT,
  p_delivery_id TEXT,
  p_expected_state_version INTEGER,
  p_outcome TEXT,
  p_next_state JSONB,
  p_effects JSONB,
  p_runtime_revision TEXT,
  p_policy_version INTEGER,
  p_failure_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_turn_id BIGINT;
  v_current_version INTEGER;
  v_state_version INTEGER;
  v_phase TEXT := COALESCE(NULLIF(p_next_state->>'phase', ''), 'idle');
  v_db_phase TEXT;
  v_effect JSONB;
  v_effect_ids TEXT[] := '{}';
  v_receipt JSONB;
BEGIN
  IF p_account_id IS NULL OR p_conversation_id IS NULL OR p_agent_bot_id IS NULL THEN
    RAISE EXCEPTION 'support turn scope is required' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(TRIM(p_delivery_id), '') IS NULL THEN
    RAISE EXCEPTION 'support turn delivery id is required' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_effects, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'support turn effects must be an array' USING ERRCODE = '22023';
  END IF;

  INSERT INTO bot_support_turns (
    account_id, conversation_id, agent_bot_id, delivery_id, outcome, status,
    runtime_revision, policy_version, failure_code
  ) VALUES (
    p_account_id, p_conversation_id, p_agent_bot_id, p_delivery_id, p_outcome,
    'processing', p_runtime_revision, p_policy_version, p_failure_code
  )
  ON CONFLICT ON CONSTRAINT bot_support_turns_delivery_unique DO NOTHING
  RETURNING id INTO v_turn_id;

  IF v_turn_id IS NULL THEN
    SELECT receipt INTO v_receipt
      FROM bot_support_turns
     WHERE agent_bot_id = p_agent_bot_id
       AND delivery_id = p_delivery_id;
    RETURN jsonb_build_object('duplicate', TRUE, 'receipt', v_receipt);
  END IF;

  SELECT support_state_version INTO v_current_version
    FROM bot_conversation_state
   WHERE account_id = p_account_id
     AND conversation_id = p_conversation_id
     AND agent_bot_id = p_agent_bot_id
   FOR UPDATE;

  v_db_phase := CASE WHEN v_phase = 'request_form' THEN 'route' ELSE v_phase END;
  IF v_db_phase NOT IN ('idle', 'clarify', 'self_serve', 'route', 'handoff', 'human_owned') THEN
    RAISE EXCEPTION 'invalid support turn phase: %', v_phase USING ERRCODE = '22023';
  END IF;

  IF v_current_version IS NULL THEN
    IF COALESCE(p_expected_state_version, 0) <> 0 THEN
      RAISE EXCEPTION 'ticket state version conflict' USING ERRCODE = '40001';
    END IF;
    INSERT INTO bot_conversation_state (
      account_id, conversation_id, contact_id, agent_bot_id, phase, bot_status,
      case_type, last_intent, support_state, support_state_version,
      clarification_pending, last_seen_at, updated_at
    ) VALUES (
      p_account_id, p_conversation_id, 0, p_agent_bot_id, v_db_phase,
      CASE WHEN v_db_phase = 'human_owned' THEN 'human_owned'
           WHEN v_db_phase = 'handoff' THEN 'handoff'
           ELSE 'active' END,
      NULLIF(p_next_state->>'category', ''), p_outcome,
      COALESCE(p_next_state, '{}'::jsonb), 1,
      v_db_phase = 'clarify', clock_timestamp(), clock_timestamp()
    )
    RETURNING support_state_version INTO v_state_version;
  ELSE
    UPDATE bot_conversation_state
       SET phase = v_db_phase,
           bot_status = CASE WHEN v_db_phase = 'human_owned' THEN 'human_owned'
                             WHEN v_db_phase = 'handoff' THEN 'handoff'
                             ELSE 'active' END,
           case_type = COALESCE(NULLIF(p_next_state->>'category', ''), case_type),
           last_intent = p_outcome,
           support_state = COALESCE(p_next_state, '{}'::jsonb),
           support_state_version = support_state_version + 1,
           clarification_pending = v_db_phase = 'clarify',
           last_seen_at = clock_timestamp(),
           updated_at = clock_timestamp()
     WHERE account_id = p_account_id
       AND conversation_id = p_conversation_id
       AND agent_bot_id = p_agent_bot_id
       AND support_state_version = p_expected_state_version
     RETURNING support_state_version INTO v_state_version;

    IF v_state_version IS NULL THEN
      RAISE EXCEPTION 'ticket state version conflict' USING ERRCODE = '40001';
    END IF;
  END IF;

  FOR v_effect IN SELECT value FROM jsonb_array_elements(COALESCE(p_effects, '[]'::jsonb))
  LOOP
    IF NULLIF(v_effect->>'idempotencyKey', '') IS NULL OR NULLIF(v_effect->>'type', '') IS NULL THEN
      RAISE EXCEPTION 'typed effect requires idempotencyKey and type' USING ERRCODE = '22023';
    END IF;
    INSERT INTO bot_outbound_effects (
      account_id, conversation_id, agent_bot_id, batch_id, effect_key,
      effect_type, request_data, request_hash, status, attempts
    ) VALUES (
      p_account_id, p_conversation_id, p_agent_bot_id, p_delivery_id,
      v_effect->>'idempotencyKey', v_effect->>'type', v_effect,
      md5(v_effect::text), 'pending', 0
    );
    v_effect_ids := array_append(v_effect_ids, v_effect->>'idempotencyKey');
  END LOOP;

  v_receipt := jsonb_build_object(
    'deliveryId', p_delivery_id,
    'outcome', p_outcome,
    'status', CASE WHEN p_failure_code IS NULL THEN 'completed' ELSE 'failed_closed' END,
    'runtimeRevision', p_runtime_revision,
    'policyVersion', p_policy_version,
    'stateVersion', v_state_version,
    'effectIds', to_jsonb(v_effect_ids),
    'effects', COALESCE(p_effects, '[]'::jsonb)
  ) || CASE WHEN p_failure_code IS NULL
       THEN '{}'::jsonb
       ELSE jsonb_build_object('failureCode', p_failure_code)
       END;

  UPDATE bot_support_turns
     SET status = CASE WHEN p_failure_code IS NULL THEN 'completed' ELSE 'failed_closed' END,
         state_version = v_state_version,
         effect_ids = v_effect_ids,
         receipt = v_receipt,
         completed_at = clock_timestamp()
   WHERE id = v_turn_id;

  RETURN jsonb_build_object('duplicate', FALSE, 'receipt', v_receipt);
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

  SELECT status INTO v_status
    FROM bot_outbound_effects
   WHERE bot_outbound_effects.effect_key = p_effect_key;
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
     AND (lease_owner = p_owner OR lease_until IS NULL OR lease_until <= clock_timestamp()
          OR status IN ('pending', 'failed'));

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, p_effect_key, 'claimed'::TEXT;
  ELSE
    RETURN QUERY SELECT FALSE, p_effect_key, 'busy'::TEXT;
  END IF;
END;
$$;
