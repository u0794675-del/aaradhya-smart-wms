-- Provenance and verification for the workbook migration. These tables keep the
-- original source values alongside the operational master data so that nothing
-- is overwritten or silently "corrected" during import.

CREATE TABLE IF NOT EXISTS product_sources (
  product_id TEXT PRIMARY KEY REFERENCES products(id),
  source_sku TEXT,
  source_name TEXT,
  source_product_key TEXT,
  source_brand TEXT,
  source_category TEXT,
  source_pool TEXT,
  source_active TEXT,
  source_barcode TEXT,
  source_created_from TEXT,
  source_verification TEXT,
  source_notes TEXT,
  verification_status TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION'
    CHECK (verification_status IN ('NEEDS_VERIFICATION','VERIFIED','BLOCKED','EXCEPTION')),
  verification_notes TEXT,
  source_file TEXT,
  source_sheet TEXT,
  source_row_no INTEGER,
  import_job_id TEXT REFERENCES import_jobs(id),
  verified_by TEXT REFERENCES users(id),
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_product_sources_verification ON product_sources(verification_status);

CREATE TABLE IF NOT EXISTS box_sources (
  box_id TEXT PRIMARY KEY REFERENCES boxes(id),
  source_box_id TEXT NOT NULL,
  source_brand TEXT,
  source_zone TEXT,
  source_location_key TEXT,
  source_box_quantity INTEGER,
  source_status TEXT,
  source_box_type TEXT,
  source_reference TEXT,
  transcription_confidence TEXT,
  source_verification TEXT,
  source_notes TEXT,
  verification_status TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION'
    CHECK (verification_status IN ('NEEDS_VERIFICATION','VERIFIED','BLOCKED','EXCEPTION')),
  verification_notes TEXT,
  source_sheet TEXT,
  source_row_no INTEGER,
  import_job_id TEXT REFERENCES import_jobs(id),
  verified_by TEXT REFERENCES users(id),
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_box_sources_verification ON box_sources(verification_status);
CREATE INDEX IF NOT EXISTS ix_box_sources_source_box ON box_sources(source_box_id);

CREATE TABLE IF NOT EXISTS box_content_declarations (
  id TEXT PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES boxes(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  declared_quantity INTEGER CHECK (declared_quantity IS NULL OR declared_quantity >= 0),
  unit_label TEXT,
  source_box_type TEXT,
  source_page TEXT,
  transcription_confidence TEXT,
  verification_notes TEXT,
  verification_status TEXT NOT NULL DEFAULT 'NEEDS_VERIFICATION'
    CHECK (verification_status IN ('NEEDS_VERIFICATION','VERIFIED','BLOCKED','EXCEPTION')),
  conflict_flag INTEGER NOT NULL DEFAULT 0 CHECK (conflict_flag IN (0, 1)),
  conflict_detail TEXT,
  source_row_no INTEGER,
  import_job_id TEXT REFERENCES import_jobs(id),
  created_at TEXT NOT NULL,
  UNIQUE (box_id, product_id)
);
CREATE INDEX IF NOT EXISTS ix_declarations_status ON box_content_declarations(verification_status);
CREATE INDEX IF NOT EXISTS ix_declarations_box ON box_content_declarations(box_id);

CREATE TABLE IF NOT EXISTS box_id_mappings (
  source_box_id TEXT PRIMARY KEY,
  box_code TEXT NOT NULL,
  note TEXT,
  import_job_id TEXT REFERENCES import_jobs(id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_import_jobs_workbook_hash
  ON import_jobs(source_hash) WHERE import_type = 'WORKBOOK' AND status = 'IMPORTED';

-- Every non-empty source row is retained verbatim in addition to the normalised
-- operational records. Duplicate or contradictory source rows stay auditable
-- instead of being silently discarded during import.
CREATE TABLE IF NOT EXISTS workbook_source_rows (
  id TEXT PRIMARY KEY,
  import_job_id TEXT NOT NULL REFERENCES import_jobs(id),
  sheet_name TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  row_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_workbook_rows_job ON workbook_source_rows(import_job_id, sheet_name);

ALTER TABLE import_jobs ADD COLUMN summary_json TEXT;
