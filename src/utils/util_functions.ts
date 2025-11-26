import { StorageKey, type StorageData } from '../types/storage';
import { isSupabaseAuthenticated, getSupabaseAccessToken } from './auth';

/**
 * Check if user has valid Supabase authentication
 */
export async function hasValidAuth(): Promise<boolean> {
  return await isSupabaseAuthenticated();
}

/**
 * Get Supabase access token for API calls
 */
export async function getAccessToken(): Promise<string | null> {
  return await getSupabaseAccessToken();
}

/**
 * Get organization ID from environment variable
 */
export function getOrgId(): string | undefined {
  return import.meta.env.VITE_MEM0_ORG_ID;
}

/**
 * Get project ID from environment variable
 */
export function getProjectId(): string | undefined {
  return import.meta.env.VITE_MEM0_PROJECT_ID;
}

/**
 * Get mem0.ai API key from environment variable
 */
export function getApiKey(): string | undefined {
  return import.meta.env.VITE_MEM0_API_KEY;
}

type EventType = string;
type AdditionalData = Record<string, unknown>;
type CallbackFunction = (success: boolean) => void;

type ExtensionEventPayload = {
  event_type: EventType;
  additional_data: {
    timestamp: string;
    version: string;
    user_agent: string;
    user_id: string;
    [key: string]: unknown;
  };
};

type BrowserType = 'Edge' | 'Opera' | 'Chrome' | 'Firefox' | 'Safari' | 'Unknown';

/**
 * Utility function to send extension events to PostHog via mem0 API
 * @param eventType - The type of event (e.g., "extension_install", "extension_toggle_button")
 * @param additionalData - Optional additional data to include with the event
 * @param callback - Optional callback function called after attempt (receives success boolean)
 * 
 * NOTE: Analytics temporarily disabled - will be replaced with custom analytics later
 */
export const sendExtensionEvent = (
  eventType: EventType,
  additionalData: AdditionalData = {},
  callback: CallbackFunction | null = null
): void => {
  // Analytics temporarily disabled - will be replaced with custom analytics later
  if (callback) {
    callback(false);
  }
  return;

  /* COMMENTED OUT - Analytics to Mem0 temporarily disabled
  chrome.storage.sync.get(
    [StorageKey.ACCESS_TOKEN, StorageKey.USER_ID_CAMEL, StorageKey.USER_ID],
    (data: StorageData) => {
      const apiKey = getApiKey();
      if (!apiKey && !data[StorageKey.ACCESS_TOKEN]) {
        if (callback) {
          callback(false);
        }
        return;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (data[StorageKey.ACCESS_TOKEN]) {
        headers['Authorization'] = `Bearer ${data[StorageKey.ACCESS_TOKEN]}`;
      } else if (apiKey) {
        headers['Authorization'] = `Token ${apiKey}`;
      }

      const payload: ExtensionEventPayload = {
        event_type: eventType,
        additional_data: {
          timestamp: new Date().toISOString(),
          version: chrome.runtime.getManifest().version,
          user_agent: navigator.userAgent,
          user_id:
            data[StorageKey.USER_ID_CAMEL] || data[StorageKey.USER_ID] || 'chrome-extension-user',
          ...additionalData,
        },
      };

      console.log('eventType', eventType);
      console.log('payload', payload);

      fetch('https://api.mem0.ai/v1/extension/', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
      })
        .then(response => {
          const success = response.ok;
          if (callback) {
            callback(success);
          }
        })
        .catch(error => {
          console.error(`Error sending ${eventType} event:`, error);
          if (callback) {
            callback(false);
          }
        });
    }
  );
  */
};

export const getBrowser = (): BrowserType => {
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Edg/')) {
    return 'Edge';
  }
  if (userAgent.includes('OPR/') || userAgent.includes('Opera/')) {
    return 'Opera';
  }
  if (userAgent.includes('Chrome/')) {
    return 'Chrome';
  }
  if (userAgent.includes('Firefox/')) {
    return 'Firefox';
  }
  if (userAgent.includes('Safari/') && !userAgent.includes('Chrome/')) {
    return 'Safari';
  }
  return 'Unknown';
};

/**
 * Check if text should trigger memory search
 * Triggers on sentence completion punctuation (. ! ?) or substantial content
 * @param text - The query text to check
 * @returns true if search should be triggered
 */
export const shouldTriggerMemorySearch = (text: string): boolean => {
  const normalized = text.trim();
  
  // Minimum requirements
  if (normalized.length < 5 || !/[a-zA-Z]/.test(normalized)) {
    return false;
  }
  
  const words = normalized.split(/\s+/).filter(w => w.length > 0);
  if (words.length < 2) {
    return false;
  }
  
  // Primary trigger: Sentence-ending punctuation (. ! ?)
  const endsWithPunctuation = /[.!?]$/.test(normalized);
  
  if (endsWithPunctuation) {
    // Filter false positives
    // URLs: http://example.com (no space before period)
    if (/https?:\/\/|www\./.test(normalized)) {
      const beforePeriod = normalized.slice(0, -1);
      if (!beforePeriod.endsWith(' ')) {
        return false; // Likely URL, not sentence end
      }
    }
    
    // Decimals: 3.14
    if (/\d+\.\d+$/.test(normalized)) {
      return false;
    }
    
    return true; // Sentence complete!
  }
  
  // Fallback: Substantial content (3+ words) even without punctuation
  // This catches chat-style messages like "explain react hooks"
  if (words.length >= 3) {
    return true;
  }
  
  return false;
};

