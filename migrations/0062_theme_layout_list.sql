-- Theme layout D · Stay List (a hotel-search home page). theme_versions.layout keeps its CHECK (migration 0061);
-- layouts added later live in layout_ext, which wins when set (the stored layout is then CLASSIC). Additive only.
ALTER TABLE theme_versions ADD COLUMN layout_ext TEXT CHECK (layout_ext IS NULL OR layout_ext IN ('LIST'));

-- A published or archived version is history: its layout never changes either.
CREATE TRIGGER trg_theme_versions_layout_ext_frozen BEFORE UPDATE OF layout_ext ON theme_versions
WHEN OLD.status <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'THEME_VERSION_IMMUTABLE');
END;
