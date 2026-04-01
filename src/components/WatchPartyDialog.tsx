import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface WatchPartyDialogProps {
  open: boolean;
  onClose: () => void;
  onStart: (pseudo: string) => void;
  onJoin: (partyId: string, pseudo: string) => void;
  partyId?: string | null;
  isHost?: boolean;
}

const validatePseudo = (pseudo: string) => {
  // Pas de caractères spéciaux, pas vide, longueur raisonnable
  return /^[a-zA-Z0-9_]{3,16}$/.test(pseudo);
};

const WatchPartyDialog: React.FC<WatchPartyDialogProps> = ({ open, onClose, onStart, onJoin, partyId, isHost }) => {
  const { t } = useTranslation();
  const [pseudo, setPseudo] = useState('');
  const [partyCode, setPartyCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleStart = () => {
    if (!validatePseudo(pseudo)) {
      setError(t('watchParty.invalidPseudo'));
      return;
    }
    setError(null);
    onStart(pseudo);
    onClose();
  };

  const handleJoin = () => {
    if (!validatePseudo(pseudo)) {
      setError(t('watchParty.invalidPseudo'));
      return;
    }
    if (!partyCode) {
      setError(t('watchParty.codeRequired'));
      return;
    }
    setError(null);
    onJoin(partyCode, pseudo);
    onClose();
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
      <div className="bg-gray-900 rounded-lg p-6 w-full max-w-md">
        <h2 className="text-xl font-bold mb-4 text-white">{isHost ? t('watchParty.create') : t('watchParty.joinParty')}</h2>
        <label className="block text-white mb-2">{t('watchParty.pseudo')}</label>
        <input
          className="w-full p-2 rounded mb-4 bg-gray-800 text-white"
          value={pseudo}
          onChange={e => setPseudo(e.target.value)}
          placeholder={t('watchParty.yourPseudo')}
          maxLength={16}
        />
        {!isHost && (
          <>
            <label className="block text-white mb-2">{t('watchParty.watchPartyCode')}</label>
            <input
              className="w-full p-2 rounded mb-4 bg-gray-800 text-white"
              value={partyCode}
              onChange={e => setPartyCode(e.target.value)}
              placeholder={t('watchParty.enterWatchPartyCode')}
            />
          </>
        )}
        {error && <div className="text-red-400 mb-2">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="px-4 py-2 bg-gray-700 rounded text-white" onClick={onClose}>{t('common.cancel')}</button>
          {isHost ? (
            <button className="px-4 py-2 bg-blue-600 rounded text-white" onClick={handleStart}>{t('watchParty.create')}</button>
          ) : (
            <button className="px-4 py-2 bg-blue-600 rounded text-white" onClick={handleJoin}>{t('watchParty.join')}</button>
          )}
        </div>
      </div>
    </div>
  );
};

export default WatchPartyDialog;
