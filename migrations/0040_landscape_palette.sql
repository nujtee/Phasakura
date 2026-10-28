-- Migration 0040: Landscape palette — the kinds of things staff draw (grass, tree, house…) can be added, renamed,
-- restyled, hidden and deleted. Non-destructive: one new table; plans and bookings are not touched.
--
-- landscape_palette holds only what differs from the built-in palette:
--   builtin = 1: an override of a built-in kind (id = its code, e.g. 'TREE'): another name / look / shape / layer /
--               size / group / place, or hidden. Deleting the row puts the built-in back as it was.
--   builtin = 0: a kind staff made (id 'k…'), drawn as one of the built-in kinds (`kind`): that decides whether it
--               can be linked to a booking (HOUSE / VIP_TENT / CAMPING_AREA) and how a point symbol looks.
-- Objects keep their own kind and style in the plan; a deleted kind never changes a drawn object (status DELETED).

CREATE TABLE landscape_palette (
  id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  builtin     INTEGER NOT NULL CHECK (builtin IN (0, 1)),
  kind        TEXT NOT NULL CHECK (kind IN ('GRASS', 'TREE', 'SHRUB', 'FLOWER', 'WATER', 'PATH', 'HOUSE', 'VIP_TENT',
                'CAMPING_AREA', 'PARKING', 'FACILITY', 'BUILDING', 'LABEL', 'OTHER')),
  name        TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 40),
  draw        TEXT CHECK (draw IS NULL OR draw IN ('rect', 'circle', 'polygon', 'path', 'symbol')),
  fill        TEXT CHECK (fill IS NULL OR (length(fill) = 7 AND substr(fill, 1, 1) = '#' AND substr(fill, 2) NOT GLOB '*[^0-9A-Fa-f]*')),
  stroke      TEXT CHECK (stroke IS NULL OR (length(stroke) = 7 AND substr(stroke, 1, 1) = '#' AND substr(stroke, 2) NOT GLOB '*[^0-9A-Fa-f]*')),
  opacity     REAL CHECK (opacity IS NULL OR (opacity >= 0 AND opacity <= 1)),
  layer       TEXT CHECK (layer IS NULL OR layer IN ('ground', 'plants', 'stays', 'labels')),
  size        REAL CHECK (size IS NULL OR (size >= 0.002 AND size <= 0.5)),
  palette_group TEXT CHECK (palette_group IS NULL OR palette_group IN ('nature', 'stays', 'site')),
  sort_order  INTEGER,
  hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
  updated_by  TEXT REFERENCES users (id),
  updated_at  TEXT NOT NULL,
  -- A built-in keeps its own kind; a staff kind has a name and a full look.
  CHECK (builtin = 0 OR id = kind),
  CHECK (builtin = 1 OR (name IS NOT NULL AND draw IS NOT NULL AND opacity IS NOT NULL AND layer IS NOT NULL
         AND size IS NOT NULL AND palette_group IS NOT NULL))
) STRICT;
