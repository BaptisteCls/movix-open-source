import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Lock, Trash2, Plus, Film } from 'lucide-react';
import { motion } from 'framer-motion';

interface AdminLink {
  movieId: string;
  secondaryLink: string;
}

const AdminPanel: React.FC = () => {
  const { t } = useTranslation();
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [links, setLinks] = useState<AdminLink[]>([]);
  const [newMovieId, setNewMovieId] = useState('');
  const [newLink, setNewLink] = useState('');
  const [error, setError] = useState('');

  const API_BASE_URL = '/api';

  useEffect(() => {
    const fetchLinks = async () => {
      try {
        const response = await fetch('/api/links');
        if (!response.ok) throw new Error(t('errors.network'));
        const data = await response.json();
        setLinks(data);
      } catch (err) {
        console.error('Erreur lors du chargement des liens:', err);
      }
    };
    
    fetchLinks();
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (username === 'movix' && password === 'movix') {
      setIsLoggedIn(true);
      setError('');
    } else {
      setError(t('admin.invalidCredentials'));
    }
  };

  const handleAddLink = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const response = await fetch('/api/links', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          movieId: newMovieId, 
          secondaryLink: newLink 
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const updatedLinks = await response.json();
      setLinks(updatedLinks);
      setNewMovieId('');
      setNewLink('');
    } catch (err) {
      console.error('Erreur lors de l\'ajout du lien:', err);
      setError(t('admin.errorAddingLink'));
    }
  };

  const handleDeleteLink = async (movieId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/links/${movieId}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        const updatedLinks = await response.json();
        setLinks(updatedLinks);
      }
    } catch (err) {
      setError(t('admin.errorDeletingLink'));
    }
  };

  if (!isLoggedIn) {
    return (
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="min-h-screen bg-gray-900 flex items-center justify-center px-4"
      >
        <div className="bg-gray-800 p-8 rounded-lg shadow-lg w-full max-w-md">
          <div className="flex items-center justify-center mb-8">
            <Lock className="w-12 h-12 text-red-600" />
          </div>
          <h2 className="text-2xl font-bold text-center mb-8 text-white">{t('admin.adminPanel')}</h2>
          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <input
                type="text"
                placeholder={t('admin.username')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full p-3 bg-gray-700 rounded-lg text-white"
              />
            </div>
            <div>
              <input
                type="password"
                placeholder={t('admin.passwordLabel')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full p-3 bg-gray-700 rounded-lg text-white"
              />
            </div>
            {error && <p className="text-red-500 text-center">{error}</p>}
            <button
              type="submit"
              className="w-full bg-red-600 text-white p-3 rounded-lg hover:bg-red-700 transition-colors"
            >
              {t('admin.connection')}
            </button>
          </form>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-gray-900 p-8"
    >
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-white mb-8">{t('admin.adminPanel')}</h1>

        <div className="bg-gray-800 p-6 rounded-lg mb-8">
          <h2 className="text-xl font-bold text-white mb-4">{t('admin.addSecondaryLink')}</h2>
          <div className="space-y-4">
            <input
              type="text"
              placeholder={t('admin.movieIdLabel')}
              value={newMovieId}
              onChange={(e) => setNewMovieId(e.target.value)}
              className="w-full p-3 bg-gray-700 rounded-lg text-white"
            />
            <input
              type="text"
              placeholder={t('admin.secondaryLinkLabel')}
              value={newLink}
              onChange={(e) => setNewLink(e.target.value)}
              className="w-full p-3 bg-gray-700 rounded-lg text-white"
            />
            {error && <p className="text-red-500">{error}</p>}
            <button
              onClick={handleAddLink}
              className="bg-red-600 text-white px-6 py-3 rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              {t('admin.add')}
            </button>
          </div>
        </div>

        <div className="bg-gray-800 p-6 rounded-lg">
          <h2 className="text-xl font-bold text-white mb-4">{t('admin.existingSecondaryLinks')}</h2>
          <div className="space-y-4">
            {links.map((link) => (
              <div
                key={link.movieId}
                className="flex items-center justify-between bg-gray-700 p-4 rounded-lg"
              >
                <div className="flex items-center gap-4">
                  <Film className="w-5 h-5 text-red-600" />
                  <div>
                    <p className="text-white font-medium">ID: {link.movieId}</p>
                    <p className="text-gray-400 text-sm">{link.secondaryLink}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteLink(link.movieId)}
                  className="text-red-500 hover:text-red-600 transition-colors"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
};

export default AdminPanel; 