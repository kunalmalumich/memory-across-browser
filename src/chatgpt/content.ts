/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { MessageRole } from '../types/api';
import type { HistoryStateData } from '../types/browser';
import type { MemoryItem, MemorySearchItem, OptionalApiParams } from '../types/memory';
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
import { REMEMBERME_UI } from '../utils/util_positioning';
import {
  createPlatformSearchOrchestrator,
  setupBackgroundSearchHook,
  addMemoryToMem0,
  type PlatformConfig,
} from '../utils/content_script_common';

export {};

let isProcessingRememberMe: boolean = false;

// Initialize the MutationObserver variable
let observer: MutationObserver;
let memoryModalShown: boolean = false;

// Global variable to store all memories
let allMemories: string[] = [];

// Track added memories by ID
const allMemoriesById: Set<string> = new Set<string>();

// Reference to the modal overlay for updates
let currentModalOverlay: HTMLDivElement | null = null;

// Store dragged position
let draggedPosition: { top: number; left: number } | null = null;

let inputValueCopy: string = '';

let currentModalSourceButtonId: string | null = null;

// Platform configuration
const chatgptConfig: PlatformConfig = {
  provider: 'ChatGPT',
  inputSelectors: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
  sendButtonSelectors: [],
  backgroundSearchHookAttribute: 'mem0BackgroundHooked',
  getInputValue: (element: HTMLElement | null) => {
    if (!element) return '';
    return element.textContent || (element as HTMLTextAreaElement)?.value || '';
  },
  getContentWithoutMemories: (text?: string) => {
    if (typeof text === 'string') return text;
    return getContentWithoutMemories();
  },
  createMemoryModal: (items, isLoading, sourceButtonId) => {
    currentModalSourceButtonId = sourceButtonId;
    createMemoryModal(items, isLoading, sourceButtonId);
  },
  onMemoryModalShown: (shown) => {
    memoryModalShown = shown;
  },
  getLastMessages: getLastMessages,
  logPrefix: 'ChatGPT',
};

const chatgptSearch = createPlatformSearchOrchestrator(chatgptConfig);

