-- Migration 0053: AI marketing report (AI Marketing, Module A — PR A2).
-- Non-destructive: three new tables, nothing existing changes.
--   ai_marketing_settings  one row: the automatic report on / off (off by default), and the AI writer's settings
--                          (used from PR A3: AI off by default, monthly budget, notifications).
--   marketing_reports      one report per period (weekly / monthly): the numbers computed from D1 + GA4, the findings
--                          of the fixed rules and (A3) the AI's summary. Numbers only — no guest names, phones, e-mails
--                          or booking codes.
--   ai_usage               every call to the AI provider with its tokens and cost (A3), for the monthly budget.

CREATE TABLE ai_marketing_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  is_enabled            INTEGER NOT NULL DEFAULT 0 CHECK (is_enabled IN (0, 1)),
  ai_enabled            INTEGER NOT NULL DEFAULT 0 CHECK (ai_enabled IN (0, 1)),
  provider              TEXT NOT NULL DEFAULT 'ANTHROPIC' CHECK (provider IN ('ANTHROPIC')),
  model                 TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 80),
  monthly_budget_satang INTEGER NOT NULL DEFAULT 30000 CHECK (monthly_budget_satang BETWEEN 0 AND 10000000),
  notify_email          INTEGER NOT NULL DEFAULT 0 CHECK (notify_email IN (0, 1)),
  notify_line           INTEGER NOT NULL DEFAULT 0 CHECK (notify_line IN (0, 1)),
  updated_by            TEXT REFERENCES users (id),
  updated_at            TEXT
) STRICT;

CREATE TABLE marketing_reports (
  id            TEXT PRIMARY KEY,
  period_kind   TEXT NOT NULL CHECK (period_kind IN ('WEEKLY', 'MONTHLY')),
  period_start  TEXT NOT NULL CHECK (period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end    TEXT NOT NULL CHECK (period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND period_end >= period_start),
  status        TEXT NOT NULL CHECK (status IN ('READY', 'READY_NO_AI', 'FAILED')),
  metrics_json  TEXT NOT NULL CHECK (length(metrics_json) BETWEEN 2 AND 100000),
  insights_json TEXT NOT NULL CHECK (length(insights_json) BETWEEN 2 AND 20000),
  ai_summary    TEXT CHECK (ai_summary IS NULL OR length(ai_summary) <= 20000),
  ai_model      TEXT CHECK (ai_model IS NULL OR length(ai_model) <= 80),
  ai_error      TEXT CHECK (ai_error IS NULL OR length(ai_error) <= 300),
  trigger       TEXT NOT NULL CHECK (trigger IN ('CRON', 'USER')),
  created_by    TEXT REFERENCES users (id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (period_kind, period_start)
) STRICT;

CREATE INDEX ix_marketing_reports_created ON marketing_reports (created_at);

CREATE TABLE ai_usage (
  id             TEXT PRIMARY KEY,
  report_id      TEXT REFERENCES marketing_reports (id),
  provider       TEXT NOT NULL CHECK (provider IN ('ANTHROPIC')),
  model          TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
  input_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_satang    INTEGER NOT NULL DEFAULT 0 CHECK (cost_satang >= 0),
  status         TEXT NOT NULL CHECK (status IN ('OK', 'FAILED', 'SKIPPED_BUDGET')),
  error          TEXT CHECK (error IS NULL OR length(error) <= 300),
  created_at     TEXT NOT NULL
) STRICT;

CREATE INDEX ix_ai_usage_created ON ai_usage (created_at);
