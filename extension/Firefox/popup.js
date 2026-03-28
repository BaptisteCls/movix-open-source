// Movix Extension - Popup Logic (Firefox)
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleText = document.getElementById('toggleText');
  const toggleIcon = document.getElementById('toggleIcon');
  const toggleHint = document.getElementById('toggleHint');
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const versionEl = document.getElementById('version');
  const statsCard = document.getElementById('statsCard');

  // Get manifest version
  const manifest = browserAPI.runtime.getManifest();
  versionEl.textContent = `v${manifest.version}`;

  // Load current state
  let isEnabled = true;
  try {
    const result = await browserAPI.storage.local.get('extensionEnabled');
    isEnabled = result.extensionEnabled !== false; // default to true
  } catch (e) {
    isEnabled = true;
  }

  // Load stats
  loadStats();

  // Update UI
  updateUI(isEnabled);

  // Toggle handler
  toggleBtn.addEventListener('click', async () => {
    isEnabled = !isEnabled;
    
    // Save state
    await browserAPI.storage.local.set({ extensionEnabled: isEnabled });
    
    // Notify background script
    try {
      await browserAPI.runtime.sendMessage({ 
        action: 'TOGGLE_EXTENSION', 
        payload: { enabled: isEnabled } 
      });
    } catch (e) {
      console.log('Background message error:', e);
    }

    // Animate button
    toggleBtn.style.transform = 'scale(0.95)';
    setTimeout(() => {
      toggleBtn.style.transform = '';
    }, 150);

    updateUI(isEnabled);
  });

  function updateUI(enabled) {
    if (enabled) {
      // Extension is ON → show "Désactiver" button
      toggleBtn.className = 'toggle-btn enabled';
      toggleText.textContent = 'Désactiver l\'extension';
      toggleIcon.innerHTML = `
        <path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>
        <line x1="12" y1="2" x2="12" y2="12"/>
      `;
      toggleHint.textContent = 'L\'extension intercepte les requêtes et extrait les flux vidéo';

      statusBadge.className = 'status-badge active';
      statusText.textContent = 'Extension active';

      // Remove disabled overlay
      statsCard.classList.remove('is-disabled');
    } else {
      // Extension is OFF → show "Activer" button
      toggleBtn.className = 'toggle-btn disabled';
      toggleText.textContent = 'Activer l\'extension';
      toggleIcon.innerHTML = `
        <path d="M5 12h14"/>
        <path d="M12 5v14"/>
      `;
      toggleHint.textContent = 'L\'extension est en pause — les flux protégés ne seront pas disponibles';

      statusBadge.className = 'status-badge inactive';
      statusText.textContent = 'Extension désactivée';

      // Add disabled overlay
      statsCard.classList.add('is-disabled');
    }
  }

  async function loadStats() {
    try {
      const result = await browserAPI.storage.local.get(['stats']);
      const stats = result.stats || { extractions: 0, corsFixed: 0, cached: 0 };
      
      document.getElementById('extractionCount').textContent = stats.extractions || 0;
      document.getElementById('corsCount').textContent = stats.corsFixed || 0;
      document.getElementById('cacheCount').textContent = stats.cached || 0;
    } catch (e) {
      // Defaults are already 0
    }
  }
});