function createMemoryModal(
  memoryItems: MemoryItem[],
  isLoading: boolean = false,
  sourceButtonId: string | null = null
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

  let topPosition: number = 0;
  let leftPosition: number = 0;

  // Use dragged position if available, otherwise calculate based on button
  if (draggedPosition) {
    topPosition = draggedPosition.top;
    leftPosition = draggedPosition.left;
  } else if (sourceButtonId === 'rememberme-icon-button') {
    // Position relative to the rememberme-icon-button (in the input area)
    const iconButton = document.querySelector('#rememberme-icon-button');
    if (iconButton) {
      const buttonRect = iconButton.getBoundingClientRect();

      // Determine if there's enough space above the button
      const spaceAbove = buttonRect.top;
      const viewportHeight = window.innerHeight;

      // Calculate position - for icon button, prefer to show ABOVE
      leftPosition = buttonRect.left - modalWidth + buttonRect.width;

      // Make sure modal doesn't go off-screen to the left
      leftPosition = Math.max(leftPosition, 10);

      // For icon button, show above if enough space, otherwise below
      if (spaceAbove >= modalHeight + 10) {
        // Place above
        topPosition = buttonRect.top - modalHeight - 10;
      } else {
        // Not enough space above, place below
        topPosition = buttonRect.bottom + 10;

        // Check if it's in the lower half of the screen
        if (buttonRect.bottom > viewportHeight / 2) {
          modalHeight = 300; // Reduced height
          memoriesPerPage = 2; // Show only 2 memories
        }
      }
    } else {
      // Fallback to input-based positioning
      positionRelativeToInput();
    }
  } else if (sourceButtonId === 'sync-button') {
    // Position relative to the sync button
    const syncButton = document.querySelector('#sync-button');
    if (syncButton) {
      const buttonRect = syncButton.getBoundingClientRect();
      const viewportHeight = window.innerHeight;

      // Position below the sync button by default
      leftPosition = buttonRect.left;
      topPosition = buttonRect.bottom + 10;

      // Check if it's in the lower half of the screen
      if (buttonRect.bottom > viewportHeight / 2) {
        modalHeight = 300; // Reduced height
        memoriesPerPage = 2; // Show only 2 memories
      }

      // Make sure modal doesn't go off-screen to the right
      leftPosition = Math.min(leftPosition, window.innerWidth - modalWidth - 10);
    } else {
      // Fallback to input-based positioning
      positionRelativeToInput();
    }
  } else {
    // Default positioning relative to the input field
    positionRelativeToInput();
  }

  // Helper function to position modal relative to input field
  function positionRelativeToInput() {
    const inputElement =
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('textarea');

    if (!inputElement) {
      console.error('Input element not found');
      return;
    }

    // Get the position and dimensions of the input field
    const inputRect = inputElement.getBoundingClientRect();

    // Determine if there's enough space below the input field
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - inputRect.bottom;

    // Position the modal aligned to the right of the input
    leftPosition = Math.max(inputRect.right - 20 - modalWidth, 10); // 20px offset from right edge

    // Decide whether to place modal above or below based on available space
    if (spaceBelow >= modalHeight) {
      // Place below the input
      topPosition = inputRect.bottom + 10;

      // Check if it's in the lower half of the screen
      if (inputRect.bottom > viewportHeight / 2) {
        modalHeight = 300; // Reduced height
        memoriesPerPage = 2; // Show only 2 memories
      }
    } else {
      // Place above the input if not enough space below
      topPosition = inputRect.top - modalHeight - 10;
    }
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
  modalOverlay.addEventListener('click', event => {
    // Only close if clicking directly on the overlay, not its children
    if (event.target === modalOverlay) {
      closeModal();
    }
  });

  // Create modal container with positioning
  const modalContainer = document.createElement('div');
  modalContainer.style.cssText = `
    background-color: #1C1C1E;
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
    border: 1px solid #27272A;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
  `;

  // Create modal header
  const modalHeader = document.createElement('div');
  modalHeader.style.cssText = `
    display: flex;
    align-items: center;
    padding: 10px 16px;
    justify-content: space-between;
    background-color: #232325;
    flex-shrink: 0;
    cursor: move;
    user-select: none;
  `;

  // Create header left section with just the logo
  const headerLeft = document.createElement('div');
  headerLeft.style.cssText = `
    display: flex;
    flex-direction: row;
    align-items: center;
  `;

  // Add Mem0 logo (updated to SVG)
  const logoImg = document.createElement('img');
  logoImg.src = chrome.runtime.getURL('icons/rememberme-logo-main.png');
  logoImg.style.cssText = `
    width: 26px;
    height: 26px;
    border-radius: 50%;
    margin-right: 8px;
  `;

  // Add "RememberMe" title
  const title = document.createElement('div');
  title.textContent = 'RememberMe';
  title.style.cssText = `
    font-size: 16px;
    font-weight: 600;
    color: white;
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
    background-color: white;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    color: black;
  `;
  addToPromptBtn.textContent = 'Add to Prompt';

  // Add arrow icon to button
  const arrowIcon = document.createElement('span');
  arrowIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;
  addToPromptBtn.appendChild(arrowIcon);

  // (Removed) LLM button – auto-rerank is now handled on modal open
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

  // Add drag functionality to modal header
  let isDragging = false;
  const dragOffset = { x: 0, y: 0 };

  modalHeader.addEventListener('mousedown', (e: MouseEvent) => {
    // Don't start dragging if clicking on buttons
    const target = e.target as HTMLElement;
    if (target?.closest('button')) {
      return;
    }

    isDragging = true;
    modalHeader.style.cursor = 'grabbing';

    const modalRect = modalContainer.getBoundingClientRect();
    dragOffset.x = e.clientX - modalRect.left;
    dragOffset.y = e.clientY - modalRect.top;

    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!isDragging) {
      return;
    }

    const newLeft = e.clientX - dragOffset.x;
    const newTop = e.clientY - dragOffset.y;

    // Constrain to viewport
    const maxLeft = window.innerWidth - modalWidth;
    const maxTop = window.innerHeight - modalHeight;

    const constrainedLeft = Math.max(0, Math.min(newLeft, maxLeft));
    const constrainedTop = Math.max(0, Math.min(newTop, maxTop));

    modalContainer.style.left = `${constrainedLeft}px`;
    modalContainer.style.top = `${constrainedTop}px`;

    // Store the dragged position
    draggedPosition = {
      left: constrainedLeft,
      top: constrainedTop,
    };

    e.preventDefault();
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      modalHeader.style.cursor = 'move';
    }
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
    memoriesCounter.textContent = `${memoryItems.length} Relevant Memories`;
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
    scrollbar-width: none;
    -ms-overflow-style: none;
  `;
  memoriesContent.style.cssText += '::-webkit-scrollbar { display: none; }';

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
        background-color: #27272A;
        border-radius: 8px;
        height: 72px;
        flex-shrink: 0;
        animation: pulse 1.5s infinite ease-in-out;
      `;

      const skeletonText = document.createElement('div');
      skeletonText.style.cssText = `
        background-color: #383838;
        border-radius: 4px;
        height: 14px;
        width: 85%;
        margin-bottom: 8px;
      `;

      const skeletonText2 = document.createElement('div');
      skeletonText2.style.cssText = `
        background-color: #383838;
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
        background-color: #383838;
      `;

      const skeletonButton2 = document.createElement('div');
      skeletonButton2.style.cssText = `
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: #383838;
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

  // Function to expand memory
  function expandMemory(
    memoryContainer: HTMLDivElement,
    memoryText: HTMLDivElement,
    contentWrapper: HTMLDivElement,
    removeButton: HTMLButtonElement,
    isExpanded: { value: boolean }
  ) {
    if (currentlyExpandedMemory && currentlyExpandedMemory !== memoryContainer) {
      currentlyExpandedMemory.dispatchEvent(new Event('collapse'));
    }

    isExpanded.value = true;
    memoryText.style.webkitLineClamp = 'unset';
    memoryText.style.height = 'auto';
    contentWrapper.style.overflowY = 'auto';
    contentWrapper.style.maxHeight = '240px'; // Limit height to prevent overflow
    contentWrapper.style.scrollbarWidth = 'none';
    // contentWrapper.style.msOverflowStyle is non-standard; omit to satisfy TS
    contentWrapper.style.cssText += '::-webkit-scrollbar { display: none; }';
    memoryContainer.style.backgroundColor = '#1C1C1E';
    memoryContainer.style.maxHeight = '300px'; // Allow expansion but within container
    memoryContainer.style.overflow = 'hidden';
    removeButton.style.display = 'flex';
    currentlyExpandedMemory = memoryContainer;

    // Scroll to make expanded memory visible if needed
    memoriesContent.scrollTop = memoryContainer.offsetTop - memoriesContent.offsetTop;
  }

  // Function to collapse memory
  function collapseMemory(
    memoryContainer: HTMLDivElement,
    memoryText: HTMLDivElement,
    contentWrapper: HTMLDivElement,
    removeButton: HTMLButtonElement,
    isExpanded: { value: boolean }
  ) {
    isExpanded.value = false;
    memoryText.style.webkitLineClamp = '2';
    memoryText.style.height = '42px';
    contentWrapper.style.overflowY = 'visible';
    memoryContainer.style.backgroundColor = '#27272A';
    memoryContainer.style.maxHeight = '72px';
    memoryContainer.style.overflow = 'hidden';
    removeButton.style.display = 'none';
    currentlyExpandedMemory = null;
  }

  // Function to show memories with adjusted count based on modal position
  function showMemories() {
    memoriesContent.innerHTML = '';

    if (isLoading) {
      createSkeletonItems();
      return;
    }

    if (memoryItems.length === 0) {
      showEmptyState();
      // Disable navigation buttons when there are no memories
      updateNavigationState(0, 0);
      return;
    }

    // Use the dynamically set memoriesPerPage value
    const memoriesToShow = Math.min(memoriesPerPage, memoryItems.length);

    // Calculate total pages and current page
    const totalPages = Math.ceil(memoryItems.length / memoriesToShow);
    const currentPage = Math.floor(currentMemoryIndex / memoriesToShow) + 1;

    // Update navigation buttons state
    updateNavigationState(currentPage, totalPages);

    for (let i = 0; i < memoriesToShow; i++) {
      const memoryIndex = currentMemoryIndex + i;
      if (memoryIndex >= memoryItems.length) {
        break;
      } // Stop if we've reached the end

      const memory = memoryItems[memoryIndex]!;

      // Skip memories that have been added already
      if (allMemoriesById.has(String(memory.id))) {
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
        background-color: #27272A;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.2s ease;
        min-height: 72px; 
        max-height: 72px; 
        overflow: hidden;
        flex-shrink: 0;
      `;

      const memoryText = document.createElement('div');
      memoryText.style.cssText = `
        font-size: 14px;
        line-height: 1.5;
        color: #D4D4D8;
        flex-grow: 1;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        transition: all 0.2s ease;
        height: 42px; /* Height for 2 lines of text */
      `;
      memoryText.textContent = memory.text || '';

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
        background:rgb(66, 66, 69);
        color:rgb(199, 199, 201);
        border-radius: 100%;
        transition: all 0.2s ease;
      `;

      addButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;

      // Add click handler for add button
      addButton.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        sendExtensionEvent('memory_injection', {
          provider: 'chatgpt',
          source: 'REMEMBERME_CHROME_EXTENSION',
          browser: getBrowser(),
          injected_all: false,
          memory_id: memory.id,
        });

        // Add this memory
        allMemoriesById.add(String(memory.id));
        allMemories.push(String(memory.text || ''));
        updateInputWithMemories();

        // Remove this memory from the list
        const index = memoryItems.findIndex((m: MemoryItem) => m.id === memory.id);
        if (index !== -1) {
          memoryItems.splice(index, 1);

          // Recalculate pagination after removing an item
          // If we're on a page that's now empty, go to previous page
          if (currentMemoryIndex > 0 && currentMemoryIndex >= memoryItems.length) {
            currentMemoryIndex = Math.max(0, currentMemoryIndex - memoriesPerPage);
          }

          memoriesCounter.textContent = `${memoryItems.length} Relevant Memories`;
          showMemories();
        }
      });

      // Menu button
      const menuButton = document.createElement('button');
      menuButton.style.cssText = `
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        color: #A1A1AA;
      `;
      menuButton.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="2"/>
        <circle cx="12" cy="5" r="2"/>
        <circle cx="12" cy="19" r="2"/>
      </svg>`;

      // Track expanded state using object to maintain reference
      const isExpanded = { value: false };

      // Create remove button (hidden by default)
      const removeButton = document.createElement('button');
      removeButton.style.cssText = `
        display: none;
        align-items: center;
        gap: 6px;
        background:rgb(66, 66, 69);
        color:rgb(199, 199, 201);
        border-radius: 8px;
        padding: 2px 4px;
        border: none;
        cursor: pointer;
        font-size: 13px;
        margin-top: 12px;
        width: fit-content;
      `;
      removeButton.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Remove
      `;

      // Create content wrapper for text and remove button
      const contentWrapper = document.createElement('div');
      contentWrapper.style.cssText = `
        display: flex;
        flex-direction: column;
        flex-grow: 1;
      `;
      contentWrapper.appendChild(memoryText);
      contentWrapper.appendChild(removeButton);

      memoryContainer.addEventListener('collapse', () => {
        collapseMemory(memoryContainer, memoryText, contentWrapper, removeButton, isExpanded);
      });

      menuButton.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        if (isExpanded.value) {
          collapseMemory(memoryContainer, memoryText, contentWrapper, removeButton, isExpanded);
        } else {
          expandMemory(memoryContainer, memoryText, contentWrapper, removeButton, isExpanded);
        }
      });

      // Add click handler for remove button
      removeButton.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        // Remove from memoryItems
        const index = memoryItems.findIndex((m: MemoryItem) => m.id === memory.id);
        if (index !== -1) {
          memoryItems.splice(index, 1);

          // Recalculate pagination after removing an item

          // If we're on the last page and it's now empty, go to previous page
          if (currentMemoryIndex > 0 && currentMemoryIndex >= memoryItems.length) {
            currentMemoryIndex = Math.max(0, currentMemoryIndex - memoriesPerPage);
          }

          memoriesCounter.textContent = `${memoryItems.length} Relevant Memories`;
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
        memoryContainer.style.backgroundColor = isExpanded.value ? '#18181B' : '#323232';
      });
      memoryContainer.addEventListener('mouseleave', () => {
        memoryContainer.style.backgroundColor = isExpanded.value ? '#1C1C1E' : '#27272A';
      });
    }

    // If after filtering for already added memories, there are no items to show,
    // check if we need to go to previous page
    if (memoriesContent.children.length === 0 && memoryItems.length > 0) {
      if (currentMemoryIndex > 0) {
        currentMemoryIndex = Math.max(0, currentMemoryIndex - memoriesPerPage);
        showMemories();
      } else {
        showEmptyState();
      }
    }
  }

  // Function to show empty state
  function showEmptyState(): void {
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
    emptyIcon.innerHTML = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#71717A" xmlns="http://www.w3.org/2000/svg">
      <path d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v10a2 2 0 01-2 2h-4M3 21h4a2 2 0 002-2v-4m-6 6V9m18 12a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    emptyIcon.style.marginBottom = '16px';

    const emptyText = document.createElement('div');
    emptyText.textContent = 'No relevant memories found';
    emptyText.style.cssText = `
      color: #71717A;
      font-size: 14px;
      font-weight: 500;
    `;

    emptyContainer.appendChild(emptyIcon);
    emptyContainer.appendChild(emptyText);
    memoriesContent.appendChild(emptyContainer);
  }

  // Update navigation button states
  function updateNavigationState(currentPage: number, totalPages: number): void {
    // If there are no memories or total pages is 0, disable both buttons
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
    <path d="M15 19l-7-7 7-7" stroke="#A1A1AA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  prevButton.style.cssText = `
    background: #27272A;
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
    <path d="M9 5l7 7-7 7" stroke="#A1A1AA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
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
    if (currentMemoryIndex + memoriesPerPage < memoryItems.length) {
      currentMemoryIndex = currentMemoryIndex + memoriesPerPage;
      showMemories();
    }
  });

  // Add hover effects
  [prevButton, nextButton].forEach(button => {
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) {
        button.style.backgroundColor = '#323232';
      }
    });
    button.addEventListener('mouseleave', () => {
      if (!button.disabled) {
        button.style.backgroundColor = '#27272A';
      }
    });
  });

  // Assemble modal
  headerLeft.appendChild(logoImg);
  headerLeft.appendChild(title);
  headerRight.appendChild(addToPromptBtn);
  headerRight.appendChild(settingsBtn);
  // No LLM button; auto-rerank happens below if enabled

  modalHeader.appendChild(headerLeft);
  modalHeader.appendChild(headerRight);

  contentSection.appendChild(memoriesCounter);
  contentSection.appendChild(memoriesContent);

  navigationSection.appendChild(prevButton);
  navigationSection.appendChild(nextButton);

  modalContainer.appendChild(modalHeader);
  modalContainer.appendChild(contentSection);
  modalContainer.appendChild(navigationSection);

  modalOverlay.appendChild(modalContainer);

  // Append to body
  document.body.appendChild(modalOverlay);

  // Show initial memories
  showMemories();

  // Function to close the modal
  function closeModal() {
    if (currentModalOverlay && document.body.contains(currentModalOverlay)) {
      document.body.removeChild(currentModalOverlay);
    }
    currentModalOverlay = null;
    memoryModalShown = false;
    // Reset dragged position when modal is explicitly closed
    draggedPosition = null;
  }

  // Update Add to Prompt button click handler
  addToPromptBtn.addEventListener('click', () => {
    // Only add memories that are not already added
    const newMemories = memoryItems
      .filter(memory => !allMemoriesById.has(String(memory.id)) && !memory.removed)
      .map(memory => {
        allMemoriesById.add(String(memory.id));
        return String(memory.text || '');
      });

    sendExtensionEvent('memory_injection', {
      provider: 'chatgpt',
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

    // Remove all added memories from the memoryItems list
    for (let i = memoryItems.length - 1; i >= 0; i--) {
      if (allMemoriesById.has(String(memoryItems[i]?.id))) {
        memoryItems.splice(i, 1);
      }
    }
  });
}

// Shared function to update the input field with all collected memories
function updateInputWithMemories(): void {
  const inputElement =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea');

  if (inputElement && allMemories.length > 0) {
    const headerText = REMEMBERME_PROMPTS.memory_header_text;
    
    // Check if header already exists (following Claude's pattern)
    const wrapper = document.getElementById('rememberme-wrapper');
    const headerExists = wrapper !== null || 
      (inputElement.innerHTML && inputElement.innerHTML.includes(headerText));

    if (headerExists) {
      // Header exists - extract existing memories using DOM queries (Claude's pattern)
      const existingMemories: string[] = [];
      
      if (wrapper) {
        // Extract from wrapper div (ChatGPT's structure)
        const memoryDivs = wrapper.querySelectorAll('div[data-rememberme-idx]');
        memoryDivs.forEach(div => {
          const text = div.textContent?.replace(/^-\s*/, '').trim();
          if (text) existingMemories.push(text);
        });
      } else {
        // Fallback: parse from innerHTML if wrapper not found (following Claude's pattern)
        const htmlContent = inputElement.innerHTML || '';
        if (htmlContent.includes(headerText)) {
          const htmlParts = htmlContent.split(headerText);
          if (htmlParts.length > 1) {
            const afterHeader = htmlParts[1];
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = afterHeader || '';
            
            // Find all divs or elements that contain memory content
            Array.from(tempDiv.querySelectorAll('div[data-rememberme-idx], div')).forEach(el => {
              const text = (el.textContent || '').trim();
              if (text.startsWith('-')) {
                const memText = text.substring(1).trim();
                if (memText && !existingMemories.includes(memText)) {
                  existingMemories.push(memText);
                }
              }
            });
          }
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

      // Rebuild memory section
      if (wrapper) {
        // Update wrapper content (keep header, update memories)
        let memoriesContent = '';
        combinedMemories.forEach((mem, idx) => {
          memoriesContent += `<div data-rememberme-idx="${idx}" style="user-select: text;">- ${mem}</div>`;
        });
        wrapper.innerHTML = REMEMBERME_PROMPTS.memory_header_html_strong + memoriesContent;
      } else {
        // Rebuild entire section if wrapper doesn't exist
        const baseContent = getContentWithoutMemories();
        let memoriesContent =
          '<div id="rememberme-wrapper" contenteditable="false" style="background-color: rgb(220, 252, 231); padding: 8px; border-radius: 4px; margin-top: 8px; margin-bottom: 8px;">';
        memoriesContent += REMEMBERME_PROMPTS.memory_header_html_strong;
        combinedMemories.forEach((mem, idx) => {
          memoriesContent += `<div data-rememberme-idx="${idx}" style="user-select: text;">- ${mem}</div>`;
        });
        memoriesContent += '</div>';
        
        if (inputElement.tagName.toLowerCase() === 'div') {
          inputElement.innerHTML = `${baseContent}<div><br></div>${memoriesContent}`;
        } else {
          (inputElement as HTMLTextAreaElement).value = `${baseContent}\n${memoriesContent}`;
        }
      }
    } else {
      // Header doesn't exist - add header + memories (existing logic)
      const baseContent = getContentWithoutMemories();

      // Create the memory wrapper with all collected memories
      let memoriesContent =
        '<div id="rememberme-wrapper" contenteditable="false" style="background-color: rgb(220, 252, 231); padding: 8px; border-radius: 4px; margin-top: 8px; margin-bottom: 8px;">';
      memoriesContent += REMEMBERME_PROMPTS.memory_header_html_strong;

      // Add all memories to the content
      allMemories.forEach((mem, idx) => {
        const safe = (mem || '').toString();
        memoriesContent += `<div data-rememberme-idx="${idx}" style="user-select: text;">- ${safe}</div>`;
      });
      memoriesContent += '</div>';

      // Add the final content to the input
      if (inputElement.tagName.toLowerCase() === 'div') {
        inputElement.innerHTML = `${baseContent}<div><br></div>${memoriesContent}`;
      } else {
        (inputElement as HTMLTextAreaElement).value = `${baseContent}\n${memoriesContent}`;
      }

      // Make only the wrapper non-editable; allow user to select/copy text inside
      try {
        const newWrapper = document.getElementById('rememberme-wrapper');
        if (newWrapper) {
          newWrapper.setAttribute('contenteditable', 'false');
          newWrapper.style.userSelect = 'text';
        }
      } catch {
        // Ignore errors when setting contenteditable
      }
    }

    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Function to get the content without any memory wrappers
function getContentWithoutMemories(message?: string): string {
  if (typeof message === 'string') {
    return message;
  }

  const inputElement =
    (document.querySelector('#prompt-textarea') as HTMLTextAreaElement | HTMLDivElement) ||
    (document.querySelector('div[contenteditable="true"]') as HTMLDivElement) ||
    (document.querySelector('textarea') as HTMLTextAreaElement);

  if (!inputElement) {
    return '';
  }

  let content =
    (inputElement as HTMLTextAreaElement)?.value ||
    inputElement.textContent ||
    (inputElement as HTMLDivElement).innerHTML;

  if (
    message &&
    (!content ||
      content.trim() ===
        '<p data-placeholder="Ask anything" class="placeholder"><br class="ProseMirror-trailingBreak"></p>')
  ) {
    content = message;
  }

  // Remove any memory wrappers
  content = content.replace(/<div id="rememberme-wrapper"[\s\S]*?<\/div>/g, '');

  // Remove any memory headers using shared prompts (HTML and plain variants)
  try {
    const REMEMBERME_PLAIN = REMEMBERME_PROMPTS.memory_header_plain_regex;
    const REMEMBERME_HTML = REMEMBERME_PROMPTS.memory_header_html_regex;
    content = content.replace(REMEMBERME_HTML, '');
    content = content.replace(REMEMBERME_PLAIN, '');
  } catch {
    // Ignore errors during re-initialization
  }

  // Clean up any leftover paragraph markers
  content = content.replace(/<p><br class="ProseMirror-trailingBreak"><\/p><p>$/g, '');

  // Replace <p> with nothing
  content = content.replace(/<p>[\s\S]*?<\/p>/g, '');

  return content.trim();
}

// Add an event listener for the send button to clear memories after sending
function addSendButtonListener(): void {
  const sendButton = document.querySelector('#composer-submit-button') as HTMLButtonElement;

  if (sendButton && !sendButton.dataset.remembermeListener) {
    sendButton.dataset.remembermeListener = 'true';
    sendButton.addEventListener('click', function () {
      // Capture and save memory asynchronously
      captureAndStoreMemory();

      // Clear all memories after sending
      setTimeout(() => {
        allMemories = [];
        allMemoriesById.clear();
      }, 100);
    });

    // Also handle Enter key press
    const inputElement =
      (document.querySelector('#prompt-textarea') as HTMLTextAreaElement | HTMLDivElement) ||
      (document.querySelector('div[contenteditable="true"]') as HTMLDivElement) ||
      (document.querySelector('textarea') as HTMLTextAreaElement);

    if (inputElement && !inputElement.dataset.remembermeKeyListener) {
      inputElement.dataset.remembermeKeyListener = 'true';
      (inputElement as HTMLElement).addEventListener('keydown', function (event: KeyboardEvent) {
        // Check if Enter was pressed without Shift (standard send behavior)

        inputValueCopy =
          (inputElement as HTMLTextAreaElement)?.value ||
          inputElement.textContent ||
          inputValueCopy;

        if (event.key === 'Enter' && !event.shiftKey) {
          // Capture and save memory asynchronously
          captureAndStoreMemory();

          // Clear all memories after sending
          setTimeout(() => {
            allMemories = [];
            allMemoriesById.clear();
          }, 100);
        }
      });
    }
  }
}

// Function to capture and store memory asynchronously
function captureAndStoreMemory(): void {
  // Get the message content
  // id is prompt-textarea
  const inputElement =
    (document.querySelector('#prompt-textarea') as HTMLTextAreaElement | HTMLDivElement) ||
    (document.querySelector('div[contenteditable="true"]') as HTMLDivElement) ||
    (document.querySelector('textarea') as HTMLTextAreaElement) ||
    (document.querySelector('textarea[data-virtualkeyboard="true"]') as HTMLTextAreaElement);

  if (!inputElement) {
    return;
  }

  let message = inputElement.textContent || (inputElement as HTMLTextAreaElement)?.value;
  if (!message || message.trim() === '') {
    message = inputValueCopy;
  }

  addMemoryToMem0(message, chatgptConfig, getLastMessages(2));
}

async function updateNotificationDot(): Promise<void> {
  const memoryEnabled = await getMemoryEnabledState();
  if (!memoryEnabled) {
    return;
  }

  const input =
    document.querySelector('#prompt-textarea') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('textarea');
  const host = document.getElementById('rememberme-icon-button'); // shadow host
  if (!input || !host) {
    setTimeout(updateNotificationDot, 1000);
    return;
  }

  const set = () => {
    const txt = input.textContent || input.value || '';
    host.setAttribute('data-has-text', txt.trim() ? '1' : '0');
  };

  const mo = new MutationObserver(set);
  mo.observe(input, { childList: true, characterData: true, subtree: true });
  input.addEventListener('input', set);
  input.addEventListener('keyup', set);
  input.addEventListener('focus', set);
  set();
}

// Modified function to handle Mem0 modal instead of direct injection
async function handleRememberMeModal(sourceButtonId: string | null = null): Promise<void> {
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

  const remembermeButton = document.querySelector('#rememberme-icon-button') as HTMLElement;

  let message = getInputValue();
  // If no message, show a popup and return
  if (!message || message.trim() === '') {
    if (remembermeButton) {
      showButtonPopup(remembermeButton as HTMLElement, 'Please enter some text first');
    }
    return;
  }

  try {
    const REMEMBERME_PLAIN = REMEMBERME_PROMPTS.memory_header_plain_regex;
    message = message.replace(REMEMBERME_PLAIN, '').trim();
  } catch {
    // Ignore errors during re-initialization
  }
  const endIndex = message.indexOf('</p>');
  if (endIndex !== -1) {
    message = message.slice(0, endIndex + 4);
  }

  if (isProcessingRememberMe) {
    return;
  }

  isProcessingRememberMe = true;

  // Show the loading modal immediately with the source button ID
  createMemoryModal([], true, sourceButtonId);

  try {
    const data = await new Promise<StorageData>(resolve => {
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
      provider: 'chatgpt',
      source: 'REMEMBERME_CHROME_EXTENSION',
      browser: getBrowser(),
    });

    const messages = getLastMessages(2);
    messages.push({ role: MessageRole.User, content: message });

    const optionalParams: OptionalApiParams = {};
    const orgId = getOrgId();
    const projectId = getProjectId();
    if (orgId) {
      optionalParams.org_id = orgId;
    }
    if (projectId) {
      optionalParams.project_id = projectId;
    }

    currentModalSourceButtonId = sourceButtonId;
    chatgptSearch.runImmediate(message);
  } catch (error) {
    console.error('Error:', error);
    // Still show the modal but with empty state if there was an error
    createMemoryModal([], false, sourceButtonId);
    throw error;
  } finally {
    isProcessingRememberMe = false;
  }
}

// Function to show a small popup message near the button
function showButtonPopup(button: HTMLElement, message: string): void {
  let host = button || document.getElementById('rememberme-icon-button');
  if (!host) {
    return;
  }
  let root = host.shadowRoot || host;
  // Remove any existing popups
  const existingPopup = root.querySelector('.rememberme-button-popup');
  if (existingPopup) {
    existingPopup.remove();
  }

  // Also hide any hover popover that might be showing
  const hoverPopover = document.querySelector('.mem0-button-popover') as HTMLElement;
  if (hoverPopover) {
    hoverPopover.style.opacity = '0';
    hoverPopover.style.display = 'none';
  }

  const popup = document.createElement('div');
  popup.className = 'rememberme-button-popup';

  popup.style.cssText = `
    position: absolute;
    top: -40px;
    left: 50%;
    transform: translateX(-50%);
    background-color: #1C1C1E;
    border: 1px solid #27272A;
    color: white;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 12px;
    white-space: nowrap;
    z-index: 10001;
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
  `;

  popup.textContent = message;

  // Create arrow
  const arrow = document.createElement('div');
  arrow.style.cssText = `
    position: absolute;
    bottom: -5px;
    left: 50%;
    transform: translateX(-50%) rotate(45deg);
    width: 10px;
    height: 10px;
    background-color: #1C1C1E;
    border-right: 1px solid #27272A;
    border-bottom: 1px solid #27272A;
  `;

  popup.appendChild(arrow);
  root.appendChild(popup);

  setTimeout(function () {
    if (popup.isConnected) {
      popup.remove();
    }
  }, 3000);

  // Position relative to button
  // button.style.position = 'relative';
  // button.appendChild(popup);

  // // Auto-remove after 3 seconds
  // setTimeout(() => {
  //   if (document.body.contains(popup)) {
  //     popup.remove();
  //   }
  // }, 3000);
}

// Safe no-op to prevent ReferenceError if auto-inject prefetch isn't defined elsewhere
function setupAutoInjectPrefetch() {
  try {
    // Intentionally left blank; legacy callers expect this to exist.
    // Inline hint handles lightweight suggestion awareness.
  } catch {
    // Ignore errors during re-initialization
  }
}

// REMOVED: Button injection code - using notification-only approach
(function () {
  return; // Disabled - notification-only mode
  // if (!REMEMBERME_UI || !REMEMBERME_UI.mountOnEditorFocus) {
  //   return;
  // }

  // 1) Try to mount immediately from cached anchor on page load (before focus)
  try {
    // Skip if already mounted (e.g., hot reload / rapid SPA replace)
    if (!document.getElementById('rememberme-icon-button')) {
      REMEMBERME_UI.resolveCachedAnchor(
        { learnKey: location.host + ':' + location.pathname },
        null,
        24 * 60 * 60 * 1000
      )
        .then(function (hit) {
          if (!hit || !hit.el) {
            return;
          }
          // Reuse the same render and placement as the focus-driven path
          let hs = REMEMBERME_UI.createShadowRootHost('rememberme-root');
          let host = hs.host,
            shadow = hs.shadow;
          host.id = 'rememberme-icon-button';
          let unplace = REMEMBERME_UI.applyPlacement({
            container: host,
            anchor: hit.el,
            placement: hit.placement || {
              strategy: 'inline',
              where: 'beforeend',
              inlineAlign: 'end',
            },
          });

          let style = document.createElement('style');
          style.textContent = `
          :host { position: relative; }
          .rememberme-btn { all: initial; cursor: pointer; display:inline-flex; align-items:center;
            justify-content:center; width:32px; height:32px; border-radius:50%; }
          .rememberme-btn img { width:18px; height:18px; border-radius:50%; }
          .dot { position:absolute; top:-2px; right:-2px; width:8px; height:8px;
            background:#80DDA2; border-radius:50%; border:2px solid #1C1C1E; display:none; }
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

          // Nudge to the left of mic if present in same anchor
          try {
            let mic =
              hit.el &&
              (hit.el.querySelector('button[aria-label="Dictate button"]') ||
                hit.el.querySelector('button[aria-label*="mic" i]') ||
                hit.el.querySelector('button[aria-label*="voice" i]'));
            if (mic && hit.el) {
              let child: Element | null = mic;
              while (child && child.parentElement !== hit.el) {
                child = child.parentElement;
              }
              if (child && child.parentElement === hit.el) {
                hit.el.insertBefore(host, child);
              }
            }
          } catch {
            // Ignore errors during re-initialization
          }

          btn.addEventListener('click', function () {
            handleRememberMeModal('rememberme-icon-button');
          });
          if (typeof updateNotificationDot === 'function') {
            setTimeout(updateNotificationDot, 0);
          }

          // If the anchor disappears, allow normal focus flow to re-mount
          const removal = new MutationObserver(function () {
            if (!document.contains(hit.el) || !document.contains(host)) {
              try {
                unplace();
              } catch {
                // Ignore errors during re-initialization
              }
              try {
                removal.disconnect();
              } catch {
                // Ignore errors during re-initialization
              }
            }
          });
          removal.observe(document.documentElement, { childList: true, subtree: true });
        })
        .catch(function () {
          // Ignore errors during re-initialization
        });
    }
  } catch {
    // Ignore errors during re-initialization
  }
  return; // Disabled - notification-only mode
  // REMOVED: Button injection - using notification-only approach
  // 2) Standard focus-driven mount
  // REMEMBERME_UI.mountOnEditorFocus({
  //   existingHostSelector: '#rememberme-icon-button',
  //   editorSelector:
//       typeof SITE_CONFIG !== 'undefined' &&
//       SITE_CONFIG.chatgpt &&
//       SITE_CONFIG.chatgpt.editorSelector
//         ? SITE_CONFIG.chatgpt.editorSelector
//         : 'textarea, [contenteditable="true"], input[type="text"]',
//     deriveAnchor:
//       typeof SITE_CONFIG !== 'undefined' &&
//       SITE_CONFIG.chatgpt &&
//       typeof SITE_CONFIG.chatgpt.deriveAnchor === 'function'
//         ? SITE_CONFIG.chatgpt.deriveAnchor
//         : function (editor) {
//             return editor.closest('form') || editor.parentElement;
//           },
//     placement:
//       typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.chatgpt && SITE_CONFIG.chatgpt.placement
//         ? SITE_CONFIG.chatgpt.placement
//         : { strategy: 'inline', where: 'beforeend', inlineAlign: 'end' },
//     render: function (shadow: ShadowRoot, host: HTMLElement, anchor: Element | null) {
//       host.id = 'rememberme-icon-button'; // existing code relies on this
//       let style = document.createElement('style');
//       style.textContent = `
//         :host { position: relative; }
//         .rememberme-btn { all: initial; cursor: pointer; display:inline-flex; align-items:center;
//           justify-content:center; width:32px; height:32px; border-radius:50%; }
//         .rememberme-btn img { width:18px; height:18px; border-radius:50%; }
//         .dot { position:absolute; top:-2px; right:-2px; width:8px; height:8px;
//           background:#80DDA2; border-radius:50%; border:2px solid #1C1C1E; display:none; }
//         :host([data-has-text="1"]) .dot { display:block; }
//       `;
//       let btn = document.createElement('button');
//       btn.className = 'rememberme-btn';
//       let img = document.createElement('img');
//       img.src = chrome.runtime.getURL('icons/rememberme-icon.png');
//       let dot = document.createElement('div');
//       dot.className = 'dot';
//       btn.appendChild(img);
//       shadow.append(style, btn, dot);
// 
//       try {
//         let cfg =
//           typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.chatgpt ? SITE_CONFIG.chatgpt : null;
//         let mic = null;
//         if (cfg && Array.isArray(cfg.adjacentTargets)) {
//           for (let i = 0; i < cfg.adjacentTargets.length; i++) {
//             let sel = cfg.adjacentTargets[i];
//             if (sel) {
//               mic = anchor && anchor.querySelector(sel);
//               if (mic) {
//                 break;
//               }
//             }
//           }
//         }
//         if (mic && anchor) {
//           let child: Element | null = mic;
//           while (child && child.parentElement !== anchor) {
//             child = child.parentElement;
//           }
//           if (child && child.parentElement === anchor) {
//             anchor.insertBefore(host, child);
//           }
//           host.style.marginRight = ''; // rely on container gap
//           host.style.marginLeft = '';
//         } else {
//           host.style.marginLeft = '4px'; // mild fallback spacing
//         }
//       } catch (_e) {
//         // Ignore errors during re-initialization
//       }
// 
//       btn.addEventListener('click', function () {
//         handleRememberMeModal('rememberme-icon-button');
//       });
// 
//       if (typeof updateNotificationDot === 'function') {
//         setTimeout(updateNotificationDot, 0);
//       }
//     },
//     // Optional safety net if deriveAnchor fails
//     fallback: function () {
//       let cfg =
//         typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.chatgpt ? SITE_CONFIG.chatgpt : null;
//       REMEMBERME_UI.mountResilient({
//         anchors: [
//           {
//             find: function () {
//               let sel =
//                 (cfg && cfg.editorSelector) ||
//                 'textarea, [contenteditable="true"], input[type="text"]';
//               let ed = document.querySelector(sel);
//               if (!ed) {
//                 return null;
//               }
//               try {
//                 return cfg && typeof cfg.deriveAnchor === 'function'
//                   ? cfg.deriveAnchor(ed)
//                   : ed.closest('form') || ed.parentElement;
//               } catch (_) {
//                 return ed.closest('form') || ed.parentElement;
//               }
//             },
//           },
//         ],
//         placement: (cfg && cfg.placement) || {
//           strategy: 'inline',
//           where: 'beforeend',
//           inlineAlign: 'end',
//         },
//         enableFloatingFallback: true,
//         render: function (shadow: ShadowRoot, host: HTMLElement, anchor: Element | null) {
//           host.id = 'rememberme-icon-button'; // host is the shadow root container
//           let style = document.createElement('style');
//           style.textContent = `
//             :host { position: relative; }
//             .rememberme-btn { all: initial; cursor: pointer; display:inline-flex; align-items:center;
//               justify-content:center; width:32px; height:32px; border-radius:50%; }
//             .rememberme-btn img { width:18px; height:18px; border-radius:50%; }
//             .dot { position:absolute; top:-2px; right:-2px; width:8px; height:8px;
//               background:#80DDA2; border-radius:50%; border:2px solid #1C1C1E; display:none; }
//             :host([data-has-text="1"]) .dot { display:block; }
//           `;
//           let btn = document.createElement('button');
//           btn.className = 'rememberme-btn';
//           let img = document.createElement('img');
//           img.src = chrome.runtime.getURL('icons/rememberme-icon.png');
//           let dot = document.createElement('div');
//           dot.className = 'dot';
//           btn.appendChild(img);
//           shadow.append(style, btn, dot);
//           btn.addEventListener('click', function () {
//             handleRememberMeModal('rememberme-icon-button');
//           });
// 
//           // Move host to the left of the mic inside the same toolbar container
//           try {
//             let cfg =
//               typeof SITE_CONFIG !== 'undefined' && SITE_CONFIG.chatgpt
//                 ? SITE_CONFIG.chatgpt
//                 : null;
//             let mic = null;
//             if (cfg && Array.isArray(cfg.adjacentTargets)) {
//               for (let i = 0; i < cfg.adjacentTargets.length; i++) {
//                 let sel = cfg.adjacentTargets[i];
//                 if (sel) {
//                   mic = anchor && anchor.querySelector(sel);
//                   if (mic) {
//                     break;
//                   }
//                 }
//               }
//             } else {
//               mic =
//                 anchor &&
//                 (anchor.querySelector('button[aria-label="Dictate button"]') ||
//                   anchor.querySelector('button[aria-label*="mic" i]') ||
//                   anchor.querySelector('button[aria-label*="voice" i]'));
//             }
//             if (mic && anchor) {
//               let child: Element | null = mic;
//               while (child && child.parentElement !== anchor) {
//                 child = child.parentElement;
//               }
//               if (child && child.parentElement === anchor) {
//                 anchor.insertBefore(host, child);
//               }
//               host.style.marginRight = ''; // rely on container gap
//               host.style.marginLeft = '';
//             } else {
//               host.style.marginLeft = '4px'; // mild fallback spacing
//             }
//           } catch (_e) {
//             // Ignore errors during re-initialization
//           }
// 
//           if (typeof updateNotificationDot === 'function') {
//             setTimeout(updateNotificationDot, 0);
//           }
//         },
//       });
//     },
//     persistCache: true,
//     cacheTtlMs: 24 * 60 * 60 * 1000,
//   });
})();

function getLastMessages(count: number): Array<{ role: MessageRole; content: string }> {
  const messageContainer = document.querySelector('.flex.flex-col.text-sm.md\\:pb-9');
  if (!messageContainer) {
    return [];
  }

  const messageElements = Array.from(messageContainer.children).reverse();
  const messages: Array<{ role: MessageRole; content: string }> = [];

  for (const element of messageElements) {
    if (messages.length >= count) {
      break;
    }

    const userElement = element.querySelector('[data-message-author-role="user"]');
    const assistantElement = element.querySelector('[data-message-author-role="assistant"]');

    if (userElement) {
      const content = userElement.querySelector('.whitespace-pre-wrap')?.textContent?.trim() || '';
      messages.unshift({ role: MessageRole.User, content });
    } else if (assistantElement) {
      const content = assistantElement.querySelector('.markdown')?.textContent?.trim() || '';
      messages.unshift({ role: MessageRole.Assistant, content });
    }
  }

  return messages;
}

function getInputValue(): string {
  const inputElement =
    (document.querySelector('#prompt-textarea') as HTMLTextAreaElement | HTMLDivElement) ||
    (document.querySelector('div[contenteditable="true"]') as HTMLDivElement) ||
    (document.querySelector('textarea') as HTMLTextAreaElement);

  return inputElement
    ? inputElement.textContent || (inputElement as HTMLTextAreaElement)?.value || ''
    : '';
}

const hookBackgroundSearchTyping = setupBackgroundSearchHook(chatgptConfig, chatgptSearch);

function addSyncButton(): void {
  const buttonContainer = document.querySelector('div.mt-5.flex.justify-end');
  if (buttonContainer) {
    let syncButton = document.querySelector('#sync-button') as HTMLButtonElement;

    // If the syncButton does not exist, create it
    if (!syncButton) {
      syncButton = document.createElement('button');
      syncButton.id = 'sync-button';
      syncButton.className = 'btn relative btn-neutral mr-2';
      syncButton.style.color = 'rgb(213, 213, 213)';
      syncButton.style.backgroundColor = 'transparent';
      syncButton.innerHTML =
        '<div id="sync-button-content" class="flex items-center justify-center font-semibold">Sync Memory</div>';
      syncButton.style.border = '1px solid rgb(213, 213, 213)';
      syncButton.style.fontSize = '12px';
      syncButton.style.fontWeight = '500';
      // add margin right to syncButton
      syncButton.style.marginRight = '8px';

      const syncIcon = document.createElement('img');
      syncIcon.src = chrome.runtime.getURL('icons/rememberme-logo-main.png');
      syncIcon.style.width = '16px';
      syncIcon.style.height = '16px';
      syncIcon.style.marginRight = '8px';

      syncButton.prepend(syncIcon);

      syncButton.addEventListener('click', handleSyncClick);

      syncButton.addEventListener('mouseenter', () => {
        if (!syncButton!.disabled) {
          syncButton!.style.filter = 'opacity(0.7)';
        }
      });
      syncButton.addEventListener('mouseleave', () => {
        if (!syncButton!.disabled) {
          syncButton!.style.filter = 'opacity(1)';
        }
      });
    }

    if (!buttonContainer.contains(syncButton)) {
      buttonContainer.insertBefore(syncButton, buttonContainer.firstChild);
    }

    // Update sync button state
    const updateSyncButtonState = (): void => {
      // Define when the sync button should be enabled or disabled
      (syncButton as HTMLButtonElement).disabled = false; // For example, always enabled
      // Update opacity or pointer events if needed
      if ((syncButton as HTMLButtonElement).disabled) {
        (syncButton as HTMLButtonElement).style.opacity = '0.5';
        (syncButton as HTMLButtonElement).style.pointerEvents = 'none';
      } else {
        (syncButton as HTMLButtonElement).style.opacity = '1';
        (syncButton as HTMLButtonElement).style.pointerEvents = 'auto';
      }
    };

    updateSyncButtonState();
  } else {
    // If resetMemoriesButton or specificTable is not found, remove syncButton from DOM
    const existingSyncButton = document.querySelector('#sync-button');
    if (existingSyncButton && existingSyncButton.parentNode) {
      existingSyncButton.parentNode.removeChild(existingSyncButton);
    }
  }
}

/**
 * Extract conversation ID from ChatGPT URL
 */
function getConversationIdFromUrl(url: string): string | null {
  const match = url.match(/\/c\/([a-f0-9-]+)/);
  const conversationId = match && match[1] ? match[1] : null;
  
  if (conversationId) {
    console.log('[ChatGPT Auto-Sync] Extracted conversation ID from URL:', conversationId);
  } else {
    console.log('[ChatGPT Auto-Sync] No conversation ID found in URL:', url);
  }
  
  return conversationId;
}

/**
 * Extract only user messages from currently open conversation
 * We only extract user messages because RememberMe is designed to remember things about the user,
 * not ChatGPT's responses (which are AI-generated content, not user information)
 */
function extractCurrentConversationMessages(): Array<{ role: MessageRole; content: string }> {
  console.log('[ChatGPT Auto-Sync] Starting user message extraction...');
  const messages: Array<{ role: MessageRole; content: string }> = [];
  
  // Direct search for user messages only (most reliable approach)
  const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
  
  if (userMessages.length === 0) {
    console.warn('[ChatGPT Auto-Sync] No user messages found');
    console.log('[ChatGPT Auto-Sync] Debug info:', {
      url: window.location.href,
      hasUserMessages: document.querySelectorAll('[data-message-author-role="user"]').length,
      hasAnyMessages: document.querySelectorAll('[data-message-author-role]').length,
      mainExists: !!document.querySelector('main')
    });
    return messages;
  }
  
  console.log(`[ChatGPT Auto-Sync] Found ${userMessages.length} user messages`);
  
  userMessages.forEach((element, index) => {
    // Try multiple content selectors for robustness
    const content = element.querySelector('.whitespace-pre-wrap')?.textContent?.trim() || 
                   element.textContent?.trim() || '';
    
    if (content) {
      messages.push({ role: MessageRole.User, content });
    } else {
      console.warn(`[ChatGPT Auto-Sync] User message ${index} has empty content`);
    }
  });
  
  console.log(`[ChatGPT Auto-Sync] Extracted ${messages.length} user messages`);
  return messages;
}

/**
 * Check if conversation is already synced
 */
async function isConversationSynced(conversationId: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['chatgpt_synced_conversations'], (result) => {
      const synced = new Set(result.chatgpt_synced_conversations || []);
      const isSynced = synced.has(conversationId);
      
      console.log('[ChatGPT Auto-Sync] Checking sync status:', {
        conversationId,
        isSynced,
        totalSyncedConversations: synced.size,
        syncedIds: Array.from(synced)
      });
      
      resolve(isSynced);
    });
  });
}

/**
 * Mark conversation as synced
 */
async function markConversationSynced(conversationId: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(['chatgpt_synced_conversations'], (result) => {
      const synced = new Set(result.chatgpt_synced_conversations || []);
      const beforeCount = synced.size;
      synced.add(conversationId);
      const afterCount = synced.size;
      
      chrome.storage.local.set({ 
        chatgpt_synced_conversations: Array.from(synced) 
      }, () => {
        console.log('[ChatGPT Auto-Sync] Marked conversation as synced:', {
          conversationId,
          beforeCount,
          afterCount,
          wasNew: afterCount > beforeCount
        });
        resolve();
      });
    });
  });
}

/**
 * Auto-sync conversation on navigation
 */
async function autoSyncConversation(conversationId: string): Promise<void> {
  console.log('[ChatGPT Auto-Sync] Starting auto-sync for conversation:', conversationId);
  
  const memoryEnabled = await getMemoryEnabledState();
  if (!memoryEnabled) {
    console.log('[ChatGPT Auto-Sync] Memory is disabled, skipping sync');
    return;
  }
  
  console.log('[ChatGPT Auto-Sync] Memory is enabled, checking sync status...');
  const alreadySynced = await isConversationSynced(conversationId);
  if (alreadySynced) {
    console.log(`[ChatGPT Auto-Sync] Conversation ${conversationId} already synced, skipping`);
    return;
  }
  
  console.log('[ChatGPT Auto-Sync] Conversation not synced yet, waiting for DOM to load...');
  
  // Retry logic: Try multiple times with increasing delays
  const maxRetries = 3;
  const retryDelays = [2000, 3000, 5000]; // 2s, 3s, 5s
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    
    console.log(`[ChatGPT Auto-Sync] Attempt ${attempt + 1}/${maxRetries}: Extracting messages...`);
    const messages = extractCurrentConversationMessages();
    
    if (messages.length > 0) {
      console.log(`[ChatGPT Auto-Sync] Successfully found ${messages.length} messages on attempt ${attempt + 1}`);
      
      // Continue with sync process
      console.log('[ChatGPT Auto-Sync] Checking for authentication credentials...');
      const items = await new Promise<any>((resolve) => {
        chrome.storage.sync.get([
          StorageKey.SUPABASE_ACCESS_TOKEN,
          StorageKey.SUPABASE_USER_ID,
        ], resolve);
      });
      
      const hasToken = !!items[StorageKey.SUPABASE_ACCESS_TOKEN];
      const hasUserId = !!items[StorageKey.SUPABASE_USER_ID];
      
      console.log('[ChatGPT Auto-Sync] Credentials check:', {
        hasToken,
        hasUserId,
        userId: hasUserId ? items[StorageKey.SUPABASE_USER_ID] : 'missing'
      });
      
      if (!hasToken || !hasUserId) {
        console.warn('[ChatGPT Auto-Sync] Missing credentials, cannot sync. Token:', hasToken, 'UserId:', hasUserId);
        return;
      }
      
      console.log('[ChatGPT Auto-Sync] Sending messages to Mem0 API...');
      try {
        await sendMemoriesToMem0(messages);
        console.log('[ChatGPT Auto-Sync] Successfully sent messages to Mem0');
        
        await markConversationSynced(conversationId);
        console.log(`[ChatGPT Auto-Sync] ✅ Successfully auto-synced ${messages.length} messages from conversation ${conversationId}`);
        return;
      } catch (error) {
        console.error('[ChatGPT Auto-Sync] ❌ Error during sync:', {
          error,
          errorMessage: error instanceof Error ? error.message : String(error),
          conversationId,
          messageCount: messages.length
        });
        return;
      }
    }
    
    if (attempt < maxRetries - 1) {
      const nextDelay = retryDelays[attempt + 1] ?? 0;
      if (nextDelay > 0) {
        console.log(`[ChatGPT Auto-Sync] No messages found, retrying in ${nextDelay / 1000}s...`);
      }
    }
  }
  
  console.warn('[ChatGPT Auto-Sync] No messages found after all retries, conversation may be empty or DOM structure changed');
}


function handleSyncClick(): void {
  getMemoryEnabledState().then(memoryEnabled => {
    if (!memoryEnabled) {
      const btn = document.querySelector('#sync-button') as HTMLElement;
      if (btn) {
        showSyncPopup(btn, 'Memory is disabled');
      }
      return;
    }

    const table = document.querySelector('table.w-full.border-separate.border-spacing-0');
    const syncButton = document.querySelector('#sync-button') as HTMLButtonElement;

    if (table && syncButton) {
      const rows = table.querySelectorAll('tbody tr');
      const memories: Array<{ role: string; content: string }> = [];

      // Change sync button state to loading
      setSyncButtonLoadingState(true);

      let syncedCount = 0;
      const totalCount = rows.length;

      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length >= 1 && cells[0]) {
          const content =
            cells[0].querySelector('div.whitespace-pre-wrap')?.textContent?.trim() || '';

          const memory = {
            role: MessageRole.User,
            content: `Remember this about me: ${content}`,
          };

          memories.push(memory);

          sendMemoryToMem0(memory, false)
            .then(() => {
              syncedCount++;
              if (syncedCount === totalCount) {
                showSyncPopup(syncButton, `${syncedCount} memories synced`);
                setSyncButtonLoadingState(false);
                // Open the modal with memories after syncing
                // handleRememberMeModal('sync-button');
              }
            })
            .catch(() => {
              if (syncedCount === totalCount) {
                showSyncPopup(syncButton, `${syncedCount}/${totalCount} memories synced`);
                setSyncButtonLoadingState(false);
                // Open the modal with memories after syncing
                // handleRememberMeModal('sync-button');
              }
            });
        }
      });

      if (memories.length > 0) {
        sendMemoriesToMem0(memories)
          .then(() => {
            if (syncButton) {
              showSyncPopup(syncButton, `${memories.length} memories synced`);
            }
            setSyncButtonLoadingState(false);
            // Open the modal with memories after syncing
            handleRememberMeModal('sync-button');
          })
          .catch(error => {
            console.error('Error syncing memories:', error);
            if (syncButton) {
              showSyncPopup(syncButton, 'Error syncing memories');
            }
            setSyncButtonLoadingState(false);
            // Open the modal even if there was an error
            handleRememberMeModal('sync-button');
          });
      } else {
        if (syncButton) {
          showSyncPopup(syncButton, 'No memories to sync');
        }
        setSyncButtonLoadingState(false);
      }
    } else {
      console.error('Table or Sync button not found');
    }
  });
}


