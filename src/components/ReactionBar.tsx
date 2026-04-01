import React, { useState, useRef } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Reaction } from '../types/Comment';
import emojiData from '@emoji-mart/data/sets/14/apple.json';
import Picker from '@emoji-mart/react';

interface ReactionBarProps {
  reactions: Reaction[];
  onReactionClick: (emoji: string) => void;
  currentUserId: string | null;
}

const ReactionBar: React.FC<ReactionBarProps> = ({ 
  reactions,
  onReactionClick,
  currentUserId 
}) => {
  const { t } = useTranslation();
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  // N'affiche que les réactions qui ont au moins 1 utilisateur
  const validReactions = reactions.filter(reaction => reaction.count > 0);
  
  if (!currentUserId && validReactions.length === 0) {
    return null;
  }

  const handleEmojiSelect = (emoji: any) => {
    onReactionClick(emoji.native);
    setShowEmojiPicker(false);
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
    perLine: 6,
    emojiSize: 20,
    emojiButtonSize: 28,
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
    <div className="flex flex-wrap gap-1.5 mt-2">
      {validReactions.map((reaction, index) => {
        const hasReacted = currentUserId && reaction.users.includes(currentUserId);
        
        return (
          <button
            key={`${reaction.emoji}-${index}`}
            onClick={() => onReactionClick(reaction.emoji)}
            className={`flex items-center space-x-1.5 px-2 py-1 rounded-full text-sm transition-colors
              ${hasReacted 
                ? 'bg-blue-600/30 border border-blue-500 text-white transform hover:scale-105' 
                : 'bg-gray-700/50 hover:bg-gray-700 border border-gray-600 text-gray-300 hover:scale-105'}`}
          >
            <span className="text-base">{reaction.emoji}</span>
            <span className="text-xs">{reaction.count}</span>
          </button>
        );
      })}
      
      {currentUserId && (
        <div className="relative" ref={emojiPickerRef}>
          <button
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="flex items-center space-x-1.5 px-2 py-1 rounded-full text-sm bg-gray-700/50 hover:bg-gray-700 border border-gray-600 text-gray-300 hover:scale-105 transition-transform"
          >
            <Plus size={14} />
          </button>
          
          {showEmojiPicker && (
            <div className="absolute z-50 bottom-full mb-2 right-0">
              <Picker {...pickerConfig} />
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReactionBar; 