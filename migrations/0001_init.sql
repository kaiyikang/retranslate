CREATE TABLE saved (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, source, target_lang)
);
