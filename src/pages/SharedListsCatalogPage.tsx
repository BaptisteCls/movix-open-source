import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Globe, List, ExternalLink, Film, Link2 } from 'lucide-react';
import { SquareBackground } from '../components/ui/square-background';
import AnimatedBorderCard from '../components/ui/animated-border-card';
import ShinyText from '../components/ui/shiny-text';
import BlurText from '../components/ui/blur-text';
import LikeDislikeButton from '../components/LikeDislikeButton';

const API_URL = import.meta.env.VITE_MAIN_API;

interface CatalogListItem {
  type?: string;
  id?: string | number;
  poster_path?: string | null;
  title?: string;
  name?: string;
}

interface CatalogList {
  shareCode: string;
  username: string;
  avatar: string;
  isVip?: boolean;
  listName: string;
  itemCount: number;
  items: CatalogListItem[];
  sharedAt: number;
  updatedAt: number;
}

const SharedListsCatalogPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [lists, setLists] = useState<CatalogList[]>([]);
  const [loading, setLoading] = useState(true);
  const [shareCodeInput, setShareCodeInput] = useState('');

  useEffect(() => {
    const fetchCatalog = async () => {
      try {
        const response = await fetch(`${API_URL}/api/shared-lists/catalog?limit=60`);
        if (!response.ok) {
          setLists([]);
          return;
        }
        const data = await response.json();
        setLists(Array.isArray(data?.lists) ? data.lists : []);
      } catch (error) {
        console.error('Erreur chargement catalogue:', error);
        setLists([]);
      } finally {
        setLoading(false);
      }
    };

    fetchCatalog();
  }, []);

  const openByCode = (e: React.FormEvent) => {
    e.preventDefault();
    const code = shareCodeInput.trim();
    if (!code) return;
    navigate(`/list/${encodeURIComponent(code)}`);
  };

  return (
    <SquareBackground squareSize={48} borderColor="rgba(99, 102, 241, 0.12)" mode="combined" className="min-h-screen bg-black text-white">
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 relative z-10">
        <Link to="/" className="inline-flex items-center text-white/50 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-5 h-5 mr-2" />
          {t('common.backToHome')}
        </Link>

        <div className="max-w-4xl mx-auto text-center mb-14">
          <div className="inline-flex items-center justify-center p-3 bg-indigo-500/10 rounded-full mb-4 ring-1 ring-indigo-500/50">
            <Globe className="w-8 h-8 text-indigo-500" />
          </div>
          <h1 className="text-4xl md:text-6xl font-black tracking-tight mb-4 pb-4">
            <ShinyText text={t('lists.sharedListsCatalog')} speed={3} color="#ffffff" shineColor="#6366f1" className="block py-2 leading-tight" />
          </h1>
          <BlurText
            text={t('lists.discoverSharedLists')}
            delay={140}
            className="text-lg text-white/60 max-w-2xl mx-auto justify-center"
          />

          <div className="mt-7 max-w-xl mx-auto">
            <AnimatedBorderCard highlightColor="99 102 241" backgroundColor="10 10 10" className="p-4 backdrop-blur-sm">
              <form onSubmit={openByCode} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <div className="relative flex-1">
                  <Link2 className="w-4 h-4 text-white opacity-40 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    value={shareCodeInput}
                    onChange={(e) => setShareCodeInput(e.target.value)}
                    placeholder={t('lists.enterShareCode')}
                    className="w-full bg-black/60 border border-white/15 focus:border-indigo-500/60 outline-none text-white rounded-lg py-2.5 pl-9 pr-3 text-sm"
                  />
                </div>
                <button
                  type="submit"
                  className="inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-700 transition-colors text-white font-medium"
                >
                  {t('lists.viewList')}
                  <ExternalLink className="w-4 h-4" />
                </button>
              </form>
            </AnimatedBorderCard>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-16">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-indigo-500" />
          </div>
        ) : lists.length === 0 ? (
          <div className="max-w-2xl mx-auto">
            <AnimatedBorderCard highlightColor="99 102 241" backgroundColor="10 10 10" className="p-10 text-center backdrop-blur-sm">
              <List className="w-14 h-14 text-indigo-500 opacity-40 mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-white mb-2">{t('lists.noPublicLists')}</h2>
              <p className="text-white/50">{t('lists.catalogListsAppearHere')}</p>
            </AnimatedBorderCard>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {lists.map((list, index) => {
              const preview = (list.items || []).slice(0, 3);
              return (
                <motion.div
                  key={list.shareCode}
                  initial={{ opacity: 0, y: 18 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.15 }}
                  transition={{ duration: 0.28, delay: Math.min(index, 8) * 0.02 }}
                >
                  <AnimatedBorderCard highlightColor="99 102 241" backgroundColor="10 10 10" className="p-5 h-full backdrop-blur-sm">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div className="flex items-center gap-3 min-w-0">
                        <img
                          src={list.avatar || '/avatars/disney/disney_avatar_1.png'}
                          alt={list.username}
                          loading="lazy"
                          decoding="async"
                          className="w-10 h-10 rounded-full object-cover border border-white/15"
                        />
                        <div className="min-w-0">
                          <p className="text-xs text-white/45">{t('lists.sharedBy')}</p>
                          <div className="flex items-center gap-1.5">
                            <p className="font-semibold text-white truncate">{list.username}</p>
                            {list.isVip && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30 font-semibold shrink-0">{t('lists.vipBadge')}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <span className="text-[10px] px-2 py-1 rounded-full border border-indigo-500/30 text-indigo-300 bg-indigo-500/10">{t('lists.public', 'Public')}</span>
                    </div>

                    <h3 className="text-lg font-bold text-white mb-1 line-clamp-1">{list.listName}</h3>
                    <p className="text-sm text-white/50 mb-4">{t('profilePage.customLists.itemCount', { count: list.itemCount })}</p>

                    <div className="grid grid-cols-3 gap-2 mb-5">
                      {preview.length > 0 ? preview.map((item, idx) => (
                        <div key={`${item.type}-${item.id}-${idx}`} className="aspect-[2/3] rounded-md overflow-hidden bg-white/5 border border-white/10">
                          {item.poster_path ? (
                            <img
                              src={`https://image.tmdb.org/t/p/w300${item.poster_path}`}
                              alt={item.title || item.name || 'poster'}
                              loading="lazy"
                              decoding="async"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center"><Film className="w-4 h-4 text-white opacity-30" /></div>
                          )}
                        </div>
                      )) : (
                        <div className="col-span-3 text-center text-sm text-white/40 py-4 border border-dashed border-white/10 rounded-md">{t('lists.previewUnavailable')}</div>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-3 mb-3">
                      <LikeDislikeButton contentType="shared-list" contentId={list.shareCode} />
                    </div>

                    <Link to={`/list/${list.shareCode}`} className="inline-flex w-full items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 transition-colors text-white font-medium">
                      {t('lists.viewList')}
                      <ExternalLink className="w-4 h-4" />
                    </Link>
                  </AnimatedBorderCard>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </SquareBackground>
  );
};

export default SharedListsCatalogPage;
