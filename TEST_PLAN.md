# Test Plan for Content Script Refactoring

## Overview
This test plan verifies that the refactored content scripts maintain all functionality while using shared utilities.

## Test Cases

### 1. Memory Addition Tests
**Objective:** Verify memories are added when users send messages on all platforms.

#### Test 1.1: ChatGPT Memory Addition
- [ ] Navigate to https://chat.openai.com
- [ ] Type a message: "I love React hooks"
- [ ] Click send button
- [ ] Verify in browser console: `[ChatGPT] Error saving memory:` should NOT appear (or should show success)
- [ ] Check Network tab: POST request to `https://api.mem0.ai/v1/memories/` with provider: "ChatGPT"

#### Test 1.2: Perplexity Memory Addition
- [ ] Navigate to https://www.perplexity.ai
- [ ] Type a message: "Explain quantum computing"
- [ ] Click submit button
- [ ] Verify in browser console: Memory addition logs appear
- [ ] Check Network tab: POST request with provider: "Perplexity"

#### Test 1.3: Gemini Memory Addition
- [ ] Navigate to https://gemini.google.com
- [ ] Type a message: "What is machine learning?"
- [ ] Click send button
- [ ] Verify in browser console: Memory addition logs appear
- [ ] Check Network tab: POST request with provider: "Gemini"

#### Test 1.4: Claude Memory Addition
- [ ] Navigate to https://claude.ai
- [ ] Type a message: "Tell me about TypeScript"
- [ ] Click send button
- [ ] Verify in browser console: Memory addition logs appear
- [ ] Check Network tab: POST request with provider: "Claude"

### 2. Background Search Tests
**Objective:** Verify background memory search triggers on typing.

#### Test 2.1: ChatGPT Background Search
- [ ] Navigate to https://chat.openai.com
- [ ] Type in input: "What is React?"
- [ ] Wait for sentence completion (type period or 4+ words)
- [ ] Verify in console: `[ChatGPT] Background search for:`
- [ ] Check Network tab: POST request to `https://api.mem0.ai/v2/memories/search/`
- [ ] Verify notification appears with memory count

#### Test 2.2: Perplexity Background Search
- [ ] Navigate to https://www.perplexity.ai
- [ ] Type in input: "Explain neural networks."
- [ ] Verify in console: `[Perplexity] Background search for:`
- [ ] Check Network tab: Search API request
- [ ] Verify notification appears

#### Test 2.3: Gemini Background Search
- [ ] Navigate to https://gemini.google.com
- [ ] Type in input: "What is Python?"
- [ ] Verify in console: `[Gemini] Background search for:`
- [ ] Check Network tab: Search API request
- [ ] Verify notification appears

#### Test 2.4: Claude Background Search
- [ ] Navigate to https://claude.ai
- [ ] Type in input: "Explain async/await."
- [ ] Verify in console: `Claude background search triggered:`
- [ ] Check Network tab: Search API request
- [ ] Verify notification appears

### 3. Memory Modal Tests
**Objective:** Verify memory modal opens from notifications.

#### Test 3.1: All Platforms - Modal Opening
- [ ] Trigger background search (type a query that returns memories)
- [ ] Click on the memory notification
- [ ] Verify modal opens with memory list
- [ ] Verify "Add to Prompt" button works
- [ ] Verify individual memory "Add" buttons work
- [ ] Verify modal closes properly

### 4. No Icon on Text Box Tests
**Objective:** Verify no icons appear on input fields (notification-only mode).

#### Test 4.1: All Platforms - No Icons
- [ ] Navigate to each platform
- [ ] Inspect the input/textarea element
- [ ] Verify NO element with id `rememberme-icon-button` exists
- [ ] Verify NO icon button is injected into the input area
- [ ] Verify only notifications appear (not inline icons)

### 5. Cross-Platform Memory Exclusion Tests
**Objective:** Verify memories from same platform are excluded from search.

#### Test 5.1: Platform-Specific Exclusion
- [ ] Add a memory from ChatGPT: "I use React daily"
- [ ] Search for "React" in ChatGPT
- [ ] Verify the memory "I use React daily" does NOT appear in results
- [ ] Search for "React" in Perplexity
- [ ] Verify the memory DOES appear (cross-platform)

### 6. Code Quality Tests
**Objective:** Verify refactoring maintains code quality.

#### Test 6.1: TypeScript Compilation
- [ ] Run: `npx tsc --noEmit`
- [ ] Verify no TypeScript errors
- [ ] Verify all imports resolve correctly

#### Test 6.2: Linting
- [ ] Run: `npm run lint` (if available)
- [ ] Verify no linting errors
- [ ] Verify code follows style guidelines

#### Test 6.3: Shared Code Usage
- [ ] Verify `src/utils/content_script_common.ts` exists
- [ ] Verify all platforms import from shared utilities
- [ ] Verify no duplicate orchestrator code in platform files
- [ ] Verify no duplicate background search hook code
- [ ] Verify no duplicate memory addition code

### 7. Error Handling Tests
**Objective:** Verify error handling works correctly.

#### Test 7.1: API Errors
- [ ] Disconnect internet
- [ ] Try to add memory
- [ ] Verify errors are caught and logged (not thrown)
- [ ] Verify extension continues to work

#### Test 7.2: Missing Credentials
- [ ] Clear API key/access token from storage
- [ ] Try to add memory
- [ ] Verify no errors thrown
- [ ] Verify graceful failure

### 8. Performance Tests
**Objective:** Verify refactoring doesn't impact performance.

#### Test 8.1: Initialization Speed
- [ ] Measure time to initialize on each platform
- [ ] Verify initialization completes in < 2 seconds
- [ ] Verify no console errors during initialization

#### Test 8.2: Search Debouncing
- [ ] Type rapidly in input field
- [ ] Verify search requests are debounced (not sent on every keystroke)
- [ ] Verify final search executes after typing stops

## Success Criteria

✅ All memory addition tests pass
✅ All background search tests pass
✅ Memory modal opens and functions correctly
✅ No icons appear on text input boxes
✅ Cross-platform memory exclusion works
✅ TypeScript compiles without errors
✅ Shared code is properly used (no duplication)
✅ Error handling works gracefully
✅ Performance is acceptable

## Notes

- Test on Chrome/Edge browser
- Ensure extension is loaded and enabled
- Check browser console for logs
- Monitor Network tab for API calls
- Verify memory metadata includes correct provider name

