import { MessageRole } from '../types/api';
import type { ExtendedElement, MutableMutationObserver } from '../types/dom';
import type { MemorySearchItem, OptionalApiParams } from '../types/memory';
import { SidebarAction } from '../types/messages';
import { type StorageData, StorageKey } from '../types/storage';
import { REMEMBERME_PROMPTS } from '../utils/llm_prompts';
import { SITE_CONFIG } from '../utils/site_config';
import {
  getBrowser,
  sendExtensionEvent,
  hasValidAuth,
  getOrgId,
  getProjectId,
  getApiKey,
  checkAuthOnPageLoad,
} from '../utils/util_functions';
import {
  createPlatformSearchOrchestrator,
  setupBackgroundSearchHook,
  addMemoryToMem0,
  type PlatformConfig,
} from '../utils/content_script_common';
import { REMEMBERME_UI, type Placement } from '../utils/util_positioning';

export {};

console.log('[Gemini] Content script loaded at:', new Date().toISOString());
console.log('[Gemini] Document ready state:', document.readyState);
console.log('[Gemini] Current URL:', window.location.href);

let isProcessingRememberMe = false;

let memoryModalShown: boolean = false;

// Global variable to store all memories
let allMemories: string[] = [];

// Track added memories by ID
const allMemoriesById: Set<string> = new Set<string>();

// Reference to the modal overlay for updates
let currentModalOverlay: HTMLDivElement | null = null;

let inputObserver: MutationObserver | null = null;

// **PERFORMANCE FIX: Add initialization flags and cleanup variables**
let isInitialized: boolean = false;
let sendListenerAdded: boolean = false;
let mainObserver: MutableMutationObserver | null = null;
let notificationObserver: MutationObserver | null = null;
let setupRetryCount: number = 0;
const MAX_SETUP_RETRIES: number = 10;

// **TIMING FIX: Add periodic element detection**
let elementDetectionInterval: number | null = null;
let lastFoundTextarea: HTMLElement | null = null;
let lastFoundSendButton: HTMLButtonElement | null = null;

// Function to get the last N messages from the conversation
function getLastMessages(count: number): Array<{ role: MessageRole; content: string }> {
  const messages: Array<{ role: MessageRole; content: string }> = [];
  
  // Try multiple selectors to find conversation container
  const conversationSelectors = [
    '[data-conversation-id]',
    '.conversation-container',
    'main',
    '[role="main"]',
    '.chat-container',
  ];
  
  let conversationContainer: Element | null = null;
  for (const selector of conversationSelectors) {
    conversationContainer = document.querySelector(selector);
    if (conversationContainer) break;
  }
  
  // If no container found, try to find message elements directly
  if (!conversationContainer) {
    // Look for user and assistant messages directly
    const userMessages = document.querySelectorAll('[data-message-author-role="user"], [data-role="user"], .user-message, .message.user');
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"], [data-role="assistant"], .assistant-message, .message.assistant');
    
    const allMessages: Array<{ element: Element; role: MessageRole; order: number }> = [];
    
    userMessages.forEach((el, idx) => {
      allMessages.push({ element: el, role: MessageRole.User, order: idx });
    });
    
    assistantMessages.forEach((el, idx) => {
      allMessages.push({ element: el, role: MessageRole.Assistant, order: idx });
    });
    
    // Sort by DOM order (approximate)
    allMessages.sort((a, b) => {
      const posA = Array.from(document.body.querySelectorAll('*')).indexOf(a.element as HTMLElement);
      const posB = Array.from(document.body.querySelectorAll('*')).indexOf(b.element as HTMLElement);
      return posA - posB;
    });
    
    // Get last N messages
    const lastMessages = allMessages.slice(-count);
    
    for (const msg of lastMessages) {
      const content = msg.element.textContent?.trim() || '';
      if (content) {
        messages.push({ role: msg.role, content });
      }
    }
    
    return messages;
  }
  
  // Extract messages from container
  const messageElements = Array.from(conversationContainer.children).reverse();
  
  for (const element of messageElements) {
    if (messages.length >= count) {
      break;
    }
    
    // Try multiple selectors for user messages
    const userElement = 
      element.querySelector('[data-message-author-role="user"]') ||
      element.querySelector('[data-role="user"]') ||
      element.querySelector('.user-message') ||
      element.querySelector('.message.user') ||
      (element.classList.contains('user-message') || element.classList.contains('user') ? element : null);
    
    // Try multiple selectors for assistant messages
    const assistantElement = 
      element.querySelector('[data-message-author-role="assistant"]') ||
      element.querySelector('[data-role="assistant"]') ||
      element.querySelector('.assistant-message') ||
      element.querySelector('.message.assistant') ||
      (element.classList.contains('assistant-message') || element.classList.contains('assistant') ? element : null);
    
    if (userElement) {
      const content = userElement.textContent?.trim() || 
                     userElement.querySelector('.message-content')?.textContent?.trim() ||
                     userElement.querySelector('.text-content')?.textContent?.trim() || '';
      if (content) {
        messages.unshift({ role: MessageRole.User, content });
      }
    } else if (assistantElement) {
      const content = assistantElement.textContent?.trim() || 
                     assistantElement.querySelector('.message-content')?.textContent?.trim() ||
                     assistantElement.querySelector('.text-content')?.textContent?.trim() ||
                     assistantElement.querySelector('.markdown')?.textContent?.trim() || '';
      if (content) {
        messages.unshift({ role: MessageRole.Assistant, content });
      }
    }
  }
  
  return messages;
}

// Auto-sync functions
function getConversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/app\/([a-z0-9]+)/);
  return match?.[1] || null;
}

function extractAllUserMessages(): Array<{ role: MessageRole; content: string }> {
  const messages: Array<{ role: MessageRole; content: string }> = [];
  const userMessages = document.querySelectorAll('[data-message-author-role="user"], [data-role="user"], .user-message, .message.user');
  
  userMessages.forEach((element) => {
    const content = element.textContent?.trim() || 
                   element.querySelector('.message-content')?.textContent?.trim() ||
                   element.querySelector('.text-content')?.textContent?.trim() || '';
    if (content) {
      messages.push({ role: MessageRole.User, content });
    }
  });
  
  return messages;
}

async function isConversationSynced(conversationId: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gemini_synced_conversations'], (result) => {
      const synced = new Set(result.gemini_synced_conversations || []);
      resolve(synced.has(conversationId));
    });
  });
}

async function markConversationSynced(conversationId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['gemini_synced_conversations'], (result) => {
      const synced = new Set(result.gemini_synced_conversations || []);
      synced.add(conversationId);
      chrome.storage.local.set({ gemini_synced_conversations: Array.from(synced) }, resolve);
    });
  });
}

function sendMemoriesToMem0(memories: Array<{ role: MessageRole; content: string }>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get([StorageKey.SUPABASE_ACCESS_TOKEN, StorageKey.SUPABASE_USER_ID], (items) => {
      const supabaseAccessToken = items[StorageKey.SUPABASE_ACCESS_TOKEN];
      const supabaseUserId = items[StorageKey.SUPABASE_USER_ID];
      
      if (!supabaseAccessToken || !supabaseUserId) {
        reject('Supabase authentication required');
        return;
      }

      const optionalParams: OptionalApiParams = {};
      const orgId = getOrgId();
      const projectId = getProjectId();
      if (orgId) optionalParams.org_id = orgId;
      if (projectId) optionalParams.project_id = projectId;

      const apiKey = getApiKey();
      if (!apiKey) {
        reject('VITE_MEM0_API_KEY not configured');
        return;
      }

      fetch('https://api.mem0.ai/v1/memories/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Token ${apiKey}`,
        },
        body: JSON.stringify({
          messages: memories,
          user_id: supabaseUserId,
          infer: true,
          metadata: { provider: 'Gemini' },
          version: 'v2',
          ...optionalParams,
        }),
      })
        .then(response => response.ok ? resolve() : reject(`Failed: ${response.status}`))
        .catch(error => reject(`Error: ${error}`));
    });
  });
}

async function autoSyncConversation(conversationId: string): Promise<void> {
  if (!(await getMemoryEnabledState())) return;
  if (await isConversationSynced(conversationId)) return;

  const retryDelays = [2000, 3000, 5000];
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    const messages = extractAllUserMessages();
    
    if (messages.length > 0) {
      try {
        await sendMemoriesToMem0(messages);
        await markConversationSynced(conversationId);
        console.log(`[Gemini Auto-Sync] ✅ Synced ${messages.length} messages from ${conversationId}`);
        return;
      } catch (error) {
        console.error('[Gemini Auto-Sync] ❌ Error:', error);
        return;
      }
    }
  }
}

// Platform configuration
const geminiConfig: PlatformConfig = {
  provider: 'Gemini',
  inputSelectors: [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor.textarea',
    '.ql-editor[aria-label="Enter a prompt here"]',
    '.ql-editor.textarea.new-input-ui',
    '.text-input-field_textarea .ql-editor',
    'div[contenteditable="true"][role="textbox"][aria-label="Enter a prompt here"]',
  ],
  sendButtonSelectors: [],
  backgroundSearchHookAttribute: 'geminiBackgroundHooked',
  getInputValue: (element: HTMLElement | null) => {
    if (!element) return '';
    return (element.textContent || element.innerText || '').trim();
  },
  getContentWithoutMemories: () => {
    return getContentWithoutMemories();
  },
  createMemoryModal: (items, isLoading, sourceButtonId) => {
    createMemoryModal(items, isLoading);
  },
  onMemoryModalShown: (shown) => {
    memoryModalShown = shown;
  },
  getLastMessages: getLastMessages,
  logPrefix: 'Gemini',
};

const geminiSearch = createPlatformSearchOrchestrator(geminiConfig);
const hookGeminiBackgroundSearchTyping = setupBackgroundSearchHook(geminiConfig, geminiSearch);

function getTextarea(): HTMLElement | null {
  const selectors = [
    'rich-textarea .ql-editor[contenteditable="true"]',
    'rich-textarea .ql-editor.textarea',
    '.ql-editor[aria-label="Enter a prompt here"]',
    '.ql-editor.textarea.new-input-ui',
    '.text-input-field_textarea .ql-editor',
    'div[contenteditable="true"][role="textbox"][aria-label="Enter a prompt here"]',
  ];

  for (const selector of selectors) {
    const textarea = document.querySelector(selector) as HTMLElement | null;
    if (textarea) {
      // **TIMING FIX: Store reference for comparison**
      if (lastFoundTextarea !== textarea) {
        lastFoundTextarea = textarea;
        // Reset listener flag when new textarea is found
        if (textarea.dataset.remembermeKeyListener !== 'true') {
          sendListenerAdded = false;
        }
      }

      // **PERFORMANCE FIX: Trigger listener setup if not done yet**
      if (!sendListenerAdded) {
        setTimeout(() => {
          if (!sendListenerAdded) {
            addSendButtonListener();
          }
        }, 500);
      }
      return textarea;
    }
  }
  return null;
}

// **TIMING FIX: Add function to detect send button**
function getSendButton(): HTMLButtonElement | null {
  const selectors = [
    'button[aria-label="Send message"]',
    'button[data-testid="send-button"]',
    'button[type="submit"]:not([aria-label*="attachment"])',
    '.send-button',
    'button[aria-label*="Send"]',
    'button[title*="Send"]',
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector) as HTMLButtonElement | null;
    if (button) {
      // **TIMING FIX: Store reference for comparison**
      if (lastFoundSendButton !== button) {
        lastFoundSendButton = button;
        // Reset listener flag when new button is found
        if (button.dataset.remembermeListener !== 'true') {
          sendListenerAdded = false;
        }
      }

      return button;
    }
  }
  return null;
}

// **TIMING FIX: Add periodic element detection**
function startElementDetection(): void {
  if (elementDetectionInterval) {
    clearInterval(elementDetectionInterval);
  }

  elementDetectionInterval = window.setInterval(() => {
    const textarea = getTextarea();
    const sendButton = getSendButton();

    // If we found elements and listeners aren't set up, try to set them up
    if ((textarea || sendButton) && !sendListenerAdded) {
      addSendButtonListener();
    }

    // If both elements are found and listeners are set up, we can reduce frequency
    if (textarea && sendButton && sendListenerAdded) {
      if (elementDetectionInterval) {
        clearInterval(elementDetectionInterval);
      }
      // Check less frequently once everything is set up
      elementDetectionInterval = window.setInterval(() => {
        const currentTextarea = getTextarea();
        const currentSendButton = getSendButton();

        if ((!currentTextarea || !currentSendButton) && sendListenerAdded) {
          sendListenerAdded = false;
          lastFoundTextarea = null;
          lastFoundSendButton = null;
        }
      }, 5000); // Check every 5 seconds for maintenance
    }
  }, 1000); // Check every second initially
}

function setupInputObserver(): void {
  // **PERFORMANCE FIX: Prevent multiple observers and add retry limit**
  if (inputObserver) {
    return;
  }

  const textarea = getTextarea();
  if (!textarea) {
    if (setupRetryCount < MAX_SETUP_RETRIES) {
      setupRetryCount++;
      setTimeout(setupInputObserver, 500);
    }
    return;
  }

  // **PERFORMANCE FIX: Reset retry count on success**
  setupRetryCount = 0;
}

function setInputValue(inputElement: HTMLElement, value: string): void {
  if (inputElement) {
    // For contenteditable divs, we need to set innerHTML or textContent
    if (inputElement.contentEditable === 'true') {
      // Clear existing content
      inputElement.innerHTML = '';

      // Split the value by newlines and create paragraph elements
      const lines = value.split('\n');
      lines.forEach(line => {
        const p = document.createElement('p');
        if (line.trim() === '') {
          p.innerHTML = '<br>';
        } else {
          p.textContent = line;
        }
        inputElement.appendChild(p);
      });

      // Trigger input event
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));

      // Focus and set cursor to end
      inputElement.focus();

      // Set cursor to end of content
      const range = document.createRange();
      const selection = window.getSelection();
      range.selectNodeContents(inputElement);
      range.collapse(false);
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else {
      // Fallback for regular input/textarea elements
      (inputElement as HTMLTextAreaElement).value = value;
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

// Function to get the content without any memory wrappers
function getContentWithoutMemories(): string {
  const inputElement = getTextarea();

  if (!inputElement) {
    return '';
  }

  let content = inputElement.textContent || '';

  // Remove any memory headers and content
  const memoryPrefix = REMEMBERME_PROMPTS.memory_header_text;
  const prefixIndex = content.indexOf(memoryPrefix);
  if (prefixIndex !== -1) {
    content = content.substring(0, prefixIndex).trim();
  }

  // Also try with regex pattern
  try {
    const REMEMBERME_PLAIN = REMEMBERME_PROMPTS.memory_header_plain_regex;
    content = content.replace(REMEMBERME_PLAIN, '').trim();
  } catch {
    // Ignore regex errors
  }

  return content;
}

// Function to check if memory is enabled
function getMemoryEnabledState(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    chrome.storage.sync.get([StorageKey.MEMORY_ENABLED], function (result) {
      resolve(result.memory_enabled !== false); // Default to true if not set
    });
  });
}

// Track if memory has been captured for this session to prevent duplicates
let memoryCaptured = false;
let lastCapturedMessage = '';

// Add a function to handle send button actions and clear memories after sending
function addSendButtonListener(): void {
  // **PERFORMANCE FIX: Prevent duplicate listener registration**
  if (sendListenerAdded) {
    return;
  }

  // Handle capturing and storing the current message
  function captureAndStoreMemory(): void {
    const textarea = getTextarea();
    if (!textarea) {
      return;
    }

    const message = ((textarea as HTMLElement).textContent || '').trim();
    if (!message) {
      return;
    }

    // Clean message from any existing memory content
    const cleanMessage = getContentWithoutMemories();

    // Prevent duplicate captures for the same message
    if (memoryCaptured && lastCapturedMessage === cleanMessage) {
      return;
    }

    memoryCaptured = true;
    lastCapturedMessage = cleanMessage;

    // Reset the capture flag after a short delay
    setTimeout(() => {
      memoryCaptured = false;
      lastCapturedMessage = '';
    }, 1000);

    // Asynchronously store the memory
    addMemoryToMem0(cleanMessage, geminiConfig);

    // Clear all memories after sending
    setTimeout(() => {
      allMemories = [];
      allMemoriesById.clear();
    }, 100);
  }

  // **TIMING FIX: Use the new getSendButton function**
  const sendButton = getSendButton();

  if (sendButton && !sendButton.dataset.remembermeListener) {
    sendButton.dataset.remembermeListener = 'true';
    sendButton.addEventListener('click', function () {
      captureAndStoreMemory();
    });
  }

  // Handle textarea for Enter key press separately
  const textarea = getTextarea();

  if (textarea) {
    if (!textarea.dataset.remembermeKeyListener) {
      textarea.dataset.remembermeKeyListener = 'true';
      textarea.addEventListener('keydown', function (event) {
        // Check if Enter was pressed without Shift (standard send behavior)
        if (event.key === 'Enter' && !event.shiftKey) {
          // Don't capture here if send button will also trigger
          // The send button click will handle the capture
          return;
        }
      });
    }
  }

  // **TIMING FIX: Only mark as added if we actually found and set up both elements**
  if (textarea && sendButton) {
    sendListenerAdded = true;
  }
}

// REMOVED: Button injection code - using notification-only approach
function injectMem0Button(): void {
  return; // Disabled - notification-only mode
  // Prefer REMEMBERME_UI mounts; fall back to legacy injection only if unavailable
  // if (REMEMBERME_UI && REMEMBERME_UI.mountOnEditorFocus) {
    try {
      if (!document.getElementById('rememberme-icon-button')) {
        REMEMBERME_UI.resolveCachedAnchor(
          { learnKey: location.host + ':' + location.pathname },
          null,
          24 * 60 * 60 * 1000
        ).then(function (hit: { el: Element; placement: Placement | null } | null) {
          if (!hit || !hit.el) {
            return;
          }
          let hs = REMEMBERME_UI.createShadowRootHost('rememberme-root');
          let host = hs.host,
            shadow = hs.shadow;
          host.id = 'rememberme-icon-button';
          let cfg =
            typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.gemini ? SITE_CONFIG.gemini : null;
          let placement = hit.placement ||
            (cfg && cfg.placement) || {
              strategy: 'inline' as const,
              where: 'beforeend' as const,
              inlineAlign: 'end' as const,
            };
          REMEMBERME_UI.applyPlacement({ container: host, anchor: hit.el, placement: placement });
          let style = document.createElement('style');
          style.textContent = `
              :host { position: relative; }
              .rememberme-btn { all: initial; cursor: pointer; display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%; }
              .rememberme-btn img { width:18px; height:18px; border-radius:50%; }
              .dot { position:absolute; top:-2px; right:-2px; width:8px; height:8px; background:#80DDA2; border-radius:50%; border:2px solid #1C1C1E; display:none; }
              :host([data-has-text="1"]) .dot { display:block; }
            `;
          let btn = document.createElement('button');
          btn.className = 'rememberme-btn';
          let img = document.createElement('img');
          img.src = chrome.runtime.getURL('icons/rememberme-icon.png');
          let dot = document.createElement('div');
          dot.className = 'dot';
          btn.appendChild(img);
          shadow.append(style, btn, dot);
          btn.addEventListener('click', function () {
            handleRememberMeModal();
          });
          if (typeof updateNotificationDot === 'function') {
            setTimeout(updateNotificationDot, 0);
          }
        });
      }
    } catch {
      // Ignore errors during re-initialization
    }
    return; // Disabled - notification-only mode
    // REMOVED: Button injection - using notification-only approach
    // REMEMBERME_UI.mountOnEditorFocus({
    //   existingHostSelector: '#rememberme-icon-button',
//       editorSelector:
//         typeof SITE_CONFIG !== 'undefined' &&
//         SITE_CONFIG.gemini &&
//         SITE_CONFIG.gemini.editorSelector
//           ? SITE_CONFIG.gemini.editorSelector
//           : 'textarea, [contenteditable="true"], input[type="text"]',
//       deriveAnchor:
//         typeof SITE_CONFIG !== 'undefined' &&
//         SITE_CONFIG.gemini &&
//         typeof SITE_CONFIG.gemini.deriveAnchor === 'function'
//           ? SITE_CONFIG.gemini.deriveAnchor
//           : function (editor: Element) {
//               return editor.closest('form') || editor.parentElement;
//             },
//       placement:
//         typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.gemini && SITE_CONFIG.gemini.placement
//           ? SITE_CONFIG.gemini.placement
//           : { strategy: 'inline', where: 'beforeend', inlineAlign: 'end' },
//       render: function (shadow: ShadowRoot, host: HTMLElement) {
//         host.id = 'rememberme-icon-button';
//         let style = document.createElement('style');
//         style.textContent = `
//           :host { position: relative; }
//           .rememberme-btn { all: initial; cursor: pointer; display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%; }
//           .rememberme-btn img { width:18px; height:18px; border-radius:50%; }
//           .dot { position:absolute; top:-2px; right:-2px; width:8px; height:8px; background:#80DDA2; border-radius:50%; border:2px solid #1C1C1E; display:none; }
//           :host([data-has-text="1"]) .dot { display:block; }
//         `;
//         let btn = document.createElement('button');
//         btn.className = 'rememberme-btn';
//         let img = document.createElement('img');
//         img.src = chrome.runtime.getURL('icons/rememberme-icon.png');
//         let dot = document.createElement('div');
//         dot.className = 'dot';
//         btn.appendChild(img);
//         shadow.append(style, btn, dot);
//         btn.addEventListener('click', function () {
//           handleRememberMeModal();
//         });
//         if (typeof updateNotificationDot === 'function') {
//           setTimeout(updateNotificationDot, 0);
//         }
//       },
//       fallback: function () {
//         let cfg =
//           typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.gemini ? SITE_CONFIG.gemini : null;
//         return REMEMBERME_UI.mountResilient({
//           anchors: [
//             {
//               find: function () {
//                 let sel =
//                   (cfg && cfg.editorSelector) ||
//                   'textarea, [contenteditable="true"], input[type="text"]';
//                 let ed = document.querySelector(sel);
//                 if (!ed) {
//                   return null;
//                 }
//                 try {
//                   return cfg && typeof cfg.deriveAnchor === 'function'
//                     ? cfg.deriveAnchor(ed)
//                     : ed.closest('form') || ed.parentElement;
//                 } catch (_) {
//                   return ed.closest('form') || ed.parentElement;
//                 }
//               },
//             },
//           ],
//           placement: (cfg && cfg.placement) || {
//             strategy: 'inline',
//             where: 'beforeend',
//             inlineAlign: 'end',
//           },
//           enableFloatingFallback: true,
//           render: function (shadow: ShadowRoot, host: HTMLElement) {
//             host.id = 'rememberme-icon-button';
//             let style = document.createElement('style');
//             style.textContent = `
//               :host { position: relative; }
//               .rememberme-btn { all: initial; cursor: pointer; display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%; }
//               .rememberme-btn img { width:18px; height:18px; border-radius:50%; }
//               .dot { position:absolute; top:-2px; right:-2px; width:8px; height:8px; background:#80DDA2; border-radius:50%; border:2px solid #1C1C1E; display:none; }
//               :host([data-has-text="1"]) .dot { display:block; }
//             `;
//             let btn = document.createElement('button');
//             btn.className = 'rememberme-btn';
//             let img = document.createElement('img');
//             img.src = chrome.runtime.getURL('icons/rememberme-icon.png');
//             let dot = document.createElement('div');
//             dot.className = 'dot';
//             btn.appendChild(img);
//             shadow.append(style, btn, dot);
//             btn.addEventListener('click', function () {
//               handleRememberMeModal();
//             });
//             if (typeof updateNotificationDot === 'function') {
//               setTimeout(updateNotificationDot, 0);
//             }
//           },
//         });
//       },
//     });
  //   return;
  // }
  return; // Disabled - notification-only mode
  let buttonRetryCount = 0;
  const maxButtonRetries = 10;

  // Function to periodically check and add the button if the parent element exists
  async function tryAddButton() {
    // **PERFORMANCE FIX: Add retry limit**
    if (buttonRetryCount >= maxButtonRetries) {
      return;
    }
    buttonRetryCount++;

    // First check if memory is enabled
    const memoryEnabled = await getMemoryEnabledState();

    // Remove existing button if memory is disabled
    if (!memoryEnabled) {
      const existingButton = document.querySelector('#rememberme-icon-button');
      if (existingButton && existingButton.parentElement) {
        existingButton.parentElement.remove();
      }
      // **PERFORMANCE FIX: Reset retry count and set longer timeout**
      buttonRetryCount = 0;
      setTimeout(tryAddButton, 10000);
      return;
    }

    // Look for the toolbox-drawer container
    const toolboxDrawer = document.querySelector('toolbox-drawer .toolbox-drawer-container');

    if (!toolboxDrawer) {
      setTimeout(tryAddButton, 1000);
      return;
    }

    // Check if our button already exists
    if (document.querySelector('#rememberme-icon-button')) {
      // **PERFORMANCE FIX: Reset retry count on success**
      buttonRetryCount = 0;
      return;
    }

    // **PERFORMANCE FIX: Reset retry count when successfully creating button**
    buttonRetryCount = 0;

    // Create mem0 button container to match toolbox-drawer-item structure
    const remembermeButtonContainer = document.createElement('toolbox-drawer-item');
    remembermeButtonContainer.className =
      'mat-mdc-tooltip-trigger toolbox-drawer-item-button ng-tns-c1279795495-8 mat-mdc-tooltip-disabled ng-star-inserted';
    remembermeButtonContainer.style.position = 'relative'; // For popover positioning
    remembermeButtonContainer.style.backgroundColor = 'transparent';
    remembermeButtonContainer.style.border = 'none';

    // Create mem0 button to match the toolbox drawer button style
    const remembermeButton = document.createElement('button');
    remembermeButton.className =
      'mat-ripple mat-mdc-tooltip-trigger toolbox-drawer-item-button gds-label-l is-mobile ng-star-inserted';
    remembermeButton.setAttribute('matripple', '');
    remembermeButton.setAttribute('aria-pressed', 'false');
    remembermeButton.setAttribute('aria-label', 'Mem0');
    remembermeButton.id = 'rememberme-icon-button';
    remembermeButton.style.backgroundColor = 'transparent';
    remembermeButton.style.border = 'none';

    // Create the button label div to match other toolbox items
    const buttonLabel = document.createElement('div');
    buttonLabel.className = 'toolbox-drawer-button-label label';
    buttonLabel.style.cssText = `
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: 'Google Sans', Roboto, sans-serif;
      font-size: 14px;
      font-weight: 500;
      background-color: transparent;
    `;

    // Create notification dot
    const notificationDot = document.createElement('div');
    notificationDot.id = 'rememberme-notification-dot';
    notificationDot.style.cssText = `
      position: absolute;
      top: -2px;
      right: -2px;
      width: 8px;
      height: 8px;
      background-color: #34a853;
      border-radius: 50%;
      border: 1px solid #fff;
      display: none;
      z-index: 1001;
      pointer-events: none;
    `;

    // Add keyframe animation for the dot
    if (!document.getElementById('notification-dot-animation')) {
      const style = document.createElement('style');
      style.id = 'notification-dot-animation';
      style.innerHTML = `
        @keyframes popIn {
          0% { transform: scale(0); }
          50% { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
        
        #rememberme-notification-dot.active {
          display: block !important;
          animation: popIn 0.3s ease-out forwards;
        }
      `;
      document.head.appendChild(style);
    }

    // Add icon and text to button label
    const iconImg = document.createElement('img');
    iconImg.src = chrome.runtime.getURL('icons/rememberme-icon.png');
    iconImg.style.cssText = `
      width: 18px;
      height: 18px;
      border-radius: 50%;
    `;

    const labelText = document.createElement('span');
    labelText.textContent = 'Mem0';

    buttonLabel.appendChild(iconImg);
    buttonLabel.appendChild(labelText);
    remembermeButton.appendChild(buttonLabel);

    // Create popover element (hidden by default)
    const popover = document.createElement('div');
    popover.className = 'mem0-button-popover';
    popover.style.cssText = `
      position: absolute;
      bottom: 48px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #2d2e30;
      border: 1px solid #5f6368;
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      white-space: nowrap;
      z-index: 10001;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
      display: none;
      transition: opacity 0.2s;
      font-family: 'Google Sans', Roboto, sans-serif;
    `;
    popover.textContent = 'Add memories to your prompt';

    // Add arrow
    const arrow = document.createElement('div');
    arrow.style.cssText = `
      position: absolute;
      top: 100%;
      left: 50%;
      transform: translateX(-50%) rotate(45deg);
      width: 8px;
      height: 8px;
      background-color: #2d2e30;
      border-right: 1px solid #5f6368;
      border-bottom: 1px solid #5f6368;
    `;
    popover.appendChild(arrow);

    // Add hover event for popover
    remembermeButtonContainer.addEventListener('mouseenter', () => {
      popover.style.display = 'block';
      setTimeout(() => (popover.style.opacity = '1'), 10);
    });

    remembermeButtonContainer.addEventListener('mouseleave', () => {
      popover.style.opacity = '0';
      setTimeout(() => (popover.style.display = 'none'), 200);
    });

    // Add click event to the mem0 button to show memory modal
    remembermeButton.addEventListener('click', function () {
      // Check if the memories are enabled
      getMemoryEnabledState().then(memoryEnabled => {
        if (memoryEnabled) {
          handleRememberMeModal();
        } else {
          // If memories are disabled, open options
          chrome.runtime.sendMessage({ action: SidebarAction.OPEN_OPTIONS });
        }
      });
    });

    // Assemble button components
    remembermeButtonContainer.appendChild(remembermeButton);
    remembermeButtonContainer.appendChild(notificationDot);
    remembermeButtonContainer.appendChild(popover);

    // Insert the button into the toolbox drawer
    toolboxDrawer.appendChild(remembermeButtonContainer);

    // Update notification dot based on input content
    updateNotificationDot();

    // Ensure notification dot is updated after DOM is fully loaded
    setTimeout(updateNotificationDot, 500);
  }

  // Start trying to add the button
  tryAddButton();
}