/**
 * Show a notification when memories are searched
 * @param count - Number of memories found (0 = not found)
 * @param query - The search query (optional, for debugging)
 * @param onOpenModal - Callback function to open the memory modal
 */
export const showMemoryNotification = (
  count: number,
  query?: string,
  onOpenModal?: () => void
): void => {
  // Remove existing notification if present
  const existing = document.querySelector('.rememberme-auto-notification');
  if (existing) {
    existing.remove();
  }
  
  // Determine if memories were found
  const hasMemories = count > 0;
  const iconPath = hasMemories 
    ? 'icons/RememberMe_Search_Information_Icon.png'
    : 'icons/RememberMe_Data_Shield_M_Icon.png';
  const bgColor = hasMemories ? '#7a5bf7' : '#6b7280'; // Purple if found, gray if not
  
  // Create notification element
  const notification = document.createElement('div');
  notification.className = 'rememberme-auto-notification';
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: ${bgColor};
    color: white;
    padding: 12px 16px;
    border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    z-index: 2147483646;
    font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    cursor: pointer;
    animation: slideIn 0.3s ease;
    transition: background-color 0.2s ease;
    display: flex;
    align-items: center;
    gap: 10px;
  `;
  
  // Set notification text based on whether memories were found
  const mainText = hasMemories
    ? `${count} relevant memory${count > 1 ? 'ies' : ''} found`
    : 'No memories found';
  const subText = hasMemories ? 'Click to view' : 'Click to search manually';
  
  // Create icon element
  const icon = document.createElement('img');
  icon.src = chrome.runtime.getURL(iconPath);
  icon.style.cssText = `
    width: 24px;
    height: 24px;
    flex-shrink: 0;
  `;
  
  // Create text container
  const textContainer = document.createElement('div');
  textContainer.innerHTML = `
    <div style="font-weight: 600;">${mainText}</div>
    <div style="font-size: 12px; opacity: 0.9; margin-top: 4px;">${subText}</div>
  `;
  
  notification.appendChild(icon);
  notification.appendChild(textContainer);
  
  // Add click handler to open modal (if callback provided) or just remove
  notification.addEventListener('click', () => {
    if (onOpenModal) {
      notification.remove();
      onOpenModal();
    } else {
      notification.remove();
    }
  });
  
  // Add slide-in animation
  const style = document.createElement('style');
  if (!document.querySelector('#rememberme-notification-style')) {
    style.id = 'rememberme-notification-style';
    style.textContent = `
      @keyframes slideIn {
        from {
          transform: translateX(100%);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(notification);
  
  // Auto-dismiss after 5 seconds (increased from 3 for better UX)
  setTimeout(() => {
    if (notification.parentNode) {
      notification.style.animation = 'slideIn 0.3s ease reverse';
      setTimeout(() => {
        notification.remove();
      }, 300);
    }
  }, 5000);
};

/**
 * Get the current provider name based on the content script context
 * Returns the provider name that matches metadata.provider when saving memories
 */
export const getCurrentProvider = (): string | null => {
  const hostname = window.location.hostname;
  const pathname = window.location.pathname;
  
  // Match based on URL patterns (same as manifest.json content_scripts)
  if (hostname.includes('claude.ai')) {
    return 'Claude';
  }
  if (hostname.includes('chat.openai.com') || hostname.includes('chatgpt.com')) {
    return 'ChatGPT';
  }
  if (hostname.includes('perplexity.ai')) {
    return 'Perplexity';
  }
  if (hostname.includes('gemini.google.com')) {
    return 'Gemini';
  }
  if (hostname.includes('grok.com') || pathname.includes('/i/grok')) {
    return 'Grok';
  }
  if (hostname.includes('deepseek.com')) {
    return 'DeepSeek';
  }
  if (hostname.includes('replit.com')) {
    return 'Replit';
  }
  
  // Fallback - should not happen in provider-specific content scripts
  return null;
};

/**
 * Build search filters that exclude memories from the current provider
 * @param userId - The user ID for filtering
 * @param excludeProvider - Optional provider name to exclude (defaults to current provider)
 * @returns Filter object compatible with Mem0 API
 */
export const buildSearchFilters = (
  supabaseUserId: string | null,
  excludeProvider?: string | null
): Record<string, unknown> => {
  const currentProvider = excludeProvider ?? getCurrentProvider();
  
  // Must have user_id to filter
  if (!supabaseUserId) {
    return {};
  }
  
  // If no provider to exclude, just filter by user_id
  if (!currentProvider) {
    return { user_id: supabaseUserId };
  }
  
  // Filter by user_id AND provider exclusion
  return {
    AND: [
      { user_id: supabaseUserId },
      {
        metadata: {
          provider: { ne: currentProvider }
        }
      }
    ]
  };
};
