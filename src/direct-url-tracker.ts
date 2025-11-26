import { type ApiMemoryRequest, MessageRole } from './types/api';
import type { OnCommittedDetails } from './types/browser';
import { Category, Provider } from './types/providers';
import type { Settings } from './types/settings';
import { StorageKey } from './types/storage';
import { getOrgId, getProjectId, getApiKey } from './utils/util_functions';

function getSettings(): Promise<Settings> {
  return new Promise(resolve => {
    chrome.storage.sync.get(
      [
        StorageKey.SUPABASE_ACCESS_TOKEN,
        StorageKey.SUPABASE_USER_ID,
        StorageKey.MEMORY_ENABLED,
      ],
      d => {
        resolve({
          hasCreds: Boolean(d[StorageKey.SUPABASE_ACCESS_TOKEN] && d[StorageKey.SUPABASE_USER_ID]),
          supabaseAccessToken: d[StorageKey.SUPABASE_ACCESS_TOKEN] ?? null,
          supabaseUserId: d[StorageKey.SUPABASE_USER_ID] ?? null,
          orgId: getOrgId() ?? null,
          projectId: getProjectId() ?? null,
          memoryEnabled: d[StorageKey.MEMORY_ENABLED] !== false,
        });
      }
    );
  });
}

async function addMemory(content: string, settings: Settings, pageUrl: string): Promise<boolean> {
  if (!settings.supabaseAccessToken || !settings.supabaseUserId) {
    throw new Error('Missing Supabase credentials');
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('VITE_MEM0_API_KEY not configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Token ${apiKey}`,
  };

  const body: ApiMemoryRequest = {
    messages: [{ role: MessageRole.User, content }],
    user_id: settings.supabaseUserId,
    metadata: {
      provider: Provider.DirectURL,
      category: Category.NAVIGATION,
      page_url: pageUrl || '',
    },
    version: 'v2',
  };
  if (settings.orgId) {
    body.org_id = settings.orgId;
  }
  if (settings.projectId) {
    body.project_id = settings.projectId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.mem0.ai/v1/memories/', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok;
  } finally {
    clearTimeout(timeout);
  }
}

function shouldTrackTyped(details: OnCommittedDetails): boolean {
  if (!details || details.frameId !== 0) {
    return false;
  }
  const url = details.url || '';
  if (!/^https?:\/\//i.test(url)) {
    return false;
  }
  const type = details.transitionType || '';
  const qualifiers = details.transitionQualifiers || [];
  if (type === 'typed') {
    return true;
  }
  if (qualifiers && qualifiers.includes('from_address_bar')) {
    return true;
  }
  return false;
}

export function initDirectUrlTracking(): void {
  try {
    chrome.webNavigation.onCommitted.addListener(async (details: OnCommittedDetails) => {
      try {
        if (!shouldTrackTyped(details)) {
          return;
        }
        const url = details.url;
        if (!url) {
          return;
        }
        if (isSearchResultsUrl(url)) {
          return;
        }

        const settings = await getSettings();
        if (!settings.hasCreds || settings.memoryEnabled === false) {
          return;
        }
        // Gate by track_searches toggle (default OFF  if undefined). We treat typed URL as part of tracking searches/history.
        const allow = await new Promise<boolean>(resolve => {
          try {
            chrome.storage.sync.get([StorageKey.TRACK_SEARCHES], d => {
              resolve(d[StorageKey.TRACK_SEARCHES] === true);
            });
          } catch {
            resolve(false);
          }
        });
        if (!allow) {
          return;
        }

        const hostname = (() => {
          try {
            return new URL(url).hostname;
          } catch {
            return '';
          }
        })();
        const ts = formatTimestamp();
        const content = `User visited ${url}${hostname ? ` (${hostname})` : ''} on ${ts.date} at ${ts.time}`;
        await addMemory(content, settings, url);
      } catch {
        // no-op
      }
    });
  } catch {
    // no-op
  }
}

function isSearchResultsUrl(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    const host = u.hostname || '';
    const path = u.pathname || '';
    const params = u.searchParams || new URLSearchParams();

    if (
      (/^.*\.google\.[^\\/]+$/.test(host) ||
        host === 'google.com' ||
        host.endsWith('.google.com')) &&
      path.startsWith('/search')
    ) {
      if (params.get('q')) {
        return true;
      }
    }
    if (host.endsWith('bing.com') && (path === '/search' || path === '/')) {
      if (params.get('q')) {
        return true;
      }
    }
    if (host === 'search.brave.com' && (path === '/search' || path === '/images')) {
      if (params.get('q')) {
        return true;
      }
    }
    if (host === 'search.arc.net' && path.startsWith('/search')) {
      if (params.get('q') || params.get('query')) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function formatTimestamp(): { date: string; time: string } {
  try {
    const now = new Date();
    const date = now.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const time = now.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    return { date, time };
  } catch {
    return {
      date: new Date().toISOString().slice(0, 10),
      time: new Date().toISOString().slice(11, 16),
    };
  }
}
