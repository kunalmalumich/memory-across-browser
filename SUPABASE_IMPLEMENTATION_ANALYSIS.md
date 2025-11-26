# Supabase Magic Link Authentication - Implementation Analysis

## Environment Variables Required

### 1. Build-time Environment Variables
These must be set when building the extension:

```bash
VITE_SUPABASE_URL=https://[YOUR_PROJECT_REF].supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key_here
```

**How to set:**
- Create `.env` file in project root (already in `.gitignore`)
- Copy from `.env.example` and fill in values
- Vite will inject these at build time via `import.meta.env.VITE_*`

**Get values from:**
```bash
supabase projects api-keys --project-ref ebuslehsjptvltylxtnv
```

## Current Implementation Status

### ✅ Complete Components

1. **Supabase Client Setup** (`src/utils/supabase.ts`)
   - ✅ Uses environment variables
   - ✅ Graceful degradation if not configured (creates dummy client, logs warnings)
   - ✅ Exports supabase client
   - ✅ Extension can build/run without env vars (features just won't work)

2. **Auth Utilities** (`src/utils/auth.ts`)
   - ✅ `getSupabaseUserId()` - Get user ID from storage
   - ✅ `getSupabaseUserEmail()` - Get user email from storage
   - ✅ `getSupabaseSession()` - Get session data
   - ✅ `isSupabaseAuthenticated()` - Check auth + auto-refresh
   - ✅ `refreshSupabaseSession()` - Refresh expired sessions
   - ✅ `logoutSupabase()` - Logout and clear data
   - ✅ `getSupabaseAccessToken()` - Get token for API calls

3. **Popup UI** (`src/popup.ts`, `src/popup.html`)
   - ✅ Email input field
   - ✅ Magic Link request functionality
   - ✅ Error/success message display
   - ✅ Checks for Supabase auth on load

4. **Background Script** (`src/background.ts`)
   - ✅ Handles Magic Link callback
   - ✅ Verifies token with Supabase
   - ✅ Stores session and user data
   - ✅ Updates user_sessions table
   - ✅ Broadcasts auth success

5. **Auth Callback** (`auth-callback.html`, `auth-callback.js`)
   - ✅ Extracts token_hash from URL
   - ✅ Sends to background script
   - ✅ Shows success/error messages

6. **Storage Types** (`src/types/storage.ts`)
   - ✅ All Supabase storage keys defined

7. **Common Utilities** (`src/utils/util_functions.ts`)
   - ✅ `hasValidAuth()` - Checks Supabase + legacy auth
   - ✅ `getAccessToken()` - Gets Supabase or legacy token

8. **Content Script Common** (`src/utils/content_script_common.ts`)
   - ✅ `createPlatformSearchOrchestrator()` - Uses Supabase token
   - ✅ `addMemoryToMem0()` - Uses Supabase token, removed user_id

### ✅ Fixed - Content Scripts Now Check Supabase Auth

**Status:** All content scripts have been updated to use `hasValidAuth()` which checks both Supabase and legacy auth.

**Updated Files:**
- ✅ `src/claude/content.ts` - `handleRememberMeModal()` now uses `hasValidAuth()`
- ✅ `src/chatgpt/content.ts` - `handleRememberMeModal()` now uses `hasValidAuth()`
- ✅ `src/gemini/content.ts` - `handleRememberMeModal()` now uses `hasValidAuth()`
- ✅ `src/grok/content.ts` - `handleRememberMeModal()` now uses `hasValidAuth()`
- ✅ `src/replit/content.ts` - `handleRememberMeModal()` now uses `hasValidAuth()`
- ✅ `src/deepseek/content.ts` - `getMemoryEnabledState()` now uses `hasValidAuth()`
- ℹ️ `src/perplexity/content.ts` - Uses shared utilities that already check Supabase auth

**Updated Code Pattern:**
```typescript
// Use hasValidAuth() from util_functions (checks Supabase + legacy)
const hasAuth = await hasValidAuth();
if (!hasAuth) {
  showLoginPopup();
  return;
}
```

## Complete Flow Diagram

```
1. User opens extension popup
   └─> popup.ts: checkAuthStatus()
       └─> Checks SUPABASE_ACCESS_TOKEN in storage
           ├─> If found: Close popup, toggle sidebar
           └─> If not: Show email input

2. User enters email and clicks "Send Magic Link"
   └─> popup.ts: requestMagicLink()
       └─> supabase.auth.signInWithOtp({ email, emailRedirectTo })
           └─> Supabase sends email with Magic Link

3. User clicks Magic Link in email
   └─> Opens: chrome-extension://[id]/auth-callback.html?token_hash=xxx&type=email
       └─> auth-callback.js: Extracts token_hash
           └─> Sends message to background: 'SUPABASE_MAGIC_LINK_CALLBACK'

4. Background script receives callback
   └─> background.ts: handleMagicLinkCallback()
       └─> supabase.auth.verifyOtp({ token_hash, type })
           └─> Gets session + user data
               ├─> Stores in chrome.storage.sync:
               │   ├─> SUPABASE_ACCESS_TOKEN
               │   ├─> SUPABASE_REFRESH_TOKEN
               │   ├─> SUPABASE_USER_ID
               │   ├─> SUPABASE_USER_EMAIL
               │   └─> SUPABASE_SESSION_EXPIRES_AT
               └─> Updates user_sessions table in Supabase

5. User uses extension features
   └─> Content scripts check auth:
       └─> hasValidAuth() or isSupabaseAuthenticated()
           └─> If authenticated: Use SUPABASE_ACCESS_TOKEN for API calls
           └─> API calls to mem0.ai use Bearer token (NO user_id in body)

6. Session expires
   └─> isSupabaseAuthenticated() detects expiry
       └─> refreshSupabaseSession()
           └─> Uses refresh token to get new session
               └─> Updates storage with new tokens
```

## Completed Fixes

### 1. ✅ Content Scripts Now Check Supabase Auth
All content scripts now use `hasValidAuth()` which checks both Supabase and legacy auth.

### 2. ✅ Vite Config Updated
Added `envPrefix: 'VITE_'` to `vite.config.ts` to ensure environment variables are loaded.

### 3. ✅ Error Handling Improved
- Supabase client now creates a dummy client if env vars are missing (graceful degradation)
- Logs warnings instead of throwing errors
- Extension can build and run without Supabase configured (features just won't work)

## Testing Checklist

- [ ] Environment variables set in `.env` (copy from `.env.example`)
- [ ] Extension builds without errors (even without env vars - will warn but build)
- [ ] Popup shows email input when not authenticated
- [ ] Magic Link request succeeds
- [ ] Email received with Magic Link
- [ ] Clicking Magic Link redirects to extension
- [ ] Background script verifies token
- [ ] Session stored in Chrome storage
- [ ] user_sessions table updated in Supabase
- [ ] Content scripts recognize Supabase auth (all platforms)
- [ ] API calls work with Supabase token (no user_id in body)
- [ ] Session refresh works on expiry
- [ ] Logout clears all Supabase data

## Summary of Changes Made

1. **Updated all content scripts** to use `hasValidAuth()` instead of checking only legacy auth
2. **Updated Deepseek's `getMemoryEnabledState()`** to use `hasValidAuth()`
3. **Improved Supabase client initialization** to handle missing env vars gracefully
4. **Updated Vite config** to ensure environment variables are loaded
5. **Created `.env.example`** file as a template for environment variables