// Function to update notification dot visibility based on text in the input
function updateNotificationDot(): void {
  const textarea = getTextarea();
  const notificationDot = document.querySelector('#rememberme-notification-dot');

  if (textarea && notificationDot) {
    // Function to check if input has text
    const checkForText = () => {
      const inputText = (textarea as HTMLElement).textContent || '';
      const hasText = inputText.trim() !== '';

      if (hasText) {
        notificationDot.classList.add('active');
        // Force display style
        notificationDot.style.display = 'block';
      } else {
        notificationDot.classList.remove('active');
        notificationDot.style.display = 'none';
      }
    };

    // **PERFORMANCE FIX: Clean up existing observer first**
    if (notificationObserver) {
      notificationObserver.disconnect();
    }

    // Set up an observer to watch for changes to the input field
    notificationObserver = new MutationObserver(checkForText);

    // Start observing the input element
    notificationObserver.observe(textarea as Node, {
      characterData: true,
      subtree: true,
      childList: true,
    });

    if (!textarea.dataset.geminiNotificationHooked) {
      textarea.dataset.geminiNotificationHooked = 'true';
      textarea.addEventListener('input', checkForText);
      textarea.addEventListener('keyup', checkForText);
      textarea.addEventListener('focus', checkForText);
    }

    // Initial check
    checkForText();

    // Force check after a small delay to ensure DOM is fully loaded
    setTimeout(checkForText, 500);
  } else {
    // **PERFORMANCE FIX: Add retry limit for notification dot setup**
    let notificationRetryCount = 0;
    const maxNotificationRetries = 5;

    const retryNotificationSetup = () => {
      if (notificationRetryCount < maxNotificationRetries) {
        notificationRetryCount++;
        setTimeout(updateNotificationDot, 1000);
      }
    };

    retryNotificationSetup();
  }
}

// Shared function to update the input field with all collected memories
function updateInputWithMemories(): void {
  const inputElement = getTextarea();

  if (inputElement && allMemories.length > 0) {
    const currentContent = (inputElement as HTMLTextAreaElement).value || (inputElement as HTMLElement).textContent || '';
    const headerText = REMEMBERME_PROMPTS.memory_header_text;
    const headerExists = currentContent.includes(headerText);

    if (headerExists) {
      // Header exists - extract existing memories (following Claude's pattern)
      const memoryMarker = '\n\n' + headerText + '\n';
      const memoryIndex = currentContent.indexOf(memoryMarker);
      
      if (memoryIndex >= 0) {
        const beforeMemories = currentContent.substring(0, memoryIndex).trim();
        const afterMemories = currentContent.substring(memoryIndex + memoryMarker.length);
        
        // Extract existing memory lines (following Claude's pattern: parse and collect)
        const existingMemories: string[] = [];
        const lines = afterMemories.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('-')) {
            const memText = trimmed.substring(1).trim();
            // Avoid duplicates (Claude's pattern)
            if (memText && !existingMemories.includes(memText)) {
              existingMemories.push(memText);
            }
          } else if (trimmed && !trimmed.startsWith('-')) {
            // Stop at first non-memory line
            break;
          }
        }

        // Combine existing and new memories, avoiding duplicates (Claude's pattern)
        const combinedMemories = [...existingMemories];
        allMemories.forEach(mem => {
          const memStr = (mem || '').toString();
          if (!combinedMemories.includes(memStr)) {
            combinedMemories.push(memStr);
          }
        });

        // Rebuild content with header + combined memories
        let memoriesContent = '\n\n' + headerText + '\n';
        combinedMemories.forEach((mem, index) => {
          memoriesContent += `- ${mem}`;
          if (index < combinedMemories.length - 1) {
            memoriesContent += '\n';
          }
        });

        setInputValue(inputElement, beforeMemories + memoriesContent);
      }
    } else {
      // Header doesn't exist - add header + memories (existing logic)
      const baseContent = getContentWithoutMemories();

      // Create the memory string with all collected memories
      let memoriesContent = '\n\n' + headerText + '\n';
      // Add all memories to the content
      allMemories.forEach((mem, index) => {
        memoriesContent += `- ${mem}`;
        if (index < allMemories.length - 1) {
          memoriesContent += '\n';
        }
      });

      // Add the final content to the input
      setInputValue(inputElement, baseContent + memoriesContent);
    }
  }
}

