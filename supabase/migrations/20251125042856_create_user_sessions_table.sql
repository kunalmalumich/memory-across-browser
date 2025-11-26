-- Create user_sessions table for tracking extension user sessions
CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  last_login_at TIMESTAMPTZ DEFAULT NOW(),
  extension_version TEXT,
  browser_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_last_login ON user_sessions(last_login_at);

-- Enable Row Level Security
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;

-- Create function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_user_sessions_updated_at ON user_sessions;
CREATE TRIGGER update_user_sessions_updated_at
  BEFORE UPDATE ON user_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- RLS Policies: Users can only access their own session data
DROP POLICY IF EXISTS "Users can view own sessions" ON user_sessions;
CREATE POLICY "Users can view own sessions"
  ON user_sessions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own sessions" ON user_sessions;
CREATE POLICY "Users can update own sessions"
  ON user_sessions FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own sessions" ON user_sessions;
CREATE POLICY "Users can insert own sessions"
  ON user_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

