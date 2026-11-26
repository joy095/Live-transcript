CREATE TABLE IF NOT EXISTS recordings (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
 audio_key TEXT NOT NULL, transcript_key TEXT NOT NULL, mime_type TEXT NOT NULL,
 duration_ms INTEGER NOT NULL DEFAULT 0, transcript TEXT NOT NULL DEFAULT '',
 createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS recordings_user_created ON recordings(user_id, createdAt DESC);

CREATE TABLE IF NOT EXISTS user (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
 emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
 createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
 isAnonymous INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session (
 id TEXT PRIMARY KEY, expiresAt TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
 createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
 ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_userId_idx ON session(userId);
CREATE TABLE IF NOT EXISTS account (
 id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL,
 userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt TEXT,
 refreshTokenExpiresAt TEXT, scope TEXT, password TEXT,
 createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS account_userId_idx ON account(userId);
CREATE TABLE IF NOT EXISTS verification (
 id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
 expiresAt TEXT NOT NULL, createdAt TEXT DEFAULT (datetime('now')), updatedAt TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification(identifier);
