-- Runtime emergency switch for the ProGolf agent bot.
-- Changes take effect on the next eligible execution without restarting n8n.

CREATE TABLE IF NOT EXISTS bot_runtime_settings (
  setting_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  reason TEXT,
  changed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO bot_runtime_settings (setting_key, enabled, reason, changed_by)
VALUES ('agent_bot_enabled', TRUE, 'initial migration default', 'migration')
ON CONFLICT (setting_key) DO NOTHING;

CREATE OR REPLACE FUNCTION bot_set_agent_enabled(
  p_enabled BOOLEAN,
  p_reason TEXT DEFAULT NULL,
  p_changed_by TEXT DEFAULT NULL
)
RETURNS TABLE (enabled BOOLEAN, reason TEXT, changed_by TEXT, updated_at TIMESTAMPTZ)
LANGUAGE sql
AS $$
  INSERT INTO bot_runtime_settings (setting_key, enabled, reason, changed_by, updated_at)
  VALUES ('agent_bot_enabled', p_enabled, p_reason, p_changed_by, clock_timestamp())
  ON CONFLICT (setting_key) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      reason = EXCLUDED.reason,
      changed_by = EXCLUDED.changed_by,
      updated_at = EXCLUDED.updated_at
  RETURNING bot_runtime_settings.enabled, bot_runtime_settings.reason,
            bot_runtime_settings.changed_by, bot_runtime_settings.updated_at;
$$;

