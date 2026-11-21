-- Legacy rows remain readable while bounded refreshes replace each file independently. NULL
-- deliberately differs from every shipped extractor; the migration runner applies this once.
ALTER TABLE code_roots ADD COLUMN extractor_fingerprint TEXT
  CHECK(extractor_fingerprint IS NULL OR length(extractor_fingerprint)=64);
ALTER TABLE code_files ADD COLUMN extractor_fingerprint TEXT
  CHECK(extractor_fingerprint IS NULL OR length(extractor_fingerprint)=64);
