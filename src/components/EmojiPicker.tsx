import React, { useState, useRef, useEffect } from 'react';
import { Smile } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import emojiData from '@emoji-mart/data/sets/14/apple.json';
import Picker from '@emoji-mart/react';

interface EmojiPickerProps {
  onEmojiSelect: (emoji: string) => void;
  buttonClassName?: string;
}

const EmojiPicker: React.FC<EmojiPickerProps> = ({ onEmojiSelect, buttonClassName }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Ferme le picker quand on clique en dehors
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleEmojiSelect = (emoji: any) => {
    onEmojiSelect(emoji.native);
    
    // Ajouter l'emoji aux récents
    const storedRecentEmojis = localStorage.getItem('recentEmojis');
    const recentEmojis: string[] = storedRecentEmojis ? JSON.parse(storedRecentEmojis) : [];
    
    const updatedRecents = [
      emoji.native,
      ...recentEmojis.filter(e => e !== emoji.native)
    ].slice(0, 10); // Garder les 10 plus récents
    
    localStorage.setItem('recentEmojis', JSON.stringify(updatedRecents));
    
    // Optionnellement, fermer le picker après sélection
    setIsOpen(false);
  };

  // Configuration pour emoji-mart
  const pickerConfig = {
    data: emojiData,
    onEmojiSelect: handleEmojiSelect,
    theme: 'dark',
    set: 'apple',
    previewPosition: 'none',
    skinTonePosition: 'none',
    maxFrequentRows: 1,
    navPosition: 'bottom',
    locale: 'fr',
    categories: ['frequent', 'people', 'nature', 'foods', 'activity', 'places', 'objects', 'symbols', 'flags'],
    i18n: {
      search: t('emojiPicker.search'),
      categories: {
        frequent: t('emojiPicker.frequent'),
        people: t('emojiPicker.people'),
        nature: t('emojiPicker.nature'),
        foods: t('emojiPicker.foods'),
        activity: t('emojiPicker.activity'),
        places: t('emojiPicker.places'),
        objects: t('emojiPicker.objects'),
        symbols: t('emojiPicker.symbols'),
        flags: t('emojiPicker.flags')
      }
    }
  };

  return (
    <div className="relative" ref={pickerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={buttonClassName || "text-gray-400 hover:text-yellow-500 transition p-2 rounded-full"}
        title={t('emojiPicker.emojis')}
      >
        <Smile className="w-5 h-5" />
      </button>

      {isOpen && (
        <div className="absolute z-50 bottom-full mb-2 right-0">
          <Picker {...pickerConfig} />
        </div>
      )}
    </div>
  );
};

export default EmojiPicker; 