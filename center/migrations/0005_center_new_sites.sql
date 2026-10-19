-- "เพิ่มเว็บใหม่" in Center: a new site from its domain to its pull request.
-- ZONE_PENDING: domain added to Cloudflare, waiting for the owner to switch nameservers.
-- ZONE_ACTIVE:  nameservers switched (zone Active) — ready to create the site.
-- CREATING:     Actions → Create site was started (D1, R2, registry PR); merge + Release follow on the Release page.
-- Rows stay until the site is in the registry (then they are shown as done) or someone removes them.
CREATE TABLE center_new_sites (
  slug          TEXT PRIMARY KEY CHECK (slug GLOB '[a-z]*' AND length(slug) BETWEEN 2 AND 31),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  domain        TEXT NOT NULL UNIQUE CHECK (length(domain) BETWEEN 4 AND 253),
  zone_id       TEXT CHECK (zone_id IS NULL OR length(zone_id) = 32),
  status        TEXT NOT NULL CHECK (status IN ('ZONE_PENDING', 'ZONE_ACTIVE', 'CREATING')),
  name_servers  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(name_servers)),
  removed_records TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(removed_records)),
  created_by    TEXT REFERENCES center_users (id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  checked_at    TEXT
) STRICT;
