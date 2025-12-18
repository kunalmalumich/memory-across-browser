import { MessageRole } from '../types/api';
import type { MemorySearchItem, OptionalApiParams } from '../types/memory';
import { type StorageData, StorageKey } from '../types/storage';
import { createOrchestrator, type SearchStorage } from './background_search';
import { buildSearchFilters, shouldTriggerMemorySearch, showMemoryNotification, getOrgId, getProjectId, getApiKey } from './util_functions';

export interface PlatformConfig {
  provider: string;
  inputSelectors: string[];
  sendButtonSelectors: string[];
  backgroundSearchHookAttribute: string;
  getInputValue: (element: HTMLElement | null) => string;
  getContentWithoutMemories: (text?: string) => string;
  createMemoryModal: (items: any[], isLoading: boolean, sourceButtonId: string | null) => void;
  onMemoryModalShown?: (shown: boolean) => void;
  getLastMessages?: (count: number) => Array<{ role: MessageRole; content: string }>;
  logPrefix: string;
}

export function createPlatformSearchOrchestrator(config: PlatformConfig) {
  return createOrchestrator({
    fetch: async function (query: string, opts: { signal?: AbortSignal }) {
      const data = await new Promise<SearchStorage>(resolve => {
        chrome.storage.sync.get(
          [
            StorageKey.SUPABASE_ACCESS_TOKEN,
            StorageKey.SUPABASE_USER_ID,
            StorageKey.SIMILARITY_THRESHOLD,
            StorageKey.TOP_K,
          ],
          function (items) {
            resolve(items as SearchStorage);
          }
        );
      });

      const supabaseAccessToken = data[StorageKey.SUPABASE_ACCESS_TOKEN];
      const supabaseUserId = data[StorageKey.SUPABASE_USER_ID];
      
      if (!supabaseAccessToken || !supabaseUserId) {
        return [];
      }

      const apiKey = getApiKey();
      if (!apiKey) {
        console.error(`[${config.logPrefix}] VITE_MEM0_API_KEY not configured`);
        return;
      }
      const authHeader = `Token ${apiKey}`;
      const threshold =
        data[StorageKey.SIMILARITY_THRESHOLD] !== undefined
          ? data[StorageKey.SIMILARITY_THRESHOLD]
          : 0.1;
      const topK = data[StorageKey.TOP_K] !== undefined ? data[StorageKey.TOP_K] : 10;

      const optionalParams: OptionalApiParams = {};
      const orgId = getOrgId();
      const projectId = getProjectId();
      if (orgId) {
        optionalParams.org_id = orgId;
      }
      if (projectId) {
        optionalParams.project_id = projectId;
      }

      const payload = {
        query,
        filters: buildSearchFilters(supabaseUserId),
        rerank: true,
        threshold: threshold,
        top_k: topK,
        filter_memories: false,
        ...optionalParams,
      };

      console.log(`[${config.logPrefix}] Search API Request:`, {
        query,
        filters: buildSearchFilters(supabaseUserId),
        supabaseUserId,
        threshold,
        topK,
      });

      const res = await fetch('https://api.mem0.ai/v2/memories/search/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(payload),
        signal: opts && opts.signal,
      });

      console.log(`[${config.logPrefix}] Search API Response Status:`, res.status, res.statusText);

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[${config.logPrefix}] Search API Error:`, {
          status: res.status,
          statusText: res.statusText,
          errorBody: errorText,
          payload: JSON.stringify(payload),
        });
        throw new Error(`API request failed with status ${res.status}`);
      }
      return await res.json();
    },

    onSuccess: function (normQuery: string, responseData: MemorySearchItem[]) {
      const memoryItems = ((responseData as MemorySearchItem[]) || []).map(
        (item: MemorySearchItem) => ({
          id: String(item.id),
          text: item.memory,
          categories: item.categories || [],
        })
      );

      const count = memoryItems.length;
      const openModalCallback = () => {
        if (count > 0) {
          config.createMemoryModal(memoryItems, false, null);
          if (config.onMemoryModalShown) {
            config.onMemoryModalShown(true);
          }
        } else {
          config.createMemoryModal([], false, null);
          if (config.onMemoryModalShown) {
            config.onMemoryModalShown(true);
          }
        }
      };

      showMemoryNotification(count, normQuery, openModalCallback);
    },

    onError: function (normQuery: string, err: Error) {
      console.error(`[${config.logPrefix}] Search error:`, {
        query: normQuery,
        error: err.message,
        errorName: err.name,
        stack: err.stack,
      });
      
      const openModalCallback = () => {
        config.createMemoryModal([], false, null);
        if (config.onMemoryModalShown) {
          config.onMemoryModalShown(true);
        }
      };
      showMemoryNotification(0, undefined, openModalCallback);
    },

    minLength: 5,
    debounceMs: 400,
    cacheTTL: 300000,
  });
}

export function setupBackgroundSearchHook(
  config: PlatformConfig,
  searchOrchestrator: { setText: (text: string) => void }
) {
  let handler: (() => void) | null = null;
  let lastTriggeredText = '';
  let lastTriggerTime = 0;
  const MIN_TRIGGER_INTERVAL = 100; // ms

  const hook = (): boolean => {
    let inputElement: HTMLElement | null = null;
    for (const selector of config.inputSelectors) {
      inputElement = document.querySelector(selector);
      if (inputElement) break;
    }

    if (!inputElement) {
      console.log(`[${config.logPrefix}] Background search hook: input element not found`);
      return false;
    }

    if ((inputElement as any).dataset[config.backgroundSearchHookAttribute]) {
      console.log(`[${config.logPrefix}] Background search hook: already hooked`);
      return true;
    }

    (inputElement as any).dataset[config.backgroundSearchHookAttribute] = 'true';

    if (!handler) {
      handler = function () {
        const text = config.getInputValue(inputElement);
        const now = Date.now();
        
        // Skip if same text triggered recently (prevent rapid duplicates)
        if (text === lastTriggeredText && (now - lastTriggerTime) < MIN_TRIGGER_INTERVAL) {
          return;
        }
        
        const shouldTrigger = shouldTriggerMemorySearch(text);
        
        if (!shouldTrigger) {
          return;
        }
        
        // Track what we triggered
        lastTriggeredText = text;
        lastTriggerTime = now;
        searchOrchestrator.setText(text);
      };
    }

    inputElement.addEventListener('input', handler);
    console.log(`[${config.logPrefix}] Background search hook attached successfully`);
    return true;
  };

  return hook;
}

export function addMemoryToMem0(
  message: string,
  config: PlatformConfig,
  contextMessages?: Array<{ role: MessageRole; content: string }>
): void {
  if (!message || message.trim() === '') {
    console.warn(`[${config.logPrefix}] Empty message, skipping save`);
    return;
  }

  const cleanMessage = config.getContentWithoutMemories(message);
  if (!cleanMessage || cleanMessage.trim() === '') {
    console.warn(`[${config.logPrefix}] Message empty after cleaning, skipping save`);
    return;
  }

  console.log(`[${config.logPrefix}] addMemoryToMem0 called:`, {
    messageLength: cleanMessage.length,
    contextMessagesCount: contextMessages?.length || 0,
  });

  chrome.storage.sync.get(
    [
      StorageKey.SUPABASE_ACCESS_TOKEN,
      StorageKey.SUPABASE_USER_ID,
      StorageKey.MEMORY_ENABLED,
    ],
    function (items: StorageData) {
      const supabaseAccessToken = items[StorageKey.SUPABASE_ACCESS_TOKEN];
      const supabaseUserId = items[StorageKey.SUPABASE_USER_ID];
      
      if (
        items[StorageKey.MEMORY_ENABLED] === false ||
        !supabaseAccessToken ||
        !supabaseUserId
      ) {
        console.warn(`[${config.logPrefix}] Cannot save memory - disabled or missing credentials`);
        return;
      }

      const apiKey = getApiKey();
      if (!apiKey) {
        console.error(`[${config.logPrefix}] VITE_MEM0_API_KEY not configured`);
        return;
      }
      const authHeader = `Token ${apiKey}`;

      const messages = contextMessages || [];
      if (!contextMessages && config.getLastMessages) {
        messages.push(...config.getLastMessages(2));
      }
      messages.push({ role: MessageRole.User, content: cleanMessage });

      const optionalParams: OptionalApiParams = {};
      const orgId = getOrgId();
      const projectId = getProjectId();
      if (orgId) {
        optionalParams.org_id = orgId;
      }
      if (projectId) {
        optionalParams.project_id = projectId;
      }

      const payload = {
        messages: messages,
        user_id: supabaseUserId,
        infer: true,
        metadata: {
          provider: config.provider,
        },
        version: 'v2',
        ...optionalParams,
      };

      console.log(`[${config.logPrefix}] Saving memory to API:`, {
        messageCount: messages.length,
        userId: supabaseUserId,
        hasOrgId: !!orgId,
        hasProjectId: !!projectId,
      });

      fetch('https://api.mem0.ai/v1/memories/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify(payload),
      })
        .then(response => {
          if (!response.ok) {
            console.error(`[${config.logPrefix}] Memory save failed:`, {
              status: response.status,
              statusText: response.statusText,
            });
            return response.text().then(text => {
              console.error(`[${config.logPrefix}] Error response body:`, text);
            });
          }
          console.log(`[${config.logPrefix}] Memory saved successfully`);
          return response.json();
        })
        .catch(error => {
          console.error(`[${config.logPrefix}] Error saving memory:`, error);
        });
    }
  );
}

