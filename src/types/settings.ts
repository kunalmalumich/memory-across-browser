/** User preference structure with memory settings and thresholds */
export type UserSettings = Partial<{
  supabaseAccessToken: string;
  supabaseUserId: string;
  memoryEnabled: boolean;
  selectedOrg: string;
  selectedProject: string;
  similarityThreshold: number;
  topK: number;
}>;

/** Sidebar-specific settings with organization and project info */
export type SidebarSettings = {
  supabase_user_id?: string;
  selected_org?: string;
  selected_org_name?: string;
  selected_project?: string;
  selected_project_name?: string;
  memory_enabled: boolean;
  auto_inject_enabled: boolean;
  similarity_threshold: number;
  top_k: number;
  track_searches: boolean;
};

/** Settings structure for API calls */
export type Settings = {
  hasCreds: boolean;
  supabaseAccessToken: string | null;
  supabaseUserId: string | null;
  orgId: string | null;
  projectId: string | null;
  memoryEnabled: boolean;
};
