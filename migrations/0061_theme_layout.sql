-- Theme layouts: the public site's look (home page, header, footer) chosen in Settings → Theme, versioned
-- with the colours (draft → preview → publish → rollback). CLASSIC = the site as it was; nothing changes until
-- an admin publishes another layout.
ALTER TABLE theme_versions ADD COLUMN layout TEXT NOT NULL DEFAULT 'CLASSIC'
  CHECK (layout IN ('CLASSIC', 'EDITORIAL', 'BOUTIQUE', 'NIGHT'));

-- A published or archived version is history: its layout never changes either.
CREATE TRIGGER trg_theme_versions_layout_frozen BEFORE UPDATE OF layout ON theme_versions
WHEN OLD.status <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'THEME_VERSION_IMMUTABLE');
END;
