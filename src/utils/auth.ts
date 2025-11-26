import { supabase } from './supabase';
import { StorageKey } from '../types/storage';

/**
 * Get Supabase user ID from storage
 */
export async function getSupabaseUserId(): Promise<string | null> {
  const data = await chrome.storage.sync.get([StorageKey.SUPABASE_USER_ID]);
  return data[StorageKey.SUPABASE_USER_ID] || null;
}

/**
 * Get Supabase user email from storage
 */
export async function getSupabaseUserEmail(): Promise<string | null> {
  const data = await chrome.storage.sync.get([StorageKey.SUPABASE_USER_EMAIL]);
  return data[StorageKey.SUPABASE_USER_EMAIL] || null;
}

/**
 * Get current Supabase session
 */
export async function getSupabaseSession() {
  const data = await chrome.storage.sync.get([
    StorageKey.SUPABASE_ACCESS_TOKEN,
    StorageKey.SUPABASE_REFRESH_TOKEN,
    StorageKey.SUPABASE_SESSION_EXPIRES_AT
  ]);
  
  return {
    accessToken: data[StorageKey.SUPABASE_ACCESS_TOKEN] as string | undefined,
    refreshToken: data[StorageKey.SUPABASE_REFRESH_TOKEN] as string | undefined,
    expiresAt: data[StorageKey.SUPABASE_SESSION_EXPIRES_AT] as number | undefined
  };
}

/**
 * Check if user is authenticated with Supabase
 * Also checks if session is expired and attempts refresh if needed
 */
export async function isSupabaseAuthenticated(): Promise<boolean> {
  const session = await getSupabaseSession();
  if (!session.accessToken) {
    return false;
  }
  
  // Check if session is expired
  if (session.expiresAt) {
    const expiresAt = new Date(session.expiresAt * 1000); // Supabase uses seconds
    const now = new Date();
    
    // Refresh if expired or expiring within 5 minutes
    if (expiresAt < now || expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
      const refreshed = await refreshSupabaseSession();
      return refreshed;
    }
  }
  
  return true;
}

/**
 * Refresh Supabase session using refresh token
 */
export async function refreshSupabaseSession(): Promise<boolean> {
  try {
    const session = await getSupabaseSession();
    if (!session.refreshToken) {
      console.warn('[Auth] No refresh token available');
      return false;
    }
    
    const { data, error } = await supabase.auth.refreshSession({
      refresh_token: session.refreshToken
    });
    
    if (error || !data.session) {
      console.error('[Auth] Session refresh failed:', error);
      return false;
    }
    
    // Update stored session
    await chrome.storage.sync.set({
      [StorageKey.SUPABASE_ACCESS_TOKEN]: data.session.access_token,
      [StorageKey.SUPABASE_REFRESH_TOKEN]: data.session.refresh_token,
      [StorageKey.SUPABASE_SESSION_EXPIRES_AT]: data.session.expires_at
    });
    
    console.log('[Auth] Session refreshed successfully');
    return true;
  } catch (error) {
    console.error('[Auth] Session refresh error:', error);
    return false;
  }
}

/**
 * Logout from Supabase and clear all stored auth data
 */
export async function logoutSupabase(): Promise<void> {
  try {
    await supabase.auth.signOut();
    
    // Clear Supabase storage
    await chrome.storage.sync.remove([
      StorageKey.SUPABASE_USER_ID,
      StorageKey.SUPABASE_USER_EMAIL,
      StorageKey.SUPABASE_ACCESS_TOKEN,
      StorageKey.SUPABASE_REFRESH_TOKEN,
      StorageKey.SUPABASE_SESSION_EXPIRES_AT
    ]);
    
    console.log('[Auth] Logged out successfully');
    
    // Broadcast logout event
    chrome.runtime.sendMessage({ action: 'AUTH_LOGOUT' }).catch(() => {
      // Ignore if no listeners
    });
  } catch (error) {
    console.error('[Auth] Logout error:', error);
    throw error;
  }
}

/**
 * Get Supabase access token for API calls
 * Returns null if not authenticated
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
  const isAuth = await isSupabaseAuthenticated();
  if (!isAuth) {
    return null;
  }
  
  const session = await getSupabaseSession();
  return session.accessToken || null;
}

