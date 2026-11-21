-- Operation grants. The token never touches disk; only its SHA-256 hex is kept for host checks.
CREATE TABLE IF NOT EXISTS computer_grants (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  approval_id TEXT,
  apps TEXT NOT NULL CHECK(json_valid(apps) AND json_type(apps)='array' AND json_array_length(apps) BETWEEN 1 AND 50),
  duration TEXT NOT NULL CHECK(duration IN ('task','today')),
  expires_at TEXT NOT NULL,
  foreground_ask INTEGER NOT NULL CHECK(foreground_ask IN (0,1)),
  allow_coordinates INTEGER NOT NULL CHECK(allow_coordinates IN (0,1)),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS computer_grants_run ON computer_grants(run_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS computer_grants_bot_page ON computer_grants(bot_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS computer_grants_approval ON computer_grants(approval_id) WHERE approval_id IS NOT NULL;

-- Per-Bot "always allow" app list. Coordinates are deliberately not representable here.
CREATE TABLE IF NOT EXISTS bot_computer_always (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
  apps TEXT NOT NULL CHECK(json_valid(apps) AND json_type(apps)='array' AND json_array_length(apps) BETWEEN 1 AND 50),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS computer_steps (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  app TEXT NOT NULL,
  app_name TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('ui','browser','coordinates','keys')),
  stage TEXT NOT NULL CHECK(stage IN ('background','foreground')),
  target TEXT NOT NULL CHECK(length(target)<=500),
  result TEXT NOT NULL CHECK(result IN ('done','error','denied','skipped')),
  -- Relative to the Bot directory; cleared when the retention sweep deletes the file.
  screenshot_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS computer_steps_run ON computer_steps(run_id,created_at,id);
CREATE INDEX IF NOT EXISTS computer_steps_bot_page ON computer_steps(bot_id,created_at,id);
CREATE INDEX IF NOT EXISTS computer_steps_page ON computer_steps(created_at,id);
CREATE INDEX IF NOT EXISTS computer_steps_screenshots ON computer_steps(created_at) WHERE screenshot_path IS NOT NULL;

-- App IDs compare case-insensitively (Windows executables, some bundle IDs).
-- Removed defaults are kept with removed_at so a user's choice survives later seed migrations.
CREATE TABLE IF NOT EXISTS app_blocklist (
  app_id TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('default','user')),
  removable INTEGER NOT NULL CHECK(removable IN (0,1)),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  CHECK(removable=1 OR removed_at IS NULL)
);
-- Never operable or capturable: Pi Bot itself, credential stores, privacy settings, terminals
-- (commands go through run_command). Windows Credential Manager is a Control Panel page and is
-- left to the driver's pane check.
INSERT INTO app_blocklist(app_id,name,source,removable,created_at) VALUES
  ('app.pibot.desktop','Pi Bot','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('pi bot.exe','Pi Bot','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('pi-bot','Pi Bot','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.keychainaccess','Keychain Access','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Passwords','Passwords','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.1password.1password','1Password','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.agilebits.onepassword7','1Password 7','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1password.exe','1Password','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('1password','1Password','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.bitwarden.desktop','Bitwarden','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bitwarden.exe','Bitwarden','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bitwarden','Bitwarden','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.keepassxc.keepassxc','KeePassXC','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('keepassxc.exe','KeePassXC','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.gnome.seahorse.Application','Passwords and Keys','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.kde.kwalletmanager5','KWalletManager','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.settings.PrivacySecurity.extension','Privacy & Security','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Terminal','Terminal','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.googlecode.iterm2','iTerm2','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dev.warp.Warp-Stable','Warp','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.mitchellh.ghostty','Ghostty','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('net.kovidgoyal.kitty','kitty','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.alacritty','Alacritty','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('windowsterminal.exe','Windows Terminal','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('cmd.exe','Command Prompt','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('powershell.exe','Windows PowerShell','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('pwsh.exe','PowerShell','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('conhost.exe','Console Window Host','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.gnome.Terminal','GNOME Terminal','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.gnome.Ptyxis','Ptyxis','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.gnome.Console','Console','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.kde.konsole','Konsole','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('xterm','XTerm','default',0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(app_id) DO NOTHING;
-- Blocked by default but removable by the user: chat apps and mail clients.
INSERT INTO app_blocklist(app_id,name,source,removable,created_at) VALUES
  ('com.tencent.xinWeChat','WeChat','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('weixin.exe','WeChat','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('wechat.exe','WeChat','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.tencent.qq','QQ','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('qq.exe','QQ','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ru.keepcoder.Telegram','Telegram','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.telegram.desktop','Telegram','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('telegram.exe','Telegram','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('net.whatsapp.WhatsApp','WhatsApp','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('whatsapp.exe','WhatsApp','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.tinyspeck.slackmacgap','Slack','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('slack.exe','Slack','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('slack','Slack','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.hnc.Discord','Discord','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('discord.exe','Discord','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('discord','Discord','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.alibaba.DingTalkMac','DingTalk','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dingtalk.exe','DingTalk','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.microsoft.teams2','Microsoft Teams','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('ms-teams.exe','Microsoft Teams','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.MobileSMS','Messages','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.mail','Mail','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.microsoft.Outlook','Microsoft Outlook','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('outlook.exe','Microsoft Outlook','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('olk.exe','Outlook','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('hxoutlook.exe','Mail','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.mozilla.thunderbird','Thunderbird','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('thunderbird.exe','Thunderbird','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.gnome.Evolution','Evolution','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.readdle.smartemail-Mac','Spark','default',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(app_id) DO NOTHING;

-- Skill metadata; SKILL.md bodies live in bots/<id>/<path>/ on disk.
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 1024),
  source TEXT NOT NULL CHECK(source IN ('taught','proposed','team','imported')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  path TEXT NOT NULL CHECK(path GLOB 'skills/?*' AND path NOT GLOB '*..*'),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS skills_bot_name ON skills(bot_id,name COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS skills_bot_path ON skills(bot_id,path);
CREATE INDEX IF NOT EXISTS skills_bot_page ON skills(bot_id,created_at,id);
CREATE INDEX IF NOT EXISTS skills_bot_enabled ON skills(bot_id,enabled,name);

CREATE TABLE IF NOT EXISTS skill_proposals (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  status TEXT NOT NULL CHECK(status IN ('open','accepted','declined','expired')),
  resolved_skill_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK((status='open')=(resolved_at IS NULL)),
  CHECK(status='accepted' OR resolved_skill_id IS NULL)
);
CREATE INDEX IF NOT EXISTS skill_proposals_page ON skill_proposals(bot_id,created_at,id);
CREATE INDEX IF NOT EXISTS skill_proposals_message ON skill_proposals(message_id);
CREATE INDEX IF NOT EXISTS skill_proposals_open ON skill_proposals(status,created_at,id);

-- "Teach it once" recordings (Bot browser only). Steps never contain secret field values.
CREATE TABLE IF NOT EXISTS recordings (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  steps TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(steps) AND json_type(steps)='array'),
  status TEXT NOT NULL CHECK(status IN ('recording','review','drafted','saved','discarded','failed')),
  CHECK((status='recording')=(ended_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS recordings_one_active ON recordings(bot_id) WHERE status='recording';
CREATE INDEX IF NOT EXISTS recordings_bot_page ON recordings(bot_id,started_at,id);

-- The computer category opens here with "ask" as the global default. Before this the
-- category was locked to "never" in every UI, so no saved "never" was a user choice.
UPDATE settings SET value=json_set(value,'$.levels.computer','ask')
  WHERE key='permissions' AND json_valid(value) AND json_extract(value,'$.levels.computer')='never';
INSERT INTO settings(key,value) VALUES ('computer.screenshotRetentionDays','7') ON CONFLICT(key) DO NOTHING;