// New function to send memories in batch
function sendMemoriesToMem0(memories: Array<{ role: string; content: string }>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.sync.get(
      [
        StorageKey.SUPABASE_ACCESS_TOKEN,
        StorageKey.SUPABASE_USER_ID,
      ],
      function (items) {
        const supabaseAccessToken = items[StorageKey.SUPABASE_ACCESS_TOKEN];
        const supabaseUserId = items[StorageKey.SUPABASE_USER_ID];
        
        if (!supabaseAccessToken || !supabaseUserId) {
          reject('Supabase authentication required');
          return;
        }

          const optionalParams: OptionalApiParams = {};
        const orgId = getOrgId();
        const projectId = getProjectId();
        if (orgId) {
          optionalParams.org_id = orgId;
          }
        if (projectId) {
          optionalParams.project_id = projectId;
          }

          const apiKey = getApiKey();
          if (!apiKey) {
            console.error('[ChatGPT] VITE_MEM0_API_KEY not configured');
            return;
          }
          const authHeader = `Token ${apiKey}`;

          fetch('https://api.mem0.ai/v1/memories/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            Authorization: authHeader,
            },
            body: JSON.stringify({
              messages: memories,
            user_id: supabaseUserId,
              infer: true,
              metadata: {
                provider: 'ChatGPT',
              },
            version: 'v2',
              ...optionalParams,
            }),
          })
            .then(response => {
              if (!response.ok) {
                reject(`Failed to add memories: ${response.status}`);
              } else {
                resolve();
              }
            })
            .catch(error => reject(`Error sending memories to Mem0: ${error}`));
      }
    );
  });
}

