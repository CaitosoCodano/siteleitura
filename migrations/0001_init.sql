-- Estrutura persistente do Entrelinhas Cloudflare D1.

CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT,
 google_sub TEXT UNIQUE, name TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
 avatar TEXT NOT NULL DEFAULT '📖', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS books (
 id INTEGER PRIMARY KEY AUTOINCREMENT, source_key TEXT UNIQUE, title TEXT NOT NULL,
 author TEXT NOT NULL DEFAULT '', cover_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS shelves (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('lido','lendo','quero_ler')),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,book_id));
CREATE TABLE IF NOT EXISTS entries (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('post','review')), book_id INTEGER REFERENCES books(id) ON DELETE SET NULL,
 rating INTEGER CHECK(rating BETWEEN 1 AND 5), content TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS likes (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE, PRIMARY KEY(user_id,entry_id));
CREATE TABLE IF NOT EXISTS comments (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS follows (
 follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(follower_id,following_id), CHECK(follower_id != following_id));
CREATE TABLE IF NOT EXISTS direct_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 1500),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 read_at TEXT,
 CHECK(sender_id != recipient_id));
CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(sender_id,recipient_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_dm_unread ON direct_messages(recipient_id,read_at,sender_id);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_user ON entries(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments(entry_id);
CREATE INDEX IF NOT EXISTS idx_shelves_status ON shelves(user_id,status);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS rate_limits (
 bucket INTEGER NOT NULL, key TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(bucket,key));
CREATE INDEX IF NOT EXISTS idx_rate_limits_bucket ON rate_limits(bucket);

