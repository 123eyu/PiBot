-- A step's action as data (JSON `ComputerStepAction`) so the UI words it in the current
-- language, and the page a Bot browser step left the Bot on. Older rows keep NULL and show their
-- pre-phrased `target`.
ALTER TABLE computer_steps ADD COLUMN action TEXT;
ALTER TABLE computer_steps ADD COLUMN page_url TEXT;
ALTER TABLE computer_steps ADD COLUMN page_title TEXT;
