ALTER TABLE bots ADD COLUMN category TEXT NOT NULL DEFAULT 'chat' CHECK (category IN ('chat', 'image'));
ALTER TABLE bots ADD COLUMN image_mode TEXT CHECK (image_mode IN ('text-to-image', 'image-to-image'));
