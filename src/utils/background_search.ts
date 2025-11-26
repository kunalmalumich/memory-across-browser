import type { MemorySearchItem } from '../types/memory';
import type { StorageKey } from '../types/storage';

export type SearchStorage = Partial<{
  [StorageKey.SUPABASE_ACCESS_TOKEN]: string;
  [StorageKey.SUPABASE_USER_ID]: string;
  [StorageKey.SIMILARITY_THRESHOLD]: number;
  [StorageKey.TOP_K]: number;
}>;

export type FetchFn<T> = (query: string, opts: { signal?: AbortSignal }) => Promise<T> | T;

export interface OrchestratorOptions {
  fetch: FetchFn<MemorySearchItem[]>;
  onStart?: (normalizedQuery: string) => void;
  onSuccess?: (
    normalizedQuery: string,
    result: MemorySearchItem[],
    meta: { fromCache: boolean }
  ) => void;
  onError?: (normalizedQuery: string, err: Error) => void;
  onFinally?: (normalizedQuery: string) => void;
  minLength?: number;
  debounceMs?: number;
  cacheTTL?: number;
  useCache?: boolean;
  refreshOnCache?: boolean;
}

export interface OrchestratorState {
  latestText: string;
  lastCompletedQuery: string;
  lastResult: MemorySearchItem[] | null;
  inFlightQuery: string | null;
  isInFlight: boolean;
  cacheSize: number;
}

export interface Orchestrator {
  setText(text?: string): void;
  runImmediate(text?: string | null): void;
  cancel(): void;
  getState(): OrchestratorState;
  setOptions(
    opts: Partial<
      Pick<
        OrchestratorOptions,
        'minLength' | 'debounceMs' | 'cacheTTL' | 'useCache' | 'refreshOnCache'
      >
    >
  ): void;
  clearCache(): void;
}

