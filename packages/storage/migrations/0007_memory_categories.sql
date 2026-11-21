ALTER TABLE memories ADD COLUMN category TEXT CHECK (category IN ('about_you','work','how_to'));
ALTER TABLE memory_proposals ADD COLUMN category TEXT CHECK (category IN ('about_you','work','how_to'));
