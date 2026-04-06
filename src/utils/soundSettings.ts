export const SOUND_EFFECTS_STORAGE_KEY = 'settings_sound_effects_enabled';
export const SOUND_EFFECTS_CHANGED_EVENT = 'settings_sound_effects_changed';

export const areSoundEffectsEnabled = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    return window.localStorage.getItem(SOUND_EFFECTS_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
};

export const setSoundEffectsEnabled = (enabled: boolean) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(SOUND_EFFECTS_STORAGE_KEY, String(enabled));
  } catch {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(SOUND_EFFECTS_CHANGED_EVENT, {
      detail: { enabled },
    })
  );
};