function setSyncButtonLoadingState(isLoading: boolean): void {
  const syncButton = document.querySelector('#sync-button') as HTMLButtonElement;
  const syncButtonContent = document.querySelector('#sync-button-content') as HTMLElement;
  if (syncButton) {
    if (isLoading) {
      syncButton.disabled = true;
      syncButton.style.cursor = 'wait';
      document.body.style.cursor = 'wait';
      syncButton.style.opacity = '0.7';
      if (syncButtonContent) {
        syncButtonContent.textContent = 'Syncing...';
      }
    } else {
      syncButton.disabled = false;
      syncButton.style.cursor = 'pointer';
      syncButton.style.opacity = '1';
      document.body.style.cursor = 'default';
      if (syncButtonContent) {
        syncButtonContent.textContent = 'Sync Memory';
      }
    }
  }
}

function showSyncPopup(button: HTMLElement, message: string): void {
  const popup = document.createElement('div');

  // Create and add the (i) icon
  const infoIcon = document.createElement('span');
  infoIcon.textContent = 'ⓘ ';
  infoIcon.style.marginRight = '3px';

  popup.appendChild(infoIcon);
  popup.appendChild(document.createTextNode(message));

  popup.style.cssText = `
        position: absolute;
        top: 50%;
        left: -160px;
        transform: translateY(-50%);
        background-color: #171717;
        color: white;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 12px;
        white-space: nowrap;
        z-index: 1000;
    `;

  button.style.position = 'relative';
  button.appendChild(popup);

  setTimeout(() => {
    popup.remove();
  }, 3000);
}

