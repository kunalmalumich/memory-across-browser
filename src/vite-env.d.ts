/// <reference types="vite/client" />
/// <reference types="chrome-types" />

// Chrome types are provided by chrome-types package via namespace declaration
// This ensures chrome is available as a global variable
declare var chrome: typeof chrome;

interface ImportMetaEnv {
  // Supabase Configuration (Required)
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  
  // Mem0 Organization & Project (Required)
  readonly VITE_MEM0_ORG_ID?: string;
  readonly VITE_MEM0_PROJECT_ID?: string;
  
  // Legacy/Unused (can be removed)
  readonly VITE_MEM0_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