export function normalizeQuery(s?: string | number | boolean): string {
  if (!s) {
    return '';
  }
  return String(s).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const fetchFn = options?.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('createOrchestrator requires options.fetch(query, { signal })');
  }

  const NOOP = (): void => undefined;

  const onStart = options.onStart ?? NOOP;
  const onSuccess = options.onSuccess ?? NOOP;
  const onError = options.onError ?? NOOP;
  const onFinally = options.onFinally ?? NOOP;

  let minLength = typeof options.minLength === 'number' ? options.minLength : 3;
  let debounceMs = typeof options.debounceMs === 'number' ? options.debounceMs : 75;
  let cacheTTL = typeof options.cacheTTL === 'number' ? options.cacheTTL : 60_000;
  let useCache = options.useCache !== false;
  let refreshOnCache = !!options.refreshOnCache;

  let latestText = '';
  let lastCompletedQuery = '';
  let lastResult: MemorySearchItem[] | null = null;
  let lastSearchedQuery = '';

  let inFlightQuery: string | null = null;
  let abortController: AbortController | null = null;

  let timerId: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;

  const cache = new Map<string, { ts: number; result: MemorySearchItem[] }>();

  function getState(): OrchestratorState {
    return {
      latestText,
      lastCompletedQuery,
      lastResult,
      inFlightQuery,
      isInFlight: !!inFlightQuery,
      cacheSize: cache.size,
    };
  }

  function setOptions(
    newOpts: Partial<
      Pick<
        OrchestratorOptions,
        'minLength' | 'debounceMs' | 'cacheTTL' | 'useCache' | 'refreshOnCache'
      >
    >
  ) {
    if (!newOpts) {
      return;
    }
    if (typeof newOpts.minLength === 'number') {
      minLength = newOpts.minLength;
    }
    if (typeof newOpts.debounceMs === 'number') {
      debounceMs = newOpts.debounceMs;
    }
    if (typeof newOpts.cacheTTL === 'number') {
      cacheTTL = newOpts.cacheTTL;
    }
    if (typeof newOpts.useCache === 'boolean') {
      useCache = newOpts.useCache;
    }
    if (typeof newOpts.refreshOnCache === 'boolean') {
      refreshOnCache = newOpts.refreshOnCache;
    }
  }

  function clearTimer() {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function clearCache() {
    cache.clear();
  }

  function getCached(normQuery: string): MemorySearchItem[] | null {
    if (!useCache) {
      return null;
    }
    const v = cache.get(normQuery);
    if (!v) {
      return null;
    }
    if (Date.now() - v.ts > cacheTTL) {
      cache.delete(normQuery);
      return null;
    }
    return v.result;
  }

  function setCached(normQuery: string, result: MemorySearchItem[]) {
    cache.set(normQuery, { ts: Date.now(), result });
  }

  function cancel() {
    clearTimer();
    if (abortController) {
      try {
        abortController.abort();
      } catch {
        /* ignore abort errors */
      }
    }
    inFlightQuery = null;
    abortController = null;
  }

  function run(query?: string | null) {
    const raw = query !== null && query !== undefined ? String(query) : latestText;
    const norm = normalizeQuery(raw);
    if (!norm || norm.length < minLength) {
      return;
    }

    const cached = getCached(norm);
    if (cached !== null) {
      onSuccess(norm, cached, { fromCache: true });
      if (!refreshOnCache) {
        return;
      }
    }

    if (inFlightQuery && inFlightQuery === norm) {
      return;
    }
    if (inFlightQuery && inFlightQuery !== norm && abortController) {
      try {
        abortController.abort();
      } catch {
        /* ignore abort errors */
      }
    }

    inFlightQuery = norm;
    abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const mySeq = ++seq;

    onStart(norm);

    Promise.resolve()
      .then(() => fetchFn(norm, { signal: abortController ? abortController.signal : undefined }))
      .then(result => {
        if (inFlightQuery !== norm || mySeq !== seq) {
          return;
        }
        setCached(norm, result as MemorySearchItem[]);
        lastCompletedQuery = norm;
        lastSearchedQuery = norm;
        lastResult = result as MemorySearchItem[];
        onSuccess(norm, result as MemorySearchItem[], { fromCache: false });
      })
      .catch((err: Error) => {
        const aborted = abortController?.signal.aborted === true || err.name === 'AbortError';
        if (mySeq !== seq) {
          return;
        }
        if (!aborted) {
          onError(norm, err);
        }
      })
      .finally(() => {
        if (mySeq !== seq) {
          return;
        }
        inFlightQuery = null;
        abortController = null;
        onFinally(norm);
      });
  }

  function schedule() {
    clearTimer();
    const norm = normalizeQuery(latestText);
    if (!norm || norm.length < minLength) {
      return;
    }

    // Check exact match - skip if already searched or currently searching
    if (norm === lastSearchedQuery || norm === inFlightQuery) {
      return;
    }

    // Check if query changed meaningfully (at least 2 characters difference)
    if (lastSearchedQuery && norm) {
      const diff = Math.abs(norm.length - lastSearchedQuery.length);
      // Skip if only 1 character changed and queries are very similar
      if (diff <= 1 && norm.length > 0 && lastSearchedQuery.length > 0) {
        // Calculate similarity - if queries are almost identical, skip
        const shorter = norm.length < lastSearchedQuery.length ? norm : lastSearchedQuery;
        const longer = norm.length >= lastSearchedQuery.length ? norm : lastSearchedQuery;
        if (longer.startsWith(shorter) || shorter.startsWith(longer.slice(0, shorter.length))) {
          return; // Not enough change, skip search
        }
      }
    }

    timerId = setTimeout(() => {
      timerId = null;
      run(latestText);
    }, debounceMs);
  }

  return {
    setText(text: string | null | undefined) {
      latestText = text === null || text === undefined ? '' : String(text);
      schedule();
    },
    runImmediate(text?: string | null) {
      if (text !== null && text !== undefined) {
        latestText = String(text);
      }
      clearTimer();
      run(latestText);
    },
    cancel,
    getState,
    setOptions,
    clearCache,
  };
}