function sendMemoryToMem0(
  memory: { role: string; content: string },
  infer: boolean = true
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    chrome.storage.sync.get(
      [
        StorageKey.SUPABASE_ACCESS_TOKEN,
        StorageKey.SUPABASE_USER_ID,
      ],
      function (items) {
        const supabaseAccessToken = items[StorageKey.SUPABASE_ACCESS_TOKEN];
        const supabaseUserId = items[StorageKey.SUPABASE_USER_ID];
        
        if (!supabaseAccessToken || !supabaseUserId) {
          reject('Supabase authentication required');
          return;
        }

          const optionalParams: OptionalApiParams = {};
        const orgId = getOrgId();
        const projectId = getProjectId();
        if (orgId) {
          optionalParams.org_id = orgId;
          }
        if (projectId) {
          optionalParams.project_id = projectId;
          }

          const apiKey = getApiKey();
          if (!apiKey) {
            console.error('[ChatGPT] VITE_MEM0_API_KEY not configured');
            return;
          }
          const authHeader = `Token ${apiKey}`;

          fetch('https://api.mem0.ai/v1/memories/', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            Authorization: authHeader,
            },
            body: JSON.stringify({
              messages: [{ content: memory.content, role: MessageRole.User }],
            user_id: supabaseUserId,
              infer: infer,
              metadata: {
                provider: 'ChatGPT',
              },
            version: 'v2',
              ...optionalParams,
            }),
          })
            .then(response => {
              if (!response.ok) {
                reject(`Failed to add memory: ${response.status}`);
              } else {
                resolve();
              }
            })
            .catch(error => reject(`Error sending memory to Mem0: ${error}`));
      }
    );
  });
}

