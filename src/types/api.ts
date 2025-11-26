/** message roles (User, Assistant) */
export enum MessageRole {
  User = 'user',
  Assistant = 'assistant',
}

/** Message structure with role and content */
export type ApiMessage = {
  role: string;
  content: string;
};

/** Request payload for memory API calls */
export type ApiMemoryRequest = {
  messages: ApiMessage[];
  user_id: string;
  metadata: {
    provider: string;
    category: string;
    page_url?: string;
    engine?: string;
  };
  version?: string; // Mem0 API version (v2 recommended)
  org_id?: string;
  project_id?: string;
};

/** Array of memory search results */
export type MemorySearchResponse = Array<{
  id: string;
  memory: string;
  text?: string;
  created_at?: string;
  user_id?: string;
  categories?: string[];
}>;

/** Extension source identifier */
export const SOURCE = 'REMEMBERME_CHROME_EXTENSION';
