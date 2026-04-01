import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { List } from 'lucide-react';
import AddToListMenu from './AddToListMenu';

interface AddToListButtonProps {
  mediaId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  posterPath: string;
}

const AddToListButton: React.FC<AddToListButtonProps> = ({
  mediaId,
  mediaType,
  title,
  posterPath
}) => {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);

  return (
    <>
      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setShowMenu(true)}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 hover:bg-gray-700"
      >
        <List className="w-4 h-4" />
        {t('lists.addToList')}
      </motion.button>

      {showMenu && (
        <AddToListMenu
          mediaId={mediaId}
          mediaType={mediaType}
          title={title}
          posterPath={posterPath}
          onClose={() => setShowMenu(false)}
        />
      )}
    </>
  );
};

export default AddToListButton; 