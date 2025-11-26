import type { HistoryStateData, HistoryUrl } from './types/browser';
import type { Settings } from './types/settings';
import { StorageKey } from './types/storage';
import { getOrgId, getProjectId } from './utils/util_functions';

(function () {
  // Utilities
  function normalize(text: string): string {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function getSettings(): Promise<Settings> {
    return new Promise<Settings>(resolve => {
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

  function maybeSend(engine: string, query: string): void {
    const q = normalize(query);
    if (!q || q.length < 2) {
      return;
    }

    getSettings().then(async settings => {
      if (!settings.hasCreds || settings.memoryEnabled === false) {
        return;
      }
      // Gate by track_searches toggle (default off if undefined)
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
    });
  }

  // URL based capture for results pages
  function urlCapture(): void {
    const host = location.hostname || '';
    const path = location.pathname || '';
    const params = new URLSearchParams(location.search || '');

    // Google results
    if (/(^|\.)google\./.test(host) && path.startsWith('/search')) {
      const q = params.get('q');
      if (q) {
        maybeSend('Google', q);
      }
      return;
    }

    // Bing results
    if (host.endsWith('bing.com') && (path === '/search' || path === '/')) {
      const q = params.get('q');
      if (q) {
        maybeSend('Bing', q);
      }
      return;
    }

    // Brave results
    if (host === 'search.brave.com' && (path === '/search' || path === '/images')) {
      const q = params.get('q');
      if (q) {
        maybeSend('Brave', q);
      }
      return;
    }

    // Arc results
    if (host === 'search.arc.net' && (path === '/search' || path.startsWith('/search'))) {
      const q = params.get('q') || params.get('query');
      if (q) {
        maybeSend('Arc', q);
      }
      return;
    }
  }

  function installSpaUrlWatcher(): void {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);
    const onUrlChange = () => {
      try {
        urlCapture();
      } catch {
        return;
      }
    };

    history.pushState = function (data: HistoryStateData, unused: string, url?: HistoryUrl) {
      origPush(data, unused, url);
      onUrlChange();
    };

    history.replaceState = function (data: HistoryStateData, unused: string, url?: HistoryUrl) {
      origReplace(data, unused, url);
      onUrlChange();
    };

    window.addEventListener('popstate', onUrlChange);
  }

  // Run
  urlCapture();
  installSpaUrlWatcher();
})();
