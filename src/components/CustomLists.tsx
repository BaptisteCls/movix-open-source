import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { motion } from 'framer-motion';

interface CustomList {
  id: string;
  name: string;
  items: Array<{
    id: number;
    type: 'movie' | 'tv';
    title: string;
    poster_path: string;
    addedAt: string;
  }>;
}

const CustomLists: React.FC = () => {
  const { t } = useTranslation();
  const [lists, setLists] = useState<CustomList[]>([]);
  const [newListName, setNewListName] = useState('');
  const [showNewListInput, setShowNewListInput] = useState(false);

  useEffect(() => {
    const savedLists = localStorage.getItem('custom_lists');
    if (savedLists) {
      setLists(JSON.parse(savedLists));
    }
  }, []);

  const handleCreateList = () => {
    if (newListName.trim()) {
      const newList: CustomList = {
        id: Date.now().toString(),
        name: newListName.trim(),
        items: []
      };

      const updatedLists = [...lists, newList];
      setLists(updatedLists);
      localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
      setNewListName('');
      setShowNewListInput(false);
    }
  };

  const handleDeleteList = (listId: string) => {
    const updatedLists = lists.filter(list => list.id !== listId);
    setLists(updatedLists);
    localStorage.setItem('custom_lists', JSON.stringify(updatedLists));
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">{t('lists.myCustomLists')}</h2>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={() => setShowNewListInput(true)}
          className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('lists.createList')}
        </motion.button>
      </div>

      {showNewListInput && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-2"
        >
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder={t('lists.listNamePlaceholder')}
            className="flex-grow p-2 bg-gray-800 rounded-lg text-white"
            autoFocus
          />
          <button
            onClick={handleCreateList}
            className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700"
          >
            {t('lists.create')}
          </button>
          <button
            onClick={() => {
              setShowNewListInput(false);
              setNewListName('');
            }}
            className="bg-gray-600 text-white px-4 py-2 rounded-lg hover:bg-gray-700"
          >
            {t('common.cancel')}
          </button>
        </motion.div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {lists.map(list => (
          <motion.div
            key={list.id}
            className="bg-gray-800 p-4 rounded-lg"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-semibold">{list.name}</h3>
              <button
                onClick={() => handleDeleteList(list.id)}
                className="text-red-500 hover:text-red-600"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <p className="text-sm text-gray-400">{t('lists.itemCount', { count: list.items.length })}</p>
          </motion.div>
        ))}
      </div>
    </div>
  );
};

export default CustomLists; 