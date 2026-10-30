-- Migração aditiva: preserva contas, publicações e histórico.
ALTER TABLE users ADD COLUMN avatar_media_id TEXT;
ALTER TABLE entries ADD COLUMN video_media_id TEXT;
ALTER TABLE entries ADD COLUMN video_note TEXT NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS media_assets (
 id TEXT PRIMARY KEY,
 owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('avatar','cover','video')),
 r2_key TEXT NOT NULL UNIQUE,
 mime TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media_assets(owner_id,kind);