// Add this new function to get the memory_enabled state
function getMemoryEnabledState(): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    chrome.storage.sync.get([StorageKey.MEMORY_ENABLED], function (result) {
      resolve(result.memory_enabled !== false); // Default to true if not set
    });
  });
}

// Returns whether auto-inject is enabled (default: false if not present)
// (auto-inject helpers removed)

// Update the initialization function to add the Mem0 icon button but not intercept Enter key
function initializeMem0Integration(): void {
  document.addEventListener('DOMContentLoaded', () => {
    addSyncButton();
    // (async () => await addRememberMeIconButton())();
    addSendButtonListener();
    // (async () => await updateNotificationDot())();
    hookBackgroundSearchTyping();
    setupAutoInjectPrefetch();
    
    // Check auth on page load
    setTimeout(() => {
      checkAuthOnPageLoad();
    }, 1000);
  });

  document.addEventListener('keydown', function (event) {
    if (event.ctrlKey && event.key === 'm') {
      event.preventDefault();
      (async () => {
        await handleRememberMeModal('rememberme-icon-button');
      })();
    }
  });

  // Remove global Enter interception previously added for auto-inject

  observer = new MutationObserver(() => {
    addSyncButton();
    // (async () => await addRememberMeIconButton())();
    addSendButtonListener();
    // (async () => await updateNotificationDot())();
    let inputElement: HTMLElement | null = null;
    for (const selector of chatgptConfig.inputSelectors) {
      inputElement = document.querySelector(selector);
      if (inputElement) break;
    }
    if (inputElement && !(inputElement as any).dataset[chatgptConfig.backgroundSearchHookAttribute]) {
    hookBackgroundSearchTyping();
    }
    setupAutoInjectPrefetch();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Add a MutationObserver to watch for changes in the DOM but don't intercept Enter key
  const observerForUI = new MutationObserver(() => {
    // (async () => await addRememberMeIconButton())();
    addSendButtonListener();
    // (async () => await updateNotificationDot())();
    let inputElement: HTMLElement | null = null;
    for (const selector of chatgptConfig.inputSelectors) {
      inputElement = document.querySelector(selector);
      if (inputElement) break;
    }
    if (inputElement && !(inputElement as any).dataset[chatgptConfig.backgroundSearchHookAttribute]) {
    hookBackgroundSearchTyping();
    }
    setupAutoInjectPrefetch();
  });

  observerForUI.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// (global auto-inject interceptors removed)

// Function to show login popup
function showLoginPopup() {
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
    background-color: #1C1C1E;
    border-radius: 12px;
    width: 320px;
    padding: 24px;
    color: white;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  // Close button
  const closeButton = document.createElement('button');
  closeButton.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    background: none;
    border: none;
    color: #A1A1AA;
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

  const logo = document.createElement('img');
  logo.src = chrome.runtime.getURL('icons/rememberme-logo-main.png');
  logo.style.cssText = `
    width: 24px;
    height: 24px;
    border-radius: 50%;
    margin-right: 12px;
  `;

  const logoDark = document.createElement('img');
  logoDark.src = chrome.runtime.getURL('icons/rememberme-icon.png');
  logoDark.style.cssText = `
    width: 24px;
    height: 24px;
    border-radius: 50%;
    margin-right: 12px;
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
  message.textContent =
    'Please sign in to access your memories and personalize your conversations!';
  message.style.cssText = `
    margin-bottom: 24px;
    color: #D4D4D8;
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
    background-color: white;
    color: black;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 0.2s;
  `;

  // Add text in span for better centering
  const signInText = document.createElement('span');
  signInText.textContent = 'Sign in with Mem0';

  signInButton.appendChild(logoDark);
  signInButton.appendChild(signInText);

  signInButton.addEventListener('mouseenter', () => {
    signInButton.style.backgroundColor = '#f5f5f5';
  });

  signInButton.addEventListener('mouseleave', () => {
    signInButton.style.backgroundColor = 'white';
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
  popupOverlay.addEventListener('click', e => {
    if (e.target === popupOverlay) {
      document.body.removeChild(popupOverlay);
    }
  });

  // Add to body
  document.body.appendChild(popupOverlay);
}


initializeMem0Integration();
// --- SPA navigation handling and extension context guard (mirrors Claude) ---
let chatgptExtensionContextValid = true;
let chatgptCurrentUrl = window.location.href;

// Check current conversation on initial page load (not just on navigation)
setTimeout(() => {
  const conversationId = getConversationIdFromUrl(window.location.href);
  if (conversationId) {
    console.log('[ChatGPT Auto-Sync] Initial page load detected, checking conversation:', conversationId);
    autoSyncConversation(conversationId).catch(error => {
      console.error('[ChatGPT Auto-Sync] ❌ Error in initial auto-sync:', {
        error,
        errorMessage: error instanceof Error ? error.message : String(error),
        conversationId
      });
    });
  }
}, 2000); // Wait 2 seconds for ChatGPT to load

function chatgptCheckExtensionContext() {
  try {
    // chrome.runtime may throw if context invalidated
    // Using optional chaining to avoid ReferenceError
    // lastError exists only after an API call; treat presence of runtime as validity
    const isValid = !!(chrome && chrome.runtime);
    if (chatgptExtensionContextValid && !isValid) {
      chatgptExtensionContextValid = false;
    }
    return isValid;
  } catch {
    chatgptExtensionContextValid = false;
    return false;
  }
}

function chatgptDetectNavigation() {
  const newUrl = window.location.href;
  if (newUrl !== chatgptCurrentUrl) {
    console.log('[ChatGPT Auto-Sync] Navigation detected:', {
      from: chatgptCurrentUrl,
      to: newUrl
    });
    
    chatgptCurrentUrl = newUrl;

    const conversationId = getConversationIdFromUrl(newUrl);

    // Re-initialize UI after small delay for DOM to settle
    setTimeout(() => {
      try {
        addSendButtonListener();
        
        // Auto-sync conversation if we're on a conversation page
        if (conversationId) {
          console.log('[ChatGPT Auto-Sync] Conversation ID found, initiating auto-sync...');
          autoSyncConversation(conversationId).catch(error => {
            console.error('[ChatGPT Auto-Sync] ❌ Error in auto-sync:', {
              error,
              errorMessage: error instanceof Error ? error.message : String(error),
              conversationId
            });
          });
        } else {
          console.log('[ChatGPT Auto-Sync] No conversation ID found, not a conversation page');
        }
        
        // Check auth after navigation
        setTimeout(() => {
          checkAuthOnPageLoad();
        }, 1000);
      } catch (error) {
        console.error('[ChatGPT Auto-Sync] Error during navigation setup:', error);
      }
    }, 300);
  }
}

// Poll for SPA navigations and context validity
setInterval(() => {
  chatgptCheckExtensionContext();
  chatgptDetectNavigation();
}, 1000);

// Hook browser history navigation
window.addEventListener('popstate', () => setTimeout(chatgptDetectNavigation, 100));
const chatgptOriginalPushState = history.pushState;
history.pushState = function (data: HistoryStateData, unused: string, url?: string | URL | null) {
  chatgptOriginalPushState.call(history, data, unused, url);
  setTimeout(chatgptDetectNavigation, 100);
};
const chatgptOriginalReplaceState = history.replaceState;
history.replaceState = function (
  data: HistoryStateData,
  unused: string,
  url?: string | URL | null
) {
  chatgptOriginalReplaceState.call(history, data, unused, url);
  setTimeout(chatgptDetectNavigation, 100);
};
