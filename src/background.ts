import { initContextMenuMemory } from './context-menu-memory';
import { initDirectUrlTracking } from './direct-url-tracker';
import { type OpenDashboardMessage, SidebarAction } from './types/messages';
import { supabase } from './utils/supabase';
import { StorageKey } from './types/storage';

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ memory_enabled: true }, () => {
    console.log('Memory enabled set to true on install/update');
  });
});

chrome.runtime.onMessage.addListener((request: OpenDashboardMessage) => {
  if (request.action === SidebarAction.OPEN_DASHBOARD && request.url) {
    chrome.tabs.create({ url: request.url });
  }
  return undefined;
});

chrome.runtime.onMessage.addListener(
  (request: { action?: string }, sender: chrome.runtime.MessageSender) => {
    if (request.action === SidebarAction.SIDEBAR_SETTINGS) {
      const tabId = sender.tab?.id;
      if (tabId !== null && tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, { action: SidebarAction.SIDEBAR_SETTINGS });
      }
    }
    return undefined;
  }
);

// Handle Magic Link callback
chrome.runtime.onMessage.addListener(
  (
    request: {
      action?: string;
      session?: {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        token_type?: string;
      };
      user?: { id: string | null; email: string | null };
      tokenHash?: string;
      type?: string;
    },
    sender,
    sendResponse: (response: { success: boolean; error?: string }) => void
  ) => {
    if (request.action === 'SUPABASE_MAGIC_LINK_CALLBACK') {
      // Handle both session data (from hash fragment) and token_hash (from query string)
      if (request.session && request.user) {
        handleDirectSession(request.session, request.user)
          .then(result => sendResponse(result))
          .catch(error =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
          );
      } else if (request.tokenHash) {
        handleMagicLinkCallback(request.tokenHash, request.type || 'email')
          .then(result => sendResponse(result))
          .catch(error =>
            sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
          );
      } else {
        sendResponse({ success: false, error: 'Missing session or token_hash' });
      }
      return true; // Keep channel open for async response
    }
    return undefined;
  }
);

/**
 * Store session and broadcast auth success (shared logic)
 */
async function storeSessionAndNotify(
  accessToken: string,
  refreshToken: string,
  expiresAt: number,
  userId: string,
  userEmail: string
) {
  // Store session and user data
  await chrome.storage.sync.set({
    [StorageKey.SUPABASE_ACCESS_TOKEN]: accessToken,
    [StorageKey.SUPABASE_REFRESH_TOKEN]: refreshToken,
    [StorageKey.SUPABASE_USER_ID]: userId,
    [StorageKey.SUPABASE_USER_EMAIL]: userEmail,
    [StorageKey.SUPABASE_SESSION_EXPIRES_AT]: expiresAt,
  });

  console.log('[Background] Authentication successful', { userId, email: userEmail });

  // IMPORTANT: Set session in Supabase client BEFORE updating user_sessions table
  // This is required for RLS policies to work (auth.uid() needs to be set)
  try {
    const { error: sessionError } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    
    if (sessionError) {
      console.warn('[Background] Could not set Supabase session:', sessionError);
    } else {
      console.log('[Background] Supabase session set successfully');
    }
  } catch (sessionErr) {
    console.warn('[Background] Error setting Supabase session:', sessionErr);
  }

  // Update user_sessions table in Supabase (optional - will fail silently if table doesn't exist)
  // Note: This requires the session to be set above for RLS policies to work
  await updateUserSession(userId, userEmail).catch(err => {
    console.warn('[Background] Could not update user_sessions table:', err);
  });

  // Broadcast auth success to all contexts
  chrome.runtime.sendMessage({ action: 'AUTH_SUCCESS' }).catch(() => {
    // Ignore if no listeners
  });
}

async function handleDirectSession(
  session: { access_token: string; refresh_token: string; expires_at: number; token_type?: string },
  user: { id: string | null; email: string | null }
) {
  try {
    console.log('[Background] Handling direct session callback', { userId: user.id, email: user.email });

    // Most efficient: Use JWT payload if available (parsed in callback, no API call needed)
    // Only fall back to API call if JWT parsing failed
    if (!user.id || !user.email) {
      // Set the session in Supabase client first
      const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      });

      if (sessionError) {
        console.error('[Background] Could not set session:', sessionError);
        return { success: false, error: 'Could not set session' };
      }

      // Now get user info (getUser() uses the current session)
      const { data: { user: supabaseUser }, error: userError } = await supabase.auth.getUser();

      if (userError || !supabaseUser) {
        console.error('[Background] Could not get user info:', userError);
        return { success: false, error: 'Could not retrieve user information' };
      }

      user.id = supabaseUser.id;
      user.email = supabaseUser.email || null;
    }

    // Validate we have required user info
    if (!user.id || !user.email) {
      return { success: false, error: 'Missing user ID or email' };
    }

    // Store session and notify (shared logic)
    await storeSessionAndNotify(session.access_token, session.refresh_token, session.expires_at, user.id, user.email);

    return { success: true };
  } catch (error) {
    console.error('[Background] Direct session callback error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function handleMagicLinkCallback(tokenHash: string, type: string) {
  try {
    console.log('[Background] Handling Magic Link callback', { tokenHash: tokenHash?.substring(0, 20) + '...', type });

    // Verify Magic Link token
    // For Magic Links, type is always 'email'
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'email',
    });

    if (error) {
      console.error('[Background] Supabase auth error:', error);
      return { success: false, error: error.message };
    }

    if (data.session && data.user && data.user.email && data.session.expires_at) {
      // Store session and notify (shared logic)
      await storeSessionAndNotify(
        data.session.access_token,
        data.session.refresh_token,
        data.session.expires_at,
        data.user.id,
        data.user.email
      );

      return { success: true };
    } else {
      return { success: false, error: 'No session, user email, or expires_at received' };
    }
  } catch (error) {
    console.error('[Background] Auth callback error:', error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function updateUserSession(userId: string, email: string) {
  try {
    // Type assertion needed because Supabase doesn't know about our custom table type
    const { error } = await (supabase as any)
      .from('user_sessions')
      .upsert(
        {
          user_id: userId,
          email: email,
          last_login_at: new Date().toISOString(),
          extension_version: chrome.runtime.getManifest().version,
          browser_type: navigator.userAgent.includes('Chrome') ? 'Chrome' : 'Unknown',
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: 'user_id',
        }
      );

    if (error) {
      console.error('[Background] Error updating user session:', error);
      throw error;
    }
  } catch (error) {
    // Table might not exist yet, that's okay
    console.warn('[Background] Could not update user_sessions:', error);
    throw error;
  }
}

initContextMenuMemory();
initDirectUrlTracking();
