-- YOLO: a switch on one conversation (DM topic or group conversation). NULL is off; a new
-- conversation row starts NULL, so YOLO is never inherited from the previous topic.
ALTER TABLE conversations ADD COLUMN yolo_at TEXT;
-- A tool step allowed by YOLO instead of a card: its risk ('normal' / 'danger'), NULL otherwise.
ALTER TABLE tool_calls ADD COLUMN yolo_risk TEXT;
