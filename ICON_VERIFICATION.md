# RememberMe Icon Verification Guide

## Icon Locations & Usage

### 1. Browser Extension Icons (Chrome Toolbar & Extensions Page)

**Location:** `manifest.json`
- **16x16**: `icons/rememberme-icon16.png` - Toolbar icon
- **48x48**: `icons/rememberme-icon48.png` - Extensions management page
- **128x128**: `icons/rememberme-icon128.png` - Chrome Web Store (minimum)

**Used in:**
- Chrome browser toolbar
- `chrome://extensions` page
- Extension popup button
- Chrome Web Store listing

**Status:** ✅ Configured correctly in manifest.json

---

### 2. Extension Popup Icon

**Location:** `src/popup.html` & `src/popup.ts`
- **Icon**: `icons/rememberme-icon.png`
- **Usage**: Logo in popup header

**Implementation:**
- HTML: `<img id="popupLogo" alt="RememberMe Logo" class="logo" />`
- JavaScript: Sets `src` using `chrome.runtime.getURL('icons/rememberme-icon.png')`

**Status:** ✅ Fixed - Now uses chrome.runtime.getURL()

---

### 3. Sidebar Logo

**Location:** `src/sidebar.ts`
- **Icon**: `icons/rememberme-logo-main.png`
- **Usage**: Logo in sidebar header

**Status:** ✅ Correctly implemented

---

### 4. Login Modals (All Platforms)

**Location:** All content scripts (`claude/content.ts`, `chatgpt/content.ts`, etc.)
- **Icon**: `icons/rememberme-logo-main.png` or `icons/rememberme-icon.png`
- **Usage**: Logo in login popup modals

**Status:** ✅ Correctly implemented using chrome.runtime.getURL()

---

### 5. Memory Notifications

**Location:** `src/utils/util_functions.ts` - `showMemoryNotification()`
- **Icons**: 
  - `icons/rememberme-icon.png` (login notification)
  - `icons/RememberMe_Search_Information_Icon.png` (memories found)
  - `icons/RememberMe_Data_Shield_M_Icon.png` (no memories)

**Status:** ✅ Correctly implemented

---

### 6. Content Script Buttons

**Location:** All platform content scripts
- **Icon**: `icons/rememberme-icon.png`
- **Usage**: Injected buttons in LLM app UIs

**Status:** ✅ Correctly implemented using chrome.runtime.getURL()

---

## Chrome Web Store Requirements

### Required Assets (Upload via Developer Dashboard)

1. **Store Icon**
   - **128x128** (minimum, required)
   - **256x256** (recommended)
   - **512x512** (recommended for high-DPI displays)
   - Format: PNG
   - Use: `icons/rememberme-icon128.png` as base

2. **Promotional Images** (Optional but recommended)
   - **Small Promotional Tile**: 440x280
   - **Marquee Promotional Tile**: 920x680
   - Should include RememberMe branding

3. **Screenshots**
   - **1280x800** or **640x400**
   - Should show RememberMe UI elements (sidebar, notifications, etc.)

**Action Required:** Upload these via Chrome Web Store Developer Dashboard

---

## Verification Checklist

### Build-Time Verification

Run: `npm run verify-icons`

Checks:
- [ ] All icon files exist in `icons/` directory
- [ ] All icon files copied to `dist/icons/` after build
- [ ] `manifest.json` references correct icon paths
- [ ] Icons are web-accessible (`web_accessible_resources`)

### Runtime Verification

After building and loading extension:

- [ ] Extension icon appears in Chrome toolbar
- [ ] Extension icon appears in `chrome://extensions`
- [ ] Extension popup shows logo correctly
- [ ] Sidebar shows logo correctly
- [ ] Login modals show logo correctly
- [ ] Memory notifications show icon correctly
- [ ] Content script buttons show icon correctly

---

## File Structure

```
icons/
├── rememberme-icon16.png      # Extension toolbar icon (16x16)
├── rememberme-icon48.png      # Extension management icon (48x48)
├── rememberme-icon128.png     # Chrome Web Store icon (128x128)
├── rememberme-icon.png        # In-app icon (used in popup, buttons, notifications)
└── rememberme-logo-main.png   # Main logo (used in sidebar, modals)

dist/icons/                    # Built icons (copied during build)
└── [same structure as icons/]
```

---

## Common Issues & Fixes

### Issue: Icon not showing in popup
**Fix:** Ensure using `chrome.runtime.getURL()` instead of relative paths

### Issue: Icon not showing in content scripts
**Fix:** Verify icon is in `web_accessible_resources` in manifest.json

### Issue: Icon not showing after build
**Fix:** Run `npm run build` to copy icons to `dist/icons/`

### Issue: Chrome Web Store icon missing
**Fix:** Upload icon via Chrome Web Store Developer Dashboard (not in codebase)

---

## Testing Commands

```bash
# Verify icons exist
npm run verify-icons

# Build extension (copies icons to dist/)
npm run build

# Check dist icons
ls -la dist/icons/rememberme-icon*.png
```

---

## Summary

✅ **All icon references fixed:**
- Popup now uses chrome.runtime.getURL()
- All content scripts use chrome.runtime.getURL()
- Manifest.json correctly configured
- Icons are web-accessible

⚠️ **Action Required:**
- Upload Chrome Web Store assets via Developer Dashboard
- Verify icons display correctly after building extension

