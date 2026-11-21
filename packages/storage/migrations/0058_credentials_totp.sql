ALTER TABLE site_credentials ADD COLUMN has_totp INTEGER NOT NULL DEFAULT 0 CHECK (has_totp IN (0, 1));