// Function to show a small popup message near the button
function showButtonPopup(button: HTMLElement, message: string): void {
  // Remove any existing popups
  const existingPopup = document.querySelector('.rememberme-button-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  const popup = document.createElement('div');
  popup.className = 'rememberme-button-popup';

  popup.style.cssText = `
    position: absolute;
    top: -40px;
    left: 50%;
    transform: translateX(-50%);
    background-color: #2d2e30;
    border: 1px solid #5f6368;
    color: white;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    white-space: nowrap;
    z-index: 10001;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    font-family: 'Google Sans', Roboto, sans-serif;
  `;

  popup.textContent = message;

  // Create arrow
  const arrow = document.createElement('div');
  arrow.style.cssText = `
    position: absolute;
    bottom: -5px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 8px;
    height: 8px;
    background-color: #2d2e30;
    border-right: 1px solid #5f6368;
    border-bottom: 1px solid #5f6368;
  `;

  popup.appendChild(arrow);

  // Position relative to button
  button.style.position = 'relative';
  button.appendChild(popup);

  // Auto-remove after 3 seconds
  setTimeout(() => {
    if (popup && popup.parentElement) {
      popup.remove();
    }
  }, 3000);
}

// Function to show login popup
function showLoginPopup(): void {
  // First remove any existing popups
  const existingPopup = document.querySelector('#rememberme-login-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  // Create popup container
  const popupOverlay = document.createElement('div');
  popupOverlay.id = 'rememberme-login-popup';
  popupOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 10001;
  `;

  const popupContainer = document.createElement('div');
  popupContainer.style.cssText = `
    background-color: #2d2e30;
    border-radius: 12px;
    width: 320px;
    padding: 24px;
    color: white;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: 'Google Sans', Roboto, sans-serif;
  `;

  // Close button
  const closeButton = document.createElement('button');
  closeButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    background: none;
    border: none;
    color: #9aa0a6;
    font-size: 16px;
    cursor: pointer;
  `;
  closeButton.innerHTML = '&times;';
  closeButton.addEventListener('click', () => {
    document.body.removeChild(popupOverlay);
  });

  // Logo and heading
  const logoContainer = document.createElement('div');
  logoContainer.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 16px;
  `;

  const heading = document.createElement('h2');
  heading.textContent = 'Sign in to RememberMe';
  heading.style.cssText = `
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  `;

  logoContainer.appendChild(heading);

  // Message
  const message = document.createElement('p');
  message.textContent = 'Please sign in to access your memories and enhance your conversations!';
  message.style.cssText = `
    margin-bottom: 24px;
    color: #e8eaed;
    font-size: 14px;
    line-height: 1.5;
    text-align: center;
  `;

  // Sign in button
  const signInButton = document.createElement('button');
  signInButton.style.cssText = `
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 10px;
    background-color: #1a73e8;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
    font-family: 'Google Sans', Roboto, sans-serif;
    gap: 8px;
  `;

  // Add logo and text
  const logoDark = document.createElement('img');
  logoDark.src = chrome.runtime.getURL('icons/rememberme-logo-main.png');
  logoDark.style.cssText = `
    width: 20px;
    height: 20px;
    border-radius: 50%;
  `;

  const signInText = document.createElement('span');
  signInText.textContent = 'Sign in with RememberMe';

  signInButton.appendChild(logoDark);
  signInButton.appendChild(signInText);

  signInButton.addEventListener('mouseenter', () => {
    signInButton.style.backgroundColor = '#1557b0';
  });

  signInButton.addEventListener('mouseleave', () => {
    signInButton.style.backgroundColor = '#1a73e8';
  });

  // Open sign-in page when clicked
  signInButton.addEventListener('click', () => {
    window.open('https://app.mem0.ai/login', '_blank');
    document.body.removeChild(popupOverlay);
  });

  // Assemble popup
  popupContainer.appendChild(logoContainer);
  popupContainer.appendChild(message);
  popupContainer.appendChild(signInButton);

  popupOverlay.appendChild(popupContainer);
  popupOverlay.appendChild(closeButton);

  // Add click event to close when clicking outside
  popupOverlay.addEventListener('click', (e: MouseEvent) => {
    if (e.target === popupOverlay) {
      document.body.removeChild(popupOverlay);
    }
  });

  // Add to body
  document.body.appendChild(popupOverlay);
}

function createMemoryModal(
  memoryItems: Array<{ id?: string; text: string; categories?: string[] }>,
  isLoading: boolean = false
): void {
  // Close existing modal if it exists
  if (memoryModalShown && currentModalOverlay) {
    document.body.removeChild(currentModalOverlay);
  }

  memoryModalShown = true;
  let currentMemoryIndex = 0;

  // Calculate modal dimensions (estimated)
  const modalWidth = 447;
  let modalHeight = 400; // Default height
  let memoriesPerPage = 3; // Default number of memories per page

  let topPosition: number;
  let leftPosition: number;

  // Position relative to the Mem0 button
  const remembermeButton =
    (document.querySelector('#rememberme-icon-button') as HTMLElement) ||
    (document.querySelector('button[aria-label="Mem0"]') as HTMLElement);

  if (remembermeButton) {
    const buttonRect = remembermeButton.getBoundingClientRect();

    // Determine if there's enough space below the button
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - buttonRect.bottom;

    // Position the modal centered under the button
    leftPosition = Math.max(buttonRect.left + buttonRect.width / 2 - modalWidth / 2, 10);
    // Ensure the modal doesn't go off the right edge of the screen
    const rightEdgePosition = leftPosition + modalWidth;
    if (rightEdgePosition > window.innerWidth - 10) {
      leftPosition = window.innerWidth - modalWidth - 10;
    }

    if (spaceBelow >= modalHeight) {
      // Place below the button
      topPosition = buttonRect.bottom + 10;
    } else {
      // Place above the button if not enough space below
      topPosition = buttonRect.top - modalHeight - 10;
      // Check if it's in the upper half of the screen
      if (buttonRect.top < viewportHeight / 2) {
        modalHeight = 300; // Reduced height
        memoriesPerPage = 2; // Show only 2 memories
      }
    }
  } else {
    // Fallback positioning
    topPosition = 100;
    leftPosition = window.innerWidth / 2 - modalWidth / 2;
  }

  // Create modal overlay
  const modalOverlay = document.createElement('div');
  modalOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: transparent;
    display: flex;
    z-index: 10000;
    pointer-events: auto;
  `;

  // Save reference to current modal overlay
  currentModalOverlay = modalOverlay;

  // Add event listener to close modal when clicking outside
  modalOverlay.addEventListener('click', (event: MouseEvent) => {
    // Only close if clicking directly on the overlay, not its children
    if (event.target === modalOverlay) {
      closeModal();
    }
  });

  // Create modal container with positioning
  const modalContainer = document.createElement('div');
  modalContainer.style.cssText = `
    background-color: #2d2e30;
    border-radius: 12px;
    width: ${modalWidth}px;
    height: ${modalHeight}px;
    display: flex;
    flex-direction: column;
    color: white;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    position: absolute;
    top: ${topPosition}px;
    left: ${leftPosition}px;
    pointer-events: auto;
    border: 1px solid #5f6368;
    font-family: 'Google Sans', Roboto, sans-serif;
    overflow: hidden;
  `;

  // Create modal header
  const modalHeader = document.createElement('div');
  modalHeader.style.cssText = `
    display: flex;
    align-items: center;
    padding: 10px 16px;
    justify-content: space-between;
    background-color: #35373a;
    flex-shrink: 0;
  `;

  // Create header left section with just the logo
  const headerLeft = document.createElement('div');
  headerLeft.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: center;
  `;

  // Add Mem0 logo
  const logoImg = document.createElement('img');
  logoImg.src = chrome.runtime.getURL('icons/rememberme-logo-main.png');
  logoImg.style.cssText = `
    width: 26px;
    height: 26px;
    border-radius: 50%;
  `;

  // Add "RememberMe" title
  const title = document.createElement('div');
  title.textContent = 'RememberMe';
  title.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    color: white;
    margin-left: 8px;
  `;

  // Create header right section
  const headerRight = document.createElement('div');
  headerRight.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
  `;

  // Create Add to Prompt button with arrow
  const addToPromptBtn = document.createElement('button');
  addToPromptBtn.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: 5px 16px;
    gap: 8px;
    background-color:rgb(27, 27, 27);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: white;
    transition: background-color 0.2s;
  `;
  addToPromptBtn.textContent = 'Add to Prompt';

  // Add arrow icon to button
  const arrowIcon = document.createElement('span');
  arrowIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

  arrowIcon.style.position = 'relative';
  arrowIcon.style.top = '2px';
  addToPromptBtn.appendChild(arrowIcon);

  // Add hover effect for Add to Prompt button
  addToPromptBtn.addEventListener('mouseenter', () => {
    addToPromptBtn.style.backgroundColor = 'rgb(36, 36, 36)';
  });
  addToPromptBtn.addEventListener('mouseleave', () => {
    addToPromptBtn.style.backgroundColor = 'rgb(27, 27, 27)';
  });

  // Create settings button
  const settingsBtn = document.createElement('button');
  settingsBtn.style.cssText = `
    background: none;
    border: none;
    cursor: pointer;
    padding: 8px;
    opacity: 0.6;
    transition: opacity 0.2s;
  `;
  settingsBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  // Add click event to open app.mem0.ai in a new tab
  settingsBtn.addEventListener('click', () => {
    if (currentModalOverlay && document.body.contains(currentModalOverlay)) {
      document.body.removeChild(currentModalOverlay);
      memoryModalShown = false;
      currentModalOverlay = null;
    }

    chrome.runtime.sendMessage({ action: SidebarAction.SIDEBAR_SETTINGS });
  });

  // Add hover effect for the settings button
  settingsBtn.addEventListener('mouseenter', () => {
    settingsBtn.style.opacity = '1';
  });
  settingsBtn.addEventListener('mouseleave', () => {
    settingsBtn.style.opacity = '0.6';
  });

  // Content section
  const contentSection = document.createElement('div');
  const contentSectionHeight = modalHeight - 130; // Account for header and navigation
  contentSection.style.cssText = `
    display: flex;
    flex-direction: column;
    padding: 0 16px;
    gap: 12px;
    overflow: hidden;
    flex: 1;
    height: ${contentSectionHeight}px;
  `;

  // Create memories counter
  const memoriesCounter = document.createElement('div');
  memoriesCounter.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    color: #FFFFFF;
    margin-top: 16px;
    flex-shrink: 0;
  `;

  // Update counter text based on loading state and number of memories
  if (isLoading) {
    memoriesCounter.textContent = `Loading Relevant Memories...`;
  } else {
    // Filter out memories that have already been added for accurate count
    const availableMemoriesCount = memoryItems.filter(
      memory => memory && memory.id && !allMemoriesById.has(memory.id)
    ).length;
    memoriesCounter.textContent = `${availableMemoriesCount} Relevant Memories`;
  }

  // Calculate max height for memories content based on modal height
  const memoriesContentMaxHeight = contentSectionHeight - 40; // Account for memories counter

  // Create memories content container with adjusted height
  const memoriesContent = document.createElement('div');
  memoriesContent.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    flex: 1;
    max-height: ${memoriesContentMaxHeight}px;
    padding-right: 8px;
    margin-right: -8px;
    scrollbar-width: thin;
    scrollbar-color: #5f6368 transparent;
  `;

  // Track currently expanded memory
  let currentlyExpandedMemory: HTMLElement | null = null;

  // Function to create skeleton loading items (adjusted for different heights)
  function createSkeletonItems() {
    memoriesContent.innerHTML = '';

    for (let i = 0; i < memoriesPerPage; i++) {
      const skeletonItem = document.createElement('div');
      skeletonItem.style.cssText = `
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
        padding: 12px;
        background-color: #3c4043;
        border-radius: 8px;
        height: 72px;
        flex-shrink: 0;
        animation: pulse 1.5s infinite ease-in-out;
      `;

      const skeletonText = document.createElement('div');
      skeletonText.style.cssText = `
        background-color: #5f6368;
        border-radius: 4px;
        height: 14px;
        width: 85%;
        margin-bottom: 8px;
      `;

      const skeletonText2 = document.createElement('div');
      skeletonText2.style.cssText = `
        background-color: #5f6368;
        border-radius: 4px;
        height: 14px;
        width: 65%;
      `;

      const skeletonActions = document.createElement('div');
      skeletonActions.style.cssText = `
        display: flex;
        gap: 4px;
        margin-left: 10px;
      `;

      const skeletonButton1 = document.createElement('div');
      skeletonButton1.style.cssText = `
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: #5f6368;
      `;

      const skeletonButton2 = document.createElement('div');
      skeletonButton2.style.cssText = `
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: #5f6368;
      `;

      skeletonActions.appendChild(skeletonButton1);
      skeletonActions.appendChild(skeletonButton2);

      const textContainer = document.createElement('div');
      textContainer.style.cssText = `
        display: flex;
        flex-direction: column;
        flex-grow: 1;
      `;
      textContainer.appendChild(skeletonText);
      textContainer.appendChild(skeletonText2);

      skeletonItem.appendChild(textContainer);
      skeletonItem.appendChild(skeletonActions);
      memoriesContent.appendChild(skeletonItem);
    }

    // Add keyframe animation to document if not exists
    if (!document.getElementById('skeleton-animation')) {
      const style = document.createElement('style');
      style.id = 'skeleton-animation';
      style.innerHTML = `
        @keyframes pulse {
          0% { opacity: 0.6; }
          50% { opacity: 0.8; }
          100% { opacity: 0.6; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  // Function to show memories with adjusted count based on modal position
  function showMemories() {
    memoriesContent.innerHTML = '';

    if (isLoading) {
      createSkeletonItems();
      return;
    }

    // Filter out memories that have already been added
    const availableMemories = memoryItems.filter(memory => {
      const hasId = memory && memory.id;
      const isAlreadyAdded = hasId && allMemoriesById.has(String(memory.id));
      return hasId && !isAlreadyAdded;
    });

    // Update counter with actual available memories count
    memoriesCounter.textContent = isLoading
      ? 'Loading Relevant Memories...'
      : `${availableMemories.length} Relevant Memories`;

    if (availableMemories.length === 0) {
      showEmptyState();
      updateNavigationState(0, 0);
      return;
    }

    // Use the dynamically set memoriesPerPage value
    const memoriesToShow = Math.min(memoriesPerPage, availableMemories.length);

    // Calculate total pages and current page based on available memories
    const totalPages = Math.ceil(availableMemories.length / memoriesToShow);
    const currentPage = Math.floor(currentMemoryIndex / memoriesToShow) + 1;

    // Adjust currentMemoryIndex if it exceeds available memories
    if (currentMemoryIndex >= availableMemories.length) {
      currentMemoryIndex = Math.max(0, availableMemories.length - memoriesToShow);
    }

    // Update navigation buttons state
    updateNavigationState(currentPage, totalPages);

    for (let i = 0; i < memoriesToShow; i++) {
      const memoryIndex = currentMemoryIndex + i;
      if (memoryIndex >= availableMemories.length) {
        break;
      } // Stop if we've reached the end

      const memory = availableMemories[memoryIndex];
      if (!memory) {
        continue;
      }

      // Ensure memory has an ID
      if (!memory.id) {
        memory.id = `memory-${Date.now()}-${memoryIndex}`;
      }

      const memoryContainer = document.createElement('div');
      memoryContainer.style.cssText = `
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
        padding: 12px; 
        background-color: #3c4043;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s ease;
        min-height: 56px; 
        max-height: 56px; 
        overflow: hidden;
        flex-shrink: 0;
      `;

      const memoryText = document.createElement('div');
      memoryText.style.cssText = `
        font-size: 14px;
        line-height: 1.5;
        color: #e8eaed;
        flex-grow: 1;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        transition: all 0.2s ease;
        height: 42px; /* Height for 2 lines of text */
      `;
      memoryText.textContent = memory.text;

      const actionsContainer = document.createElement('div');
      actionsContainer.style.cssText = `
        display: flex;
        gap: 4px;
        margin-left: 10px;
        flex-shrink: 0;
      `;

      // Add button
      const addButton = document.createElement('button');
      addButton.style.cssText = `
        border: none;
        cursor: pointer;
        padding: 4px;
        background: #5f6368;
        color: #e8eaed;
        border-radius: 100%;
        width: 28px;
        height: 28px;
        transition: all 0.2s ease;
      `;

      addButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

      // Add hover effect for add button
      addButton.addEventListener('mouseenter', () => {
        addButton.style.backgroundColor = 'rgb(36, 36, 36)';
      });
      addButton.addEventListener('mouseleave', () => {
        addButton.style.backgroundColor = '#5f6368';
      });

      // Add click handler for add button
      addButton.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        sendExtensionEvent('memory_injection', {
          provider: 'gemini',
          source: 'REMEMBERME_CHROME_EXTENSION',
          browser: getBrowser(),
          injected_all: false,
          memory_id: memory.id,
        });

        // Add this memory
        allMemoriesById.add(String(memory.id));
        allMemories.push(String(memory.text || ''));
        updateInputWithMemories();

        // Refresh the memories display (no need to remove from memoryItems)
        showMemories();
      });

      // Menu button
      const menuButton = document.createElement('button');
      menuButton.style.cssText = `
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: #9aa0a6;
      `;
      menuButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="2"/>
        <circle cx="12" cy="5" r="2"/>
        <circle cx="12" cy="19" r="2"/>
      </svg>`;

      // Track expanded state
      let isExpanded = false;

      // Create remove button (hidden by default)
      const removeButton = document.createElement('button');
      removeButton.style.cssText = `
        display: none;
        align-items: center;
        gap: 6px;
        background: #5f6368;
        color: #e8eaed;
        border-radius: 8px;
        padding: 2px 4px;
        border: none;
        cursor: pointer;
        font-size: 13px;
        margin-top: 12px;
        width: fit-content;
        transition: background-color 0.2s;
      `;
      removeButton.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Remove
      `;

      // Add hover effect for remove button
      removeButton.addEventListener('mouseenter', () => {
        removeButton.style.backgroundColor = '#ea4335';
      });
      removeButton.addEventListener('mouseleave', () => {
        removeButton.style.backgroundColor = '#5f6368';
      });

      // Create content wrapper for text and remove button
      const contentWrapper = document.createElement('div');
      contentWrapper.style.cssText = `
        display: flex;
        flex-direction: column;
        flex-grow: 1;
      `;
      contentWrapper.appendChild(memoryText);
      contentWrapper.appendChild(removeButton);

      // Function to expand memory
      const expandMemory = () => {
        if (currentlyExpandedMemory && currentlyExpandedMemory !== memoryContainer) {
          currentlyExpandedMemory.dispatchEvent(new Event('collapse'));
        }

        isExpanded = true;
        memoryText.style.webkitLineClamp = 'unset';
        memoryText.style.height = 'auto';
        contentWrapper.style.overflowY = 'auto';
        contentWrapper.style.maxHeight = '240px'; // Limit height to prevent overflow
        contentWrapper.style.scrollbarWidth = 'thin';
        contentWrapper.style.scrollbarColor = '#5f6368 transparent';
        memoryContainer.style.backgroundColor = '#2d2e30';
        memoryContainer.style.maxHeight = '300px'; // Allow expansion but within container
        memoryContainer.style.overflow = 'hidden';
        removeButton.style.display = 'flex';
        currentlyExpandedMemory = memoryContainer;

        // Scroll to make expanded memory visible if needed
        memoriesContent.scrollTop = memoryContainer.offsetTop - memoriesContent.offsetTop;
      };

      // Function to collapse memory
      const collapseMemory = () => {
        isExpanded = false;
        memoryText.style.webkitLineClamp = '2';
        memoryText.style.height = '42px';
        contentWrapper.style.overflowY = 'visible';
        memoryContainer.style.backgroundColor = '#3c4043';
        memoryContainer.style.maxHeight = '72px';
        memoryContainer.style.overflow = 'hidden';
        removeButton.style.display = 'none';
        currentlyExpandedMemory = null;
      };

      memoryContainer.addEventListener('collapse', collapseMemory);

      menuButton.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        if (isExpanded) {
          collapseMemory();
        } else {
          expandMemory();
        }
      });

      // Add click handler for remove button
      removeButton.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        // Remove from memoryItems
        const index = memoryItems.findIndex(m => m.id === memory.id);
        if (index !== -1) {
          memoryItems.splice(index, 1);

          // Refresh the memories display
          showMemories();
        }
      });

      actionsContainer.appendChild(addButton);
      actionsContainer.appendChild(menuButton);

      memoryContainer.appendChild(contentWrapper);
      memoryContainer.appendChild(actionsContainer);
      memoriesContent.appendChild(memoryContainer);

      // Add hover effect
      memoryContainer.addEventListener('mouseenter', () => {
        memoryContainer.style.backgroundColor = isExpanded ? '#25272a' : '#484b4f';
      });
      memoryContainer.addEventListener('mouseleave', () => {
        memoryContainer.style.backgroundColor = isExpanded ? '#2d2e30' : '#3c4043';
      });
    }

    // If after filtering for already added memories, there are no items to show,
    // check if we need to go to previous page
    if (memoriesContent.children.length === 0 && availableMemories.length > 0) {
      if (currentMemoryIndex > 0) {
        currentMemoryIndex = Math.max(0, currentMemoryIndex - memoriesPerPage);
        showMemories();
      } else {
        showEmptyState();
      }
    }
  }

  // Function to show empty state
  function showEmptyState() {
    memoriesContent.innerHTML = '';

    const emptyContainer = document.createElement('div');
    emptyContainer.style.cssText = `
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      text-align: center;
      flex: 1;
      min-height: 200px;
    `;

    const emptyIcon = document.createElement('div');
    emptyIcon.innerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v10a2 2 0 01-2 2h-4M3 21h4a2 2 0 002-2v-4m-6 6V9m18 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    emptyIcon.style.marginBottom = '16px';

    const emptyText = document.createElement('div');
    emptyText.textContent = 'No relevant memories found';
    emptyText.style.cssText = `
      color: #9aa0a6;
      font-size: 14px;
      font-weight: 500;
    `;

    emptyContainer.appendChild(emptyIcon);
    emptyContainer.appendChild(emptyText);
    memoriesContent.appendChild(emptyContainer);
  }

  // Add content to modal
  contentSection.appendChild(memoriesCounter);
  contentSection.appendChild(memoriesContent);

  // Navigation section at bottom
  const navigationSection = document.createElement('div');
  navigationSection.style.cssText = `
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 10px;
    border-top: none;
    flex-shrink: 0;
  `;

  // Navigation buttons
  const prevButton = document.createElement('button');
  prevButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M15 19l-7-7 7-7" stroke="#9aa0a6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  prevButton.style.cssText = `
    background: #3c4043;
    border: none;
    border-radius: 50%;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.2s;
  `;

  const nextButton = document.createElement('button');
  nextButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M9 5l7 7-7 7" stroke="#9aa0a6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  nextButton.style.cssText = prevButton.style.cssText;

  // Add navigation button handlers
  prevButton.addEventListener('click', () => {
    if (currentMemoryIndex >= memoriesPerPage) {
      currentMemoryIndex = Math.max(0, currentMemoryIndex - memoriesPerPage);
      showMemories();
    }
  });

  nextButton.addEventListener('click', () => {
    const availableMemories = memoryItems.filter(memory => !allMemoriesById.has(String(memory.id)));
    if (currentMemoryIndex + memoriesPerPage < availableMemories.length) {
      currentMemoryIndex = currentMemoryIndex + memoriesPerPage;
      showMemories();
    }
  });

  // Add hover effects
  [prevButton, nextButton].forEach(button => {
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) {
        button.style.backgroundColor = '#484b4f';
      }
    });
    button.addEventListener('mouseleave', () => {
      if (!button.disabled) {
        button.style.backgroundColor = '#3c4043';
      }
    });
  });

  navigationSection.appendChild(prevButton);
  navigationSection.appendChild(nextButton);

  // Assemble modal
  headerLeft.appendChild(logoImg);
  headerLeft.appendChild(title);
  headerRight.appendChild(addToPromptBtn);
  headerRight.appendChild(settingsBtn);

  modalHeader.appendChild(headerLeft);
  modalHeader.appendChild(headerRight);

  modalContainer.appendChild(modalHeader);
  modalContainer.appendChild(contentSection);
  modalContainer.appendChild(navigationSection);

  modalOverlay.appendChild(modalContainer);

  // Append to body
  document.body.appendChild(modalOverlay);

  // Show initial memories
  showMemories();

  // Update navigation button states
  function updateNavigationState(currentPage: number, totalPages: number): void {
    if (memoryItems.length === 0 || totalPages === 0) {
      prevButton.disabled = true;
      prevButton.style.opacity = '0.5';
      prevButton.style.cursor = 'not-allowed';
      nextButton.disabled = true;
      nextButton.style.opacity = '0.5';
      nextButton.style.cursor = 'not-allowed';
      return;
    }

    if (currentPage <= 1) {
      prevButton.disabled = true;
      prevButton.style.opacity = '0.5';
      prevButton.style.cursor = 'not-allowed';
    } else {
      prevButton.disabled = false;
      prevButton.style.opacity = '1';
      prevButton.style.cursor = 'pointer';
    }

    if (currentPage >= totalPages) {
      nextButton.disabled = true;
      nextButton.style.opacity = '0.5';
      nextButton.style.cursor = 'not-allowed';
    } else {
      nextButton.disabled = false;
      nextButton.style.opacity = '1';
      nextButton.style.cursor = 'pointer';
    }
  }

  // Update Add to Prompt button click handler
  addToPromptBtn.addEventListener('click', () => {
    // Only add memories that are not already added
    const newMemories = memoryItems
      .filter(memory => !allMemoriesById.has(String(memory.id)))
      .map(memory => {
        allMemoriesById.add(String(memory.id));
        return String(memory.text || '');
      });

    sendExtensionEvent('memory_injection', {
      provider: 'gemini',
      source: 'REMEMBERME_CHROME_EXTENSION',
      browser: getBrowser(),
      injected_all: true,
      memory_count: newMemories.length,
    });
    // Add all new memories to allMemories
    allMemories.push(...newMemories);

    // Update the input with all memories
    if (allMemories.length > 0) {
      updateInputWithMemories();
      closeModal();
    } else {
      // If no new memories were added but we have existing ones, just close
      if (allMemoriesById.size > 0) {
        closeModal();
      }
    }
  });

  // Function to close the modal
  function closeModal(): void {
    if (currentModalOverlay && document.body.contains(currentModalOverlay)) {
      document.body.removeChild(currentModalOverlay);
    }
    currentModalOverlay = null;
    memoryModalShown = false;
  }
}

// Handler for the modal approach
async function handleRememberMeModal(): Promise<void> {
  // Check if there are actually memories in the current prompt
  const currentPrompt = getTextarea() ? (getTextarea() as HTMLElement).textContent || '' : '';
  const hasMemoriesInPrompt = currentPrompt.includes(REMEMBERME_PROMPTS.memory_marker_prefix);

  if (!hasMemoriesInPrompt) {
    // If there are no memories in the current prompt, clear the tracking
    allMemoriesById.clear();
    allMemories = [];
  }

  const memoryEnabled = await getMemoryEnabledState();
  if (!memoryEnabled) {
    return;
  }

  // Check if user is logged in (Supabase or legacy)
  const hasAuth = await hasValidAuth();
  if (!hasAuth) {
    showLoginPopup();
    return;
  }

  const textarea = getTextarea();
  let message = textarea ? ((textarea as HTMLElement).textContent || '').trim() : '';

  // If no message, show a popup and return
  if (!message) {
    // Show message that requires input
    const remembermeButton =
      (document.querySelector('#rememberme-icon-button') as HTMLElement) ||
      (document.querySelector('button[aria-label="Mem0"]') as HTMLElement);

    if (remembermeButton) {
      showButtonPopup(remembermeButton as HTMLElement, 'Please enter some text first');
    }
    return;
  }

  // Clean the message of any existing memory content
  message = getContentWithoutMemories();

  if (isProcessingRememberMe) {
    // Don't return, allow the modal to open anyway
  }

  isProcessingRememberMe = true;

  // Add a timeout to reset the flag if something goes wrong
  const timeoutId = setTimeout(() => {
    isProcessingRememberMe = false;
  }, 30000); // 30 second timeout

  // Show the loading modal immediately with the source button ID
  createMemoryModal([], true);

  try {
    const data: StorageData = await new Promise<StorageData>(resolve => {
      chrome.storage.sync.get(
        [
          StorageKey.SUPABASE_ACCESS_TOKEN,
          StorageKey.SUPABASE_USER_ID,
          StorageKey.SIMILARITY_THRESHOLD,
          StorageKey.TOP_K,
        ],
        function (items) {
          resolve(items);
        }
      );
    });

    const supabaseAccessToken = data[StorageKey.SUPABASE_ACCESS_TOKEN];
    const supabaseUserId = data[StorageKey.SUPABASE_USER_ID];

    if (!supabaseAccessToken || !supabaseUserId) {
      isProcessingRememberMe = false;
      return;
    }

    sendExtensionEvent('modal_clicked', {
      provider: 'gemini',
      source: 'REMEMBERME_CHROME_EXTENSION',
      browser: getBrowser(),
    });
    const apiKey = getApiKey();
    if (!apiKey) {
      console.error('[Gemini] VITE_MEM0_API_KEY not configured');
      return;
    }
    const authHeader = `Token ${apiKey}`;

    const messages = [{ role: MessageRole.User, content: message }];

    const optionalParams: OptionalApiParams = {};
    const orgId = getOrgId();
    const projectId = getProjectId();
    if (orgId) {
      optionalParams.org_id = orgId;
    }
    if (projectId) {
      optionalParams.project_id = projectId;
    }

    (geminiSearch as { runImmediate: (message: string) => void }).runImmediate(message);

    // Proceed with adding memory asynchronously without awaiting
      fetch('https://api.mem0.ai/v1/memories/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        body: JSON.stringify({
          messages: messages,
          user_id: supabaseUserId,
          infer: true,
          metadata: {
            provider: 'Gemini',
          },
          version: 'v2',
          ...optionalParams,
        }),
    }).catch(() => {
      // Ignore errors
    });
  } catch {
    // Still show the modal but with empty state if there was an error
    createMemoryModal([], false);
  } finally {
    clearTimeout(timeoutId);
    isProcessingRememberMe = false;
  }
}

function initializeMem0Integration(): void {
  console.log('[Gemini] initializeMem0Integration called');
  
  // **PERFORMANCE FIX: Prevent multiple initializations**
  if (isInitialized) {
    console.log('[Gemini] Already initialized, skipping');
    return;
  }

  try {
    setupInputObserver();
    try {
      console.log('[Gemini] Initializing background search hook...');
      const hookSuccess = hookGeminiBackgroundSearchTyping();
      if (hookSuccess) {
        console.log('[Gemini] Background search hook initialized successfully');
      } else {
        console.log('[Gemini] Background search hook: input element not found, will retry...');
      }
    } catch (error) {
      console.error('[Gemini] Failed to initialize background search hook:', error);
      // Ignore errors
    }
    // COMMENTED OUT: Icon button injection - using notification-only approach
    // injectMem0Button();
    addSendButtonListener();

    // **TIMING FIX: Start periodic element detection**
    startElementDetection();

    // **PERFORMANCE FIX: Clean up existing main observer**
    if (mainObserver) {
      mainObserver.disconnect();
      if (mainObserver.memoryStateInterval) {
        clearInterval(mainObserver.memoryStateInterval);
      }
    }

    // **PERFORMANCE FIX: Consolidated debounced observer with self-trigger prevention**
    let isObserverRunning = false; // Prevent self-triggering

    mainObserver = new MutationObserver(async mutations => {
      // **PERFORMANCE FIX: Prevent observer self-triggering**
      if (isObserverRunning) {
        return;
      }

      // **PERFORMANCE FIX: Filter out our own changes**
      const relevantMutations = mutations.filter(mutation => {
        // Skip mutations on our own elements
        const targetEl = mutation.target as Element;
        if (
          targetEl &&
          ((targetEl as ExtendedElement).id === 'rememberme-notification-dot' ||
            targetEl.classList?.contains('mem0-button-popover') ||
            targetEl.classList?.contains('toolbox-drawer-item') ||
            (targetEl as ExtendedElement).querySelector?.('[aria-label="Mem0"]'))
        ) {
          return false;
        }

        // Only care about significant structural changes
        if (mutation.type === 'childList') {
          // Only if nodes were added/removed, not just text changes
          return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
        }

        return (
          mutation.type === 'attributes' &&
          (mutation.attributeName === 'class' || mutation.attributeName === 'id')
        );
      });

      if (relevantMutations.length === 0) {
        return;
      }

      // Clear existing debounce timer
      if (mainObserver) {
        clearTimeout(mainObserver.debounceTimer);
      }

      // Debounce the actual work
      if (mainObserver) {
        mainObserver.debounceTimer = window.setTimeout(async () => {
          if (isObserverRunning) {
            return;
          }

          isObserverRunning = true;

          try {
            // **PERFORMANCE FIX: Temporarily disconnect observer during DOM modifications**
            if (mainObserver) {
              mainObserver.disconnect();
            }

            // Check memory state first
            const memoryEnabled = await getMemoryEnabledState();

            // REMOVED: Button injection - using notification-only approach
            // Only inject the button if memory is enabled
            if (memoryEnabled) {
              // if (!document.querySelector('#rememberme-icon-button')) {
              //   injectMem0Button();
              // }
              // Retry background search hook if not already attached
              let inputElement: HTMLElement | null = null;
              for (const selector of geminiConfig.inputSelectors) {
                inputElement = document.querySelector(selector);
                if (inputElement) break;
              }
              if (inputElement && !(inputElement as any).dataset[geminiConfig.backgroundSearchHookAttribute]) {
                hookGeminiBackgroundSearchTyping();
              }
              if (!sendListenerAdded) {
                addSendButtonListener();
              }
            } else {
              const host = document.querySelector('#rememberme-icon-button') as HTMLElement | null;
              if (host && host.parentElement) {
                host.parentElement.remove();
              }
            }

            // **PERFORMANCE FIX: Reconnect observer after DOM modifications**
            setTimeout(() => {
              if (mainObserver) {
                mainObserver.observe(document.body, {
                  childList: true,
                  subtree: true,
                  attributeFilter: ['class', 'id'],
                });
              }
            }, 100);
          } catch {
            // Reconnect observer even if there was an error
            setTimeout(() => {
              if (mainObserver) {
                mainObserver.observe(document.body, {
                  childList: true,
                  subtree: true,
                  attributeFilter: ['class', 'id'],
                });
              }
            }, 100);
          } finally {
            isObserverRunning = false;
          }
        }, 500);
      } // Increased debounce to 500ms
    });

    // Add keyboard shortcut for Ctrl+M
    document.addEventListener('keydown', function (event: KeyboardEvent) {
      if (event.ctrlKey && event.key === 'm') {
        event.preventDefault();
        (async () => {
          await handleRememberMeModal();
        })();
      }
    });

    // **PERFORMANCE FIX: Observe with more specific targeting**
    mainObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributeFilter: ['class', 'id'], // Only observe relevant attribute changes
    });

    // **PERFORMANCE FIX: Reduce polling frequency and add cleanup**
    const memoryStateCheckInterval = window.setInterval(async () => {
      try {
        const memoryEnabled = await getMemoryEnabledState();
        if (!memoryEnabled) {
          const existingButton = document.querySelector('#rememberme-icon-button');
          if (existingButton && existingButton.parentElement) {
            existingButton.parentElement.remove();
          }
        } else if (!document.querySelector('#rememberme-icon-button')) {
          // REMOVED: Button injection - using notification-only approach
          // injectMem0Button();
        }
      } catch {
        // Ignore errors
      }
    }, 15000); // Increased from 10s to 15s to reduce frequency further

    // Store reference for cleanup
    mainObserver.memoryStateInterval = memoryStateCheckInterval;

    // **PERFORMANCE FIX: Mark as initialized**
    isInitialized = true;
    
    // Check auth on page load
    setTimeout(() => {
      checkAuthOnPageLoad();
    }, 1000);
  } catch {
    // Ignore errors
  }
}

// Auto-sync on page load and navigation
let geminiCurrentUrl = window.location.href;
setTimeout(() => {
  const conversationId = getConversationIdFromUrl(window.location.href);
  if (conversationId) autoSyncConversation(conversationId);
}, 2000);

setInterval(() => {
  const newUrl = window.location.href;
  if (newUrl !== geminiCurrentUrl) {
    geminiCurrentUrl = newUrl;
    const conversationId = getConversationIdFromUrl(newUrl);
    if (conversationId) autoSyncConversation(conversationId);
  }
}, 1000);

// **PERFORMANCE FIX: Add cleanup function**
function cleanup(): void {
  if (mainObserver) {
    mainObserver.disconnect();
    if (mainObserver.memoryStateInterval) {
      clearInterval(mainObserver.memoryStateInterval);
    }
    if (mainObserver.debounceTimer) {
      clearTimeout(mainObserver.debounceTimer);
    }
  }

  if (notificationObserver) {
    notificationObserver.disconnect();
  }

  if (inputObserver) {
    inputObserver.disconnect();
  }

  // **TIMING FIX: Clean up element detection interval**
  if (elementDetectionInterval) {
    clearInterval(elementDetectionInterval);
  }

  // Reset flags
  isInitialized = false;
  sendListenerAdded = false;
  setupRetryCount = 0;
  lastFoundTextarea = null;
  lastFoundSendButton = null;
}

// **PERFORMANCE FIX: Clean up on page unload**
window.addEventListener('beforeunload', cleanup);

// Initialize the integration when the page loads
console.log('[Gemini] About to call initializeMem0Integration, function exists:', typeof initializeMem0Integration);

try {
  console.log('[Gemini] Starting initialization...');
  initializeMem0Integration();
} catch (error) {
  console.error('[Gemini] Fatal error during initialization:', error);
  console.error('[Gemini] Error stack:', (error as Error).stack);
}
