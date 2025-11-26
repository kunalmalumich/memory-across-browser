import { createClient } from '@supabase/supabase-js';

// Supabase configuration
// These must be set as environment variables at build time
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Create a dummy client if env vars are missing (for graceful degradation)
// This allows the extension to build and run, but Supabase features won't work
let supabase: ReturnType<typeof createClient>;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('[Supabase] Environment variables not configured. Supabase features will be disabled.');
  console.warn('[Supabase] Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env file');
  
  // Create a dummy client with placeholder values
  // This prevents errors when the client is imported, but calls will fail gracefully
  supabase = createClient('https://placeholder.supabase.co', 'placeholder-key');
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export { supabase };

