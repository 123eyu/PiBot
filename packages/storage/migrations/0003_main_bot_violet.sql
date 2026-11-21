-- Preserve user-selected colors and the palette of every non-main Bot.
UPDATE bots SET avatar_color = 'violet' WHERE is_main = 1 AND avatar_color = 'orange';
