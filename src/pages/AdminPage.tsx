import React, { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminDashboard from '../components/AdminDashboard';

const AdminPage: React.FC = () => {
  const { t } = useTranslation();
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [adminRole, setAdminRole] = useState<'admin' | 'uploader'>('admin');

  useEffect(() => {
    const checkAdminAuth = async () => {
      try {
        const authToken = localStorage.getItem('auth_token');

        if (!authToken) {
          setIsAuthenticated(false);
          setIsLoading(false);
          return;
        }

        // Vérifier si l'utilisateur est admin en utilisant l'endpoint de vérification
        const API_URL = import.meta.env.VITE_MAIN_API;
        const response = await fetch(`${API_URL}/api/admin/check`, {
          headers: {
            'Authorization': `Bearer ${authToken}`
          }
        });

        if (response.ok) {
          const data = await response.json();
          setIsAuthenticated(true);
          // Récupérer le rôle depuis la réponse (par défaut 'admin')
          setAdminRole(data.admin?.role || 'admin');
        } else {
          setIsAuthenticated(false);
        }
      } catch (error) {
        console.error('Erreur lors de la vérification admin:', error);
        setIsAuthenticated(false);
      } finally {
        setIsLoading(false);
      }
    };

    checkAdminAuth();
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white mx-auto mb-4"></div>
          <p>{t('admin.verifyingRights')}</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-black text-white pt-20">
      <AdminDashboard role={adminRole} />
    </div>
  );
};

export default AdminPage;
