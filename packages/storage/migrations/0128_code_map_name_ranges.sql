-- A header's grammar also depends on directory metadata, even if its own bytes did not change.
-- Extractor-version invalidation owns rebuilding old symbols; this migration preserves the index.
ALTER TABLE code_files ADD COLUMN has_cpp_sibling INTEGER NOT NULL DEFAULT 0 CHECK(has_cpp_sibling IN (0,1));
