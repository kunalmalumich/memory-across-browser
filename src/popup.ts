import { SidebarAction } from './types/messages';
import { StorageKey } from './types/storage';
import { supabase } from './utils/supabase';

document.addEventListener('DOMContentLoaded', () => {
  const emailInput = document.getElementById('emailInput') as HTMLInputElement;
  const sendMagicLinkButton = document.getElementById('sendMagicLinkButton') as HTMLButtonElement;
  const errorMessage = document.getElementById('errorMessage') as HTMLDivElement;
  const successMessage = document.getElementById('successMessage') as HTMLDivElement;
  const googleSignInButton = document.getElementById('googleSignInButton') as HTMLButtonElement;

  // Set logo images using chrome.runtime.getURL()
  const popupLogo = document.getElementById('popupLogo') as HTMLImageElement;
  const legacyButtonLogo = document.getElementById('legacyButtonLogo') as HTMLImageElement;
  if (popupLogo && chrome?.runtime?.getURL) {
    popupLogo.src = chrome.runtime.getURL('icons/rememberme-icon.png');
  }
  if (legacyButtonLogo && chrome?.runtime?.getURL) {
    legacyButtonLogo.src = chrome.runtime.getURL('icons/rememberme-icon.png');
  }

  // Check if already authenticated
  checkAuthStatus();

  // Magic Link functionality
  if (sendMagicLinkButton && emailInput) {
    sendMagicLinkButton.addEventListener('click', async () => {
      const email = emailInput.value.trim();
      
      // Validate email
      if (!email || !isValidEmail(email)) {
        showError('Please enter a valid email address');
        return;
      }

      // Clear previous messages
      hideMessages();
      
      // Disable button and show loading
      sendMagicLinkButton.disabled = true;
      sendMagicLinkButton.textContent = 'Sending...';

      try {
        // Use web-hosted redirect URL to avoid Chrome blocking chrome-extension:// URLs
        const redirectUrl = 'https://memorykeeper.replit.app/auth-callback';

        // Request Magic Link
        const { data, error } = await supabase.auth.signInWithOtp({
          email: email,
          options: {
            emailRedirectTo: redirectUrl
          }
        });

        if (error) {
          showError(error.message);
          sendMagicLinkButton.disabled = false;
          sendMagicLinkButton.textContent = 'Send Magic Link';
          return;
        }

        // Success - show confirmation message
        showSuccess('Magic Link sent! Check your email and click the link to sign in.');
        emailInput.style.display = 'none';
        sendMagicLinkButton.style.display = 'none';
        
      } catch (error) {
        console.error('Magic Link request error:', error);
        showError('Failed to send Magic Link. Please try again.');
        sendMagicLinkButton.disabled = false;
        sendMagicLinkButton.textContent = 'Send Magic Link';
                }
    });

    // Allow Enter key to submit
    emailInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter' && !sendMagicLinkButton.disabled) {
        sendMagicLinkButton.click();
      }
    });
  }

});

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showError(message: string) {
  const errorMessage = document.getElementById('errorMessage') as HTMLDivElement;
  if (errorMessage) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
  }
}

function showSuccess(message: string) {
  const successMessage = document.getElementById('successMessage') as HTMLDivElement;
  if (successMessage) {
    successMessage.textContent = message;
    successMessage.style.display = 'block';
  }
}

function hideMessages() {
  const errorMessage = document.getElementById('errorMessage') as HTMLDivElement;
  const successMessage = document.getElementById('successMessage') as HTMLDivElement;
  if (errorMessage) errorMessage.style.display = 'none';
  if (successMessage) successMessage.style.display = 'none';
}

async function checkAuthStatus() {
  const supabaseData = await chrome.storage.sync.get([StorageKey.SUPABASE_ACCESS_TOKEN]);
  if (supabaseData[StorageKey.SUPABASE_ACCESS_TOKEN]) {
    // Hide login form
    const emailInput = document.getElementById('emailInput') as HTMLInputElement;
    const sendMagicLinkButton = document.getElementById('sendMagicLinkButton') as HTMLButtonElement;
    if (emailInput) emailInput.style.display = 'none';
    if (sendMagicLinkButton) sendMagicLinkButton.style.display = 'none';
    
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    
    if (tabId !== null && tabId !== undefined) {
      try {
        await chrome.tabs.sendMessage(tabId, { action: SidebarAction.TOGGLE_SIDEBAR });
        showSuccess('Opening sidebar...');
        setTimeout(() => window.close(), 500);
      } catch (error) {
        // Sidebar not available on this page
        showSuccess('✓ Signed in! Sidebar available on supported pages (Claude, ChatGPT, etc.)');
      }
    } else {
      showSuccess('✓ Signed in!');
    }
  }
}
