import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';

const AnnouncementManager: React.FC = () => {
    const { t } = useTranslation();
    const [announcement, setAnnouncement] = useState('');
    const [announcementType, setAnnouncementType] = useState('info');
    const [duration, setDuration] = useState('8000'); // Default 8s
    const [msgError, setMsgError] = useState('');
    const [msgSuccess, setMsgSuccess] = useState('');

    const handleSendAnnouncement = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!announcement.trim()) return;

        try {
            const token = localStorage.getItem('auth_token');
            const API_URL = import.meta.env.VITE_MAIN_API || 'http://localhost:25565';
            const response = await fetch(`${API_URL}/api/admin/announce`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    message: announcement,
                    type: announcementType,
                    duration: parseInt(duration)
                })
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();

            setMsgSuccess(t('announcement.sentTo', { count: data.count || '?' }));
            setAnnouncement('');
            setTimeout(() => setMsgSuccess(''), 3000);
        } catch (err) {
            console.error('Erreur lors de l\'envoi de l\'annonce:', err);
            setMsgError(t('announcement.sendError'));
            setTimeout(() => setMsgError(''), 3000);
        }
    };

    return (
        <div className="bg-gray-800 p-6 rounded-lg mb-8">
            <h2 className="text-xl font-bold text-white mb-4">{t('announcement.globalAnnouncement')}</h2>
            <div className="space-y-4">
                <textarea
                    placeholder={t('announcement.messagePlaceholder')}
                    value={announcement}
                    onChange={(e) => setAnnouncement(e.target.value)}
                    className="w-full p-3 bg-gray-700 rounded-lg text-white h-24 resize-none focus:ring-2 focus:ring-blue-500 outline-none"
                />
                <div className="flex gap-4">
                    <select
                        value={announcementType}
                        onChange={(e) => setAnnouncementType(e.target.value)}
                        className="p-3 bg-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                        <option value="info">Info</option>
                        <option value="warning">{t('announcement.warning')}</option>
                        <option value="success">{t('announcement.success')}</option>
                    </select>
                    <select
                        value={duration}
                        onChange={(e) => setDuration(e.target.value)}
                        className="p-3 bg-gray-700 rounded-lg text-white focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                        <option value="5000">5s</option>
                        <option value="8000">8s</option>
                        <option value="15000">15s</option>
                        <option value="30000">30s</option>
                        <option value="60000">1 min</option>
                        <option value="999999999">{t('announcement.infinite')}</option>
                    </select>
                    <button
                        onClick={handleSendAnnouncement}
                        className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 flex-1 justify-center font-semibold"
                    >
                        {t('announcement.send')}
                    </button>
                </div>
                {msgSuccess && <p className="text-green-500 text-center font-medium animate-pulse">{msgSuccess}</p>}
                {msgError && <p className="text-red-500 text-center font-medium">{msgError}</p>}
            </div>
        </div>
    );
};

export default AnnouncementManager;
