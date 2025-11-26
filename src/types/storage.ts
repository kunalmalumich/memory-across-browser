/** Enum for all storage keys used in the extension */
export enum StorageKey {
  SELECTED_ORG = 'selected_org',
  SELECTED_PROJECT = 'selected_project',
  MEMORY_ENABLED = 'memory_enabled',
  AUTO_INJECT_ENABLED = 'auto_inject_enabled',
  SIMILARITY_THRESHOLD = 'similarity_threshold',
  TOP_K = 'top_k',
  TRACK_SEARCHES = 'track_searches',
  // Supabase authentication keys
  SUPABASE_USER_ID = 'supabase_user_id',
  SUPABASE_USER_EMAIL = 'supabase_user_email',
  SUPABASE_ACCESS_TOKEN = 'supabase_access_token',
  SUPABASE_REFRESH_TOKEN = 'supabase_refresh_token',
  SUPABASE_SESSION_EXPIRES_AT = 'supabase_session_expires_at',
}

/** Type mapping for storage values (required fields) */
export type StorageItems = {
  memory_enabled: boolean;
  selected_org: string;
  selected_project: string;
  similarity_threshold: number;
  top_k: number;
  supabase_user_id: string;
  supabase_access_token: string;
};

/** Type mapping for storage values (optional fields) */
export type StorageData = Partial<{
  memory_enabled: boolean;
  selected_org: string;
  selected_project: string;
  similarity_threshold: number;
  top_k: number;
  // Supabase authentication fields
  supabase_user_id: string;
  supabase_user_email: string;
  supabase_access_token: string;
  supabase_refresh_token: string;
  supabase_session_expires_at: number;
}>;
