-- The executable code map is a derived index, never a copy of the project. Only symbol
-- ranges and file hashes are kept; file text stays out of the database on purpose, so deleting a
-- root loses nothing that a re-index cannot rebuild.
CREATE TABLE code_roots (
  -- sha256 of device, inode and canonical path: a moved or replaced folder gets a new key.
  root_key TEXT PRIMARY KEY CHECK(length(root_key)=64),
  root_path TEXT NOT NULL CHECK(length(root_path)>0 AND length(root_path)<=4096 AND instr(root_path,char(0))=0),
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
-- Unbinding a working folder must drop its rows even after the folder itself is gone, so cleanup
-- looks the root up by the path it was indexed under.
CREATE INDEX code_roots_path ON code_roots(root_path);
CREATE TABLE code_files (
  root_key TEXT NOT NULL REFERENCES code_roots(root_key) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK(length(path)>0 AND length(path)<=4096 AND instr(path,char(0))=0),
  language TEXT,
  size INTEGER NOT NULL CHECK(size>=0),
  -- SQLite has no 64-bit integer for nanosecond mtimes; the decimal string keeps full precision.
  mtime_ns TEXT NOT NULL,
  hash TEXT NOT NULL CHECK(length(hash)=64),
  indexed_at TEXT NOT NULL,
  PRIMARY KEY(root_key, path)
);
CREATE TABLE code_symbols (
  root_key TEXT NOT NULL,
  path TEXT NOT NULL,
  -- The file version these rows describe; a stale row is never mixed with a newer file hash.
  hash TEXT NOT NULL CHECK(length(hash)=64),
  language TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name)>0 AND length(name)<=200),
  kind TEXT NOT NULL CHECK(length(kind)>0 AND length(kind)<=40),
  definition INTEGER NOT NULL CHECK(definition IN (0,1)),
  start_line INTEGER NOT NULL CHECK(start_line>0),
  start_column INTEGER NOT NULL CHECK(start_column>0),
  end_line INTEGER NOT NULL CHECK(end_line>0),
  end_column INTEGER NOT NULL CHECK(end_column>0),
  FOREIGN KEY(root_key, path) REFERENCES code_files(root_key, path) ON DELETE CASCADE
);
-- Looks symbols up by name; outlines and per-file replacement go by path.
CREATE INDEX code_symbols_name ON code_symbols(root_key, name);
CREATE INDEX code_symbols_path ON code_symbols(root_key, path);
