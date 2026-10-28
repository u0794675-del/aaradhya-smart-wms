-- Phase 1 provenance: keep the Barcode Value and the Rack / Bin values supplied by
-- the Box Register. These are source facts, not confirmed warehouse locations; the
-- operational location stays governed by the normal location workflow.

ALTER TABLE box_sources ADD COLUMN source_barcode TEXT;
ALTER TABLE box_sources ADD COLUMN source_rack TEXT;
ALTER TABLE box_sources ADD COLUMN source_bin TEXT;

CREATE INDEX IF NOT EXISTS ix_box_sources_source_barcode ON box_sources(source_barcode);
