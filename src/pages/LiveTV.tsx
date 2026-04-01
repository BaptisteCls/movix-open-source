import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Tv, Loader2, Radio, Search, Crown, Puzzle, ChevronDown, Lock, Zap, Wifi } from 'lucide-react';


import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isExtensionAvailable, fetchFromExtension } from '../utils/extensionProxy';
import LiveTVPlayer from '../components/LiveTVPlayer';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/input';
import { useWrappedTracker } from '../hooks/useWrappedTracker';
import AdFreePlayerAds from '../components/AdFreePlayerAds';
import { isUserVip } from '../utils/authUtils';
import { getVipHeaders } from '../utils/vipUtils';
import { cn } from '../lib/utils';

interface Catalog {
  type: string;
  id: string;
  name: string;
  extra?: Array<{
    name: string;
    isRequired: boolean;
    options: string[];
  }>;
}

interface Channel {
  id: string;
  type: string;
  name: string;
  poster: string;
  genres?: string[];
  // Match-specific fields
  _timestamp?: number;
  _timeText?: string;
  _competition?: string;
  _isLive?: boolean;
  _status?: 'live' | 'upcoming';
  _countryCode?: string;
  _sport?: string;
  _sportKey?: string;
  _score?: string;
  _emoji?: string;
}

interface IptvCategory {
  category_id: string;
  category_name: string;
  parent_id: number;
}

interface IptvStream {
  stream_id: number;
  name: string;
  stream_icon: string | null;
  epg_channel_id: string | null;
  category_id: string;
}

// Catégorie emojis pour les afficher dans les tabs
const categoryEmojis: { [key: string]: string } = {
  'matches_football': '⚽', // Football matches

  'wiflix_generaliste': '📺',
  'wiflix_cinema': '🎥',
  'wiflix_sport': '⚽',
  'wiflix_documentaire': '🌍',
  'wiflix_enfants': '🎈',
  'wiflix_info': '📰',
  'wiflix_musique': '🎵',

  'sosplay_chaines': '📡', // Bolaloca
  'livetv_all': '📅',
  'livetv_live': '🔴',
  'livetv_football': '⚽',
  'livetv_hockey': '🏒',
  'livetv_basketball': '🏀',
  'livetv_tennis': '🎾',
  'livetv_volleyball': '🏐',
  'livetv_handball': '🤾',
  'livetv_rugby': '🏉',
  'livetv_combat': '🥊',
  'livetv_motorsport': '🏎️',
  'livetv_winter': '🎿',
  'livetv_athletics': '🏃',
  'livetv_other': '🏟️',

  // Linkzy (FREE source)
  'linkzy_generaliste': '📺',
  'linkzy_sport': '⚽',
  'linkzy_cinema': '🎬',
};

const livetvSportEmojis: { [key: string]: string } = {
  football: '⚽',
  hockey: '🏒',
  basketball: '🏀',
  tennis: '🎾',
  volleyball: '🏐',
  handball: '🤾',
  rugby: '🏉',
  combat: '🥊',
  motorsport: '🏎️',
  winter: '🎿',
  athletics: '🏃',
  cricket: '🏏',
  other: '🏟️',
};

const livetvSportOrder = [
  'football',
  'basketball',
  'hockey',
  'tennis',
  'volleyball',
  'handball',
  'rugby',
  'combat',
  'motorsport',
  'winter',
  'athletics',
  'other',
];

const livetvStatusOptions = [
  { key: 'playable', label: 'Jouables' },
  { key: 'live', label: 'En direct' },
  { key: 'upcoming', label: 'À venir' },
  { key: 'all', label: 'Tous' },
] as const;

// Source display names for dropdown
const sourceDisplayNames: { [key: string]: string } = {
  'linkzy': 'liveTV.freeSource',
  'matches': 'liveTV.matchesCatalogSource',
  'wiflix': 'Landscape',
  'sosplay': 'Bolaloca',
  'livetv': 'LiveTV',
  'iptv': 'IPTV Web',
};

// Get source key from catalog ID
const getSourceKey = (catalogId: string): string => {
  if (catalogId.startsWith('linkzy_')) return 'linkzy';
  if (catalogId.startsWith('matches_')) return 'matches';
  if (catalogId.startsWith('wiflix_')) return 'wiflix';
  if (catalogId.startsWith('sosplay_')) return 'sosplay';
  if (catalogId.startsWith('livetv_')) return 'livetv';
  return 'other';
};

// Format time remaining for upcoming matches with HH:MM:SS format
const formatTimeRemaining = (timestamp: number, t: (key: string, params?: Record<string, unknown>) => string): { text: string; isImminent: boolean } => {
  const now = Date.now();
  const diff = timestamp - now;
  
  if (diff <= 0) return { text: t('liveTV.inProgress'), isImminent: true };
  
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  // If less than 5 minutes, show HH:MM:SS format and mark as imminent (clickable)
  if (totalSeconds < 300) {
    return {
      text: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
      isImminent: true
    };
  }
  
  // Otherwise show relative time
  if (days > 0) {
    return { text: t('liveTV.inDays', { days, hours }), isImminent: false };
  } else if (hours > 0) {
    return { text: t('liveTV.inHours', { hours, minutes }), isImminent: false };
  } else if (minutes > 0) {
    return { text: t('liveTV.inMinutes', { minutes }), isImminent: false };
  } else {
    return { text: t('liveTV.imminent'), isImminent: true };
  }
};



const LiveTV: React.FC = () => {
  const { t } = useTranslation();
  const [catalogs, setCatalogs] = useState<Catalog[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedCatalog, setSelectedCatalog] = useState<string>('');
  const [selectedSource, setSelectedSource] = useState<string>('matches'); // Default source
  const [loadingCatalogs, setLoadingCatalogs] = useState(true);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [livetvStatusFilter, setLivetvStatusFilter] = useState<'playable' | 'live' | 'upcoming' | 'all'>('playable');
  const [livetvSportFilter, setLivetvSportFilter] = useState<string>('all');
  const [countdownUpdate, setCountdownUpdate] = useState<number>(0); // Force re-render for countdown

  // IPTV Web states
  const [iptvCategories, setIptvCategories] = useState<IptvCategory[]>([]);
  const [iptvStreams, setIptvStreams] = useState<IptvStream[]>([]);
  const [selectedIptvCategory, setSelectedIptvCategory] = useState<string>('');
  const [iptvCategorySearch, setIptvCategorySearch] = useState('');
  const [loadingIptvCategories, setLoadingIptvCategories] = useState(false);
  const [loadingIptvStreams, setLoadingIptvStreams] = useState(false);
  const [iptvCategoryDropdownOpen, setIptvCategoryDropdownOpen] = useState(false);
  const iptvDropdownRef = useRef<HTMLDivElement>(null);

  // Close IPTV dropdown on outside click
  useEffect(() => {
    if (!iptvCategoryDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (iptvDropdownRef.current && !iptvDropdownRef.current.contains(e.target as Node)) {
        setIptvCategoryDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [iptvCategoryDropdownOpen]);

  // Filter catalogs by selected source
  const filteredCatalogs = catalogs.filter(catalog => getSourceKey(catalog.id) === selectedSource);

  // Get unique sources from catalogs
  const availableSources = [...new Set(catalogs.map(c => getSourceKey(c.id)))].filter(s => s !== 'other');

  // Check access: VIP OR Extension (Linkzy is always accessible)
  const isVip = isUserVip();
  const hasExtension = isExtensionAvailable();
  const hasFullAccess = isVip || hasExtension;
  
  // Matches & IPTV require VIP specifically (not just extension)
  const isVipOnlySource = selectedSource === 'matches' || selectedSource === 'iptv';
  const hasAccess = isVipOnlySource ? isVip : hasFullAccess;

  const filteredChannels = channels.filter(channel => {
    // Exclure les chaînes désactivées (nom contenant # au début et à la fin)
    const name = channel.name.trim();
    if (name.startsWith('#') && name.endsWith('#')) return false;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  // Player state
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);

  // Gérer le bouton retour pour fermer le player
  useEffect(() => {
    if (selectedChannel) {
      window.history.pushState({ playerOpen: true }, '');

      const handlePopState = () => {
        setSelectedChannel(null);
      };

      window.addEventListener('popstate', handlePopState);

      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [selectedChannel]);

  // Movix Wrapped 2026 - Track Live TV viewing time (only when channel is open)
  useWrappedTracker({
    mode: 'viewing',
    viewingData: selectedChannel ? {
      contentType: 'live-tv',
      contentId: selectedChannel.id,
      contentTitle: selectedChannel.name,
    } : undefined,
    isActive: !!selectedChannel,
  });

  // API Base URL (utilise notre backend)
  const API_BASE = import.meta.env.VITE_MAIN_API || 'http://localhost:25565';

  // Countdown timer - update every second for live matches display
  useEffect(() => {
    const interval = setInterval(() => {
      setCountdownUpdate(prev => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch catalogs from manifest
  useEffect(() => {
    const fetchManifest = async () => {
      try {
        setLoadingCatalogs(true);
        // 1. Toujours récupérer le manifest local (qui contient Linkzy)
        let localCatalogs: Catalog[] = [];
        try {
          const response = await fetch(`${API_BASE}/api/livetv/manifest`);
          if (response.ok) {
            const result = await response.json();
            localCatalogs = result.catalogs || [];
          }
        } catch (e) {
          console.error("Erreur manifest local", e);
        }

        // 2. Si extension, récupérer le manifest extension
        let extensionCatalogs: Catalog[] = [];
        if (isExtensionAvailable()) {
          console.log("Using Movix Extension");
          try {
            const result = await fetchFromExtension('GET_MANIFEST');
            extensionCatalogs = result?.catalogs || [];
          } catch (e) {
            console.error("Erreur manifest extension", e);
          }
        }

        // 3. Fusionner les catalogues
        const catalogsMap = new Map<string, Catalog>();
        localCatalogs.forEach(c => catalogsMap.set(c.id, c));
        extensionCatalogs.forEach(c => catalogsMap.set(c.id, c));
        
        const filteredCatalogs = Array.from(catalogsMap.values());

        if (filteredCatalogs.length === 0) {
           throw new Error(t('liveTV.loadCategoriesError'));
        }

        setCatalogs(filteredCatalogs);

        // Auto-select source and catalog
        if (filteredCatalogs.length > 0) {
          if (isExtensionAvailable()) {
            // Avec extension, auto-sélectionner sosplay
            const sosplayCatalog = filteredCatalogs.find(c => getSourceKey(c.id) === 'sosplay');
            if (sosplayCatalog) {
              setSelectedCatalog(sosplayCatalog.id);
              setSelectedSource('sosplay');
            } else {
              const first = filteredCatalogs[0];
              setSelectedCatalog(first.id);
              setSelectedSource(getSourceKey(first.id));
            }
          } else {
            const first = filteredCatalogs[0];
            setSelectedCatalog(first.id);
            setSelectedSource(getSourceKey(first.id));
          }
        }
      } catch (err) {
        console.error('Error fetching manifest:', err);
        setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
      } finally {
        setLoadingCatalogs(false);
      }
    };

    fetchManifest();
  }, [hasFullAccess]);

  // Fetch channels when catalog changes
  useEffect(() => {
    if (!selectedCatalog || !hasAccess) return;

    const fetchChannels = async () => {
      try {
        setLoadingChannels(true);
        setError(null);
        let data;

        if (isExtensionAvailable()) {
          data = await fetchFromExtension('GET_CATALOG', { type: 'tv', id: selectedCatalog });
        } else {
          const response = await fetch(`${API_BASE}/api/livetv/catalog/tv/${selectedCatalog}`);
          if (!response.ok) {
            throw new Error(t('liveTV.loadChannelsError'));
          }
          data = await response.json();
        }

        setChannels(data.metas || []);
      } catch (err) {
        console.error('Error fetching channels:', err);
        setError(err instanceof Error ? err.message : t('liveTV.loadingError'));
        setChannels([]);
      } finally {
        setLoadingChannels(false);
      }
    };

    fetchChannels();
  }, [selectedCatalog, hasAccess]);

  // Fetch IPTV categories when IPTV source is selected
  useEffect(() => {
    if (selectedSource !== 'iptv' || !isVip) return;
    if (iptvCategories.length > 0) return; // already loaded

    const fetchIptvCategories = async () => {
      try {
        setLoadingIptvCategories(true);
        const response = await fetch(`${API_BASE}/api/livetv/iptv/categories`, {
          headers: { ...getVipHeaders() }
        });
        if (!response.ok) throw new Error('Erreur chargement catégories IPTV');
        const data = await response.json();
        setIptvCategories(data.categories || []);
      } catch (err) {
        console.error('Error fetching IPTV categories:', err);
        setError(err instanceof Error ? err.message : 'Erreur IPTV');
      } finally {
        setLoadingIptvCategories(false);
      }
    };

    fetchIptvCategories();
  }, [selectedSource, isVip]);

  // Fetch IPTV streams when category changes
  useEffect(() => {
    if (selectedSource !== 'iptv' || !selectedIptvCategory || !isVip) return;

    const fetchIptvStreams = async () => {
      try {
        setLoadingIptvStreams(true);
        setIptvStreams([]);
        const response = await fetch(`${API_BASE}/api/livetv/iptv/streams/${selectedIptvCategory}`, {
          headers: { ...getVipHeaders() }
        });
        if (!response.ok) throw new Error('Erreur chargement chaînes IPTV');
        const data = await response.json();
        setIptvStreams(data.streams || []);
      } catch (err) {
        console.error('Error fetching IPTV streams:', err);
        setError(err instanceof Error ? err.message : 'Erreur IPTV');
        setIptvStreams([]);
      } finally {
        setLoadingIptvStreams(false);
      }
    };

    fetchIptvStreams();
  }, [selectedIptvCategory, isVip]);

  // Ad Popup state
  const [showAd, setShowAd] = useState(false);
  const [pendingChannel, setPendingChannel] = useState<Channel | null>(null);

  const isTimedEventChannel = (channel: Channel) =>
    channel.id.startsWith('match_') || channel.id.startsWith('livetv_');

  const isImminentEventChannel = (channel: Channel) => {
    if (!channel._timestamp) return false;
    const now = Date.now();
    return channel._timestamp - now < 300000;
  };

  const isPlayableEventChannel = (channel: Channel) =>
    !isTimedEventChannel(channel) || Boolean(channel._isLive) || isImminentEventChannel(channel);

  useEffect(() => {
    if (selectedSource !== 'livetv') {
      setLivetvSportFilter('all');
      return;
    }

    setLivetvSportFilter('all');
  }, [selectedSource, selectedCatalog]);

  const livetvSportOptions = useMemo(() => {
    if (selectedSource !== 'livetv') return [];

    const sportsMap = new Map<string, { key: string; label: string; emoji: string }>();

    channels.forEach((channel) => {
      const key = channel._sportKey || 'other';
      const label = channel._sport || key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
      const emoji = channel._emoji || livetvSportEmojis[key] || '📺';
      if (!sportsMap.has(key)) {
        sportsMap.set(key, { key, label, emoji });
      }
    });

    return [
      { key: 'all', label: 'Tous', emoji: '📅' },
      ...Array.from(sportsMap.values()).sort((a, b) => {
        const orderA = livetvSportOrder.indexOf(a.key);
        const orderB = livetvSportOrder.indexOf(b.key);
        const rankA = orderA === -1 ? Number.MAX_SAFE_INTEGER : orderA;
        const rankB = orderB === -1 ? Number.MAX_SAFE_INTEGER : orderB;

        if (rankA !== rankB) {
          return rankA - rankB;
        }

        return a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' });
      })
    ];
  }, [selectedSource, channels]);

  const displayedChannels = useMemo(() => {
    let result = filteredChannels;
    const isPlayableForFilter = (channel: Channel) =>
      (!channel.id.startsWith('match_') && !channel.id.startsWith('livetv_'))
        || Boolean(channel._isLive)
        || (Boolean(channel._timestamp) && ((channel._timestamp || 0) - Date.now() < 300000));

    if (selectedSource !== 'livetv') {
      return result;
    }

    if (livetvStatusFilter === 'live') {
      result = result.filter((channel) => Boolean(channel._isLive));
    } else if (livetvStatusFilter === 'upcoming') {
      result = result.filter((channel) => !channel._isLive);
    } else if (livetvStatusFilter === 'playable') {
      result = result.filter((channel) => isPlayableForFilter(channel));
    }

    if (livetvSportFilter !== 'all') {
      result = result.filter((channel) => (channel._sportKey || 'other') === livetvSportFilter);
    }

    return result;
  }, [filteredChannels, selectedSource, livetvStatusFilter, livetvSportFilter]);

  const handleChannelClick = (channel: Channel) => {
    if (!isPlayableEventChannel(channel)) {
      return;
    }

    // Les VIPs n'ont pas de publicité
    if (isVip) {
      setSelectedChannel(channel);
      return;
    }

    const credits = parseInt(sessionStorage.getItem('livetv_ad_credits') || '0');
    if (credits > 0) {
      sessionStorage.setItem('livetv_ad_credits', (credits - 1).toString());
      setSelectedChannel(channel);
    } else {
      setPendingChannel(channel);
      setShowAd(true);
    }
  };

  const handleIptvChannelClick = async (stream: IptvStream) => {
    try {
      const response = await fetch(`${API_BASE}/api/livetv/iptv/stream-url/${stream.stream_id}`, {
        headers: { ...getVipHeaders() }
      });
      if (!response.ok) throw new Error('Erreur récupération stream IPTV');
      const data = await response.json();
      const streamUrl = data.streams?.[0]?.url;
      if (streamUrl) {
        // Créer un Channel virtuel pour le LiveTVPlayer
        setSelectedChannel({
          id: `iptv_${stream.stream_id}`,
          type: 'tv',
          name: stream.name,
          poster: stream.stream_icon || '',
        });
      }
    } catch (err) {
      console.error('Error getting IPTV stream URL:', err);
      setError(err instanceof Error ? err.message : 'Erreur IPTV');
    }
  };

  const handleAdAccept = () => {
    // Le user a regardé la pub, on lui donne 2 crédits
    // On consomme immédiatement 1 crédit pour la chaîne actuelle, donc il en reste 1
    sessionStorage.setItem('livetv_ad_credits', '1');
    setShowAd(false);
    if (pendingChannel) {
      setSelectedChannel(pendingChannel);
      setPendingChannel(null);
    }
  };

  const handleClosePlayer = () => {
    window.history.back();
  };

  const handleCloseAd = () => {
    setShowAd(false);
    setPendingChannel(null);
  };

  // Helper pour formater le nom du catalogue proprement
  const formatCatalogName = (catalog: Catalog) => {


    let name = catalog.name;

    // 1. Enlever les préfixes de source connus
    const prefixes = ['Linkzy', 'Wiflix', 'Sosplay', 'Bolaloca', 'LiveTV', 'Matches'];
    for (const prefix of prefixes) {
      if (name.toLowerCase().startsWith(prefix.toLowerCase() + ' ')) {
        name = name.slice(prefix.length + 1);
      }
    }

    // 2. Enlever les emojis du nom (car on affiche déjà une icône)
    name = name.replace(/([✀-➿]|[-]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g, '').trim();

    // 3. Translate known category keywords
    const lowerName = name.toLowerCase();
    if (lowerName.includes('g\u00e9n\u00e9raliste') || lowerName.includes('generalist')) return t('liveTV.catGeneraliste');
    if (lowerName.includes('cin\u00e9ma') || lowerName.includes('cinema') || lowerName.includes('film')) return t('liveTV.catCinema');
    if (lowerName.includes('sport') || lowerName.includes('foot')) return t('liveTV.catSport');
    if (lowerName.includes('documentaire') || lowerName.includes('docu')) return t('liveTV.catDocumentaire');
    if (lowerName.includes('enfant') || lowerName.includes('kid')) return t('liveTV.catEnfants');
    if (lowerName.includes('info') || lowerName.includes('news') || lowerName.includes('actualit')) return t('liveTV.catInfo');
    if (lowerName.includes('musique') || lowerName.includes('music')) return t('liveTV.catMusique');
    if (lowerName.includes('france')) return t('liveTV.catFrance');
    if (lowerName.includes('international')) return t('liveTV.catInternational');
    if (lowerName.includes('g\u00e9n\u00e9ral') || lowerName.includes('general')) return t('liveTV.catGeneral');

    return name || catalog.name;
  };

  // Helper pour obtenir l'emoji du catalogue (priorité: map > nom > inférence > défaut)
  const getCatalogEmoji = (catalog: Catalog) => {
    // 1. Check predefined map
    if (categoryEmojis[catalog.id]) return categoryEmojis[catalog.id];

    // 2. Try to find emoji in the ORIGINAL name
    const emojiMatch = catalog.name.match(/([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/);
    if (emojiMatch) return emojiMatch[0];

    // 3. Infer from ID or Name keywords
    const lowerId = catalog.id.toLowerCase();
    const lowerName = catalog.name.toLowerCase();
    
    if (lowerId.includes('sport') || lowerName.includes('sport') || lowerName.includes('foot')) return '⚽';
    if (lowerId.includes('movie') || lowerId.includes('film') || lowerId.includes('cinema') || lowerName.includes('film') || lowerName.includes('ciné')) return '🎬';
    if (lowerId.includes('news') || lowerId.includes('info') || lowerName.includes('info')) return '📰';
    if (lowerId.includes('kid') || lowerId.includes('enfant') || lowerName.includes('enfant')) return '👶';
    if (lowerId.includes('music') || lowerName.includes('musi')) return '🎵';
    if (lowerId.includes('docu') || lowerName.includes('docu')) return '🌍';
    if (lowerId.includes('general') || lowerName.includes('general')) return '📺';

    return '📺';
  };


  // Source icons mapping
  const sourceIcons: Record<string, React.ReactNode> = {
    'linkzy': <Zap className="w-3.5 h-3.5" />,
    'matches': <span className="text-sm leading-none">⚽</span>,
    'wiflix': <Tv className="w-3.5 h-3.5" />,
    'sosplay': <Radio className="w-3.5 h-3.5" />,
    'livetv': <Radio className="w-3.5 h-3.5" />,
    'iptv': <i className="bi bi-globe text-sm" />,
  };

  // All sources for pill tabs (inject IPTV if VIP)
  const allSources = useMemo(() => {
    const sources = [...availableSources];
    if (isVip && !sources.includes('iptv')) sources.push('iptv');
    return sources;
  }, [availableSources, isVip]);

  const handleSourceChange = (newSource: string) => {
    const srcIsVipOnly = newSource === 'matches' || newSource === 'iptv';
    if (srcIsVipOnly && !isVip) return;
    if (!srcIsVipOnly && !hasFullAccess) return;

    setSelectedSource(newSource);
    if (newSource === 'iptv') {
      setSelectedCatalog('');
      setChannels([]);
    } else {
      const firstCatalog = catalogs.find(c => getSourceKey(c.id) === newSource);
      if (firstCatalog) setSelectedCatalog(firstCatalog.id);
    }
  };

  // Skeleton loader component
  const ChannelSkeleton = () => (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
      {Array.from({ length: 18 }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-video rounded-xl bg-white/5" />
          <div className="mt-2 h-3 w-3/4 rounded bg-white/5" />
        </div>
      ))}
    </div>
  );

  // Filtered IPTV streams for search
  const filteredIptvStreams = useMemo(() =>
    iptvStreams.filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [iptvStreams, searchQuery]
  );

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white pt-20">

      {/* ── HEADER ── */}
      <div className="max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="mb-6"
        >
          <div className="flex flex-col gap-5">
            {/* Title row */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <div className="p-2.5 bg-red-500/10 rounded-xl border border-red-500/20">
                    <Tv className="w-6 h-6 text-red-500" />
                  </div>
                  <div className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                </div>
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                    {t('liveTV.title')}
                  </h1>
                  <p className="text-white/40 text-xs sm:text-sm mt-0.5">{t('liveTV.watchFavoriteChannels')}</p>
                </div>
              </div>

              {/* Search */}
              <div className="relative w-48 sm:w-64 md:w-80">
                <Input
                  type="text"
                  placeholder={t('liveTV.searchChannel')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 h-9 text-sm bg-white/[0.04] border-white/[0.06]"
                />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white opacity-30 w-4 h-4" />
              </div>
            </div>

            {/* ── SOURCE PILL TABS ── */}
            {!loadingCatalogs && hasFullAccess && allSources.length > 0 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none -mx-1 px-1">
                {allSources.map((source) => {
                  const srcIsVipOnly = source === 'matches' || source === 'iptv';
                  const isLocked = srcIsVipOnly ? !isVip : !hasFullAccess;
                  const isActive = selectedSource === source;
                  const label = sourceDisplayNames[source]?.startsWith('liveTV.') ? t(sourceDisplayNames[source]) : (sourceDisplayNames[source] || source);

                  return (
                    <motion.button
                      key={source}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => !isLocked && handleSourceChange(source)}
                      className={cn(
                        'relative flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all duration-200 border shrink-0',
                        isActive
                          ? 'bg-red-500/15 text-red-400 border-red-500/30 shadow-sm shadow-red-500/10'
                          : isLocked
                            ? 'bg-white/[0.02] text-white/25 border-white/[0.04] cursor-not-allowed'
                            : 'bg-white/[0.03] text-white/60 border-white/[0.06] hover:bg-white/[0.06] hover:text-white/90 hover:border-white/10'
                      )}
                    >
                      {sourceIcons[source]}
                      {label}
                      {isLocked && <Lock className="w-3 h-3 ml-0.5 text-white opacity-20" />}
                      {source === 'iptv' && !isLocked && (
                        <Badge variant="premium" className="text-[9px] px-1.5 py-0 ml-0.5">VIP</Badge>
                      )}
                    </motion.button>
                  );
                })}
              </div>
            )}

            {/* ── VIP UPSELL (extension users) ── */}
            {hasExtension && !isVip && !loadingCatalogs && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-between gap-4 px-4 py-3 bg-gradient-to-r from-amber-500/[0.06] to-transparent border border-amber-500/10 rounded-xl"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Crown className="w-4 h-4 text-amber-400 shrink-0" />
                  <p className="text-amber-300/80 text-xs sm:text-sm truncate">{t('liveTV.vipUnlockMore')}</p>
                </div>
                <Link to="/vip">
                  <Button size="sm" className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/20 text-xs h-7 px-3">
                    {t('liveTV.becomeVip')}
                  </Button>
                </Link>
              </motion.div>
            )}
          </div>
        </motion.div>

        {/* ── CATEGORY BAR + IPTV DROPDOWN ── */}
        {!loadingCatalogs && hasFullAccess && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 }}
            className="mb-6"
          >
            {selectedSource === 'iptv' ? (
              /* IPTV searchable category dropdown */
              <div className="relative w-full sm:w-96" ref={iptvDropdownRef}>
                {loadingIptvCategories ? (
                  <div className="flex items-center gap-3 h-10 px-4 bg-white/[0.03] border border-white/[0.06] rounded-lg text-white/40 text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Chargement...
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => setIptvCategoryDropdownOpen(!iptvCategoryDropdownOpen)}
                      className={cn(
                        'flex items-center gap-3 w-full h-10 px-4 rounded-lg text-sm transition-all duration-200 border',
                        iptvCategoryDropdownOpen
                          ? 'bg-white/[0.06] border-red-500/30 ring-1 ring-red-500/10'
                          : 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05] hover:border-white/10'
                      )}
                    >
                      <i className="bi bi-globe text-red-400 shrink-0" />
                      <span className="truncate flex-1 text-left text-white/80">
                        {selectedIptvCategory
                          ? iptvCategories.find(c => c.category_id === selectedIptvCategory)?.category_name
                          : 'Choisir une catégorie...'}
                      </span>
                      <span className="text-white/25 text-xs tabular-nums shrink-0">{iptvCategories.length}</span>
                      <ChevronDown className={cn('w-4 h-4 text-white opacity-30 shrink-0 transition-transform duration-200', iptvCategoryDropdownOpen && 'rotate-180')} />
                    </button>

                    <AnimatePresence>
                      {iptvCategoryDropdownOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          transition={{ duration: 0.15 }}
                          className="absolute z-50 mt-1.5 w-full bg-[#141416] border border-white/[0.08] rounded-xl shadow-2xl shadow-black/60 overflow-hidden"
                          data-lenis-prevent
                        >
                          <div className="p-2 border-b border-white/[0.06]">
                            <div className="relative">
                              <Input
                                type="text"
                                placeholder="Rechercher..."
                                value={iptvCategorySearch}
                                onChange={(e) => setIptvCategorySearch(e.target.value)}
                                className="pl-8 h-8 text-xs bg-white/[0.04] border-white/[0.06]"
                                autoFocus
                              />
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white opacity-30" />
                            </div>
                          </div>
                          <div className="overflow-y-auto max-h-64 py-1" data-lenis-prevent>
                            {iptvCategories
                              .filter(cat => cat.category_name.toLowerCase().includes(iptvCategorySearch.toLowerCase()))
                              .map(cat => (
                                <button
                                  key={cat.category_id}
                                  onClick={() => {
                                    setSelectedIptvCategory(cat.category_id);
                                    setIptvCategoryDropdownOpen(false);
                                    setIptvCategorySearch('');
                                  }}
                                  className={cn(
                                    'w-full text-left px-3 py-2 text-sm transition-colors',
                                    selectedIptvCategory === cat.category_id
                                      ? 'bg-red-500/10 text-red-400'
                                      : 'text-white/60 hover:bg-white/[0.04] hover:text-white/90'
                                  )}
                                >
                                  {cat.category_name}
                                </button>
                              ))}
                            {iptvCategories.filter(cat => cat.category_name.toLowerCase().includes(iptvCategorySearch.toLowerCase())).length === 0 && (
                              <p className="text-white/25 text-xs text-center py-6">Aucun résultat</p>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                )}
              </div>
            ) : selectedSource !== 'livetv' && filteredCatalogs.length > 1 ? (
              /* Regular category chips */
              <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                {filteredCatalogs.map((catalog) => {
                  const active = selectedCatalog === catalog.id;
                  return (
                    <button
                      key={catalog.id}
                      onClick={() => setSelectedCatalog(catalog.id)}
                      className={cn(
                        'flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm whitespace-nowrap transition-all duration-200 border shrink-0',
                        active
                          ? 'bg-white/10 text-white border-white/15 font-medium'
                          : 'bg-white/[0.02] text-white/50 border-transparent hover:bg-white/[0.05] hover:text-white/70'
                      )}
                    >
                      <span className="text-base">{getCatalogEmoji(catalog)}</span>
                      {formatCatalogName(catalog)}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </motion.div>
        )}

        {/* ── LOADING STATE ── */}
        {!loadingCatalogs && hasFullAccess && selectedSource === 'livetv' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.18 }}
            className="mb-5 space-y-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] uppercase tracking-[0.18em] text-white/30">Statut</span>
              {livetvStatusOptions.map((option) => {
                const active = livetvStatusFilter === option.key;
                return (
                  <button
                    key={option.key}
                    onClick={() => setLivetvStatusFilter(option.key)}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs border transition-all duration-200',
                      active
                        ? 'bg-red-500/15 text-red-400 border-red-500/30'
                        : 'bg-white/[0.03] text-white/55 border-white/[0.06] hover:bg-white/[0.05] hover:text-white/85'
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
              <span className="ml-auto text-[11px] text-white/30 tabular-nums">
                {displayedChannels.length}/{filteredChannels.length}
              </span>
            </div>

            {livetvSportOptions.length > 1 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-none">
                {livetvSportOptions.map((option) => {
                  const active = livetvSportFilter === option.key;
                  return (
                    <button
                      key={option.key}
                      onClick={() => setLivetvSportFilter(option.key)}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs whitespace-nowrap border transition-all duration-200 shrink-0',
                        active
                          ? 'bg-white/10 text-white border-white/15'
                          : 'bg-white/[0.03] text-white/55 border-white/[0.06] hover:bg-white/[0.05] hover:text-white/85'
                      )}
                    >
                      <span>{option.emoji}</span>
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}
          </motion.div>
        )}

        {loadingCatalogs && <ChannelSkeleton />}

        {/* ── ERROR STATE ── */}
        {error && !loadingCatalogs && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-24 gap-4">
            <div className="p-4 rounded-2xl bg-red-500/[0.06] border border-red-500/10">
              <Wifi className="w-8 h-8 text-red-400 opacity-60" />
            </div>
            <p className="text-white/50 text-sm max-w-xs text-center">{error}</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()} className="text-xs">
              {t('liveTV.retry')}
            </Button>
          </motion.div>
        )}

        {/* ── NO ACCESS ── */}
        {!loadingCatalogs && !hasFullAccess && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-28 gap-6"
          >
            <div className="relative">
              <div className="p-6 bg-white/[0.02] rounded-3xl border border-white/[0.06]">
                <Tv className="w-14 h-14 text-white opacity-15" />
              </div>
              <div className="absolute -bottom-1 -right-1 p-1.5 bg-amber-500/20 rounded-lg border border-amber-500/20">
                <Lock className="w-3.5 h-3.5 text-amber-400" />
              </div>
            </div>
            <div className="text-center space-y-2 max-w-sm">
              <h2 className="text-lg font-semibold text-white">{t('liveTV.accessRequired')}</h2>
              <p className="text-white/40 text-sm leading-relaxed">{t('liveTV.accessRequiredDesc')}</p>
            </div>
            <div className="flex gap-2.5">
              <Link to="/extension">
                <Button variant="outline" size="sm" className="border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/5 gap-1.5 text-xs">
                  <Puzzle className="w-3.5 h-3.5" />
                  Extension
                </Button>
              </Link>
              <Link to="/vip">
                <Button size="sm" className="bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white border-0 gap-1.5 text-xs shadow-lg shadow-amber-900/20">
                  <Crown className="w-3.5 h-3.5" />
                  VIP
                </Button>
              </Link>
            </div>
          </motion.div>
        )}

        {/* ── IPTV GRID ── */}
        {!loadingCatalogs && hasFullAccess && selectedSource === 'iptv' && (
          <div className="pb-12">
            {loadingIptvStreams ? (
              <ChannelSkeleton />
            ) : !selectedIptvCategory ? (
              <div className="flex flex-col items-center justify-center py-24 gap-4">
                <p className="text-3xl font-bold text-white/10 tabular-nums">{iptvCategories.length}</p>
                <div className="p-5 bg-white/[0.02] rounded-2xl border border-white/[0.04]">
                  <i className="bi bi-globe text-4xl text-white/10" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-white/60 text-sm font-medium">Sélectionnez une catégorie</p>
                  <p className="text-white/25 text-xs">catégories disponibles</p>
                </div>
              </div>
            ) : filteredIptvStreams.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <Radio className="w-10 h-10 text-white opacity-10" />
                <p className="text-white/40 text-sm">
                  {searchQuery ? t('liveTV.noChannelMatch') : t('liveTV.noChannelInCategory')}
                </p>
              </div>
            ) : (
              <motion.div
                key={selectedIptvCategory}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3"
              >
                {filteredIptvStreams.map((stream, index) => (
                  <motion.div
                    key={stream.stream_id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, delay: Math.min(index * 0.01, 0.3) }}
                    onClick={() => handleIptvChannelClick(stream)}
                    className="group cursor-pointer"
                  >
                    <div className="relative aspect-video rounded-xl overflow-hidden bg-white/[0.02] border border-white/[0.04] group-hover:border-white/10 transition-all duration-300 group-hover:bg-white/[0.04]">
                      {stream.stream_icon ? (
                        <img
                          src={stream.stream_icon}
                          alt={stream.name}
                          className="w-full h-full object-contain p-4"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                            (e.target as HTMLImageElement).parentElement!.querySelector('.iptv-fallback')?.classList.remove('hidden');
                          }}
                        />
                      ) : null}
                      <div className={cn('iptv-fallback w-full h-full flex flex-col items-center justify-center gap-1.5 p-3', stream.stream_icon ? 'hidden absolute inset-0' : '')}>
                        <Tv className="w-6 h-6 text-white opacity-10" />
                        <span className="text-[10px] text-white/30 line-clamp-2 text-center leading-tight">{stream.name}</span>
                      </div>
                      {/* Live dot */}
                      <div className="absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 bg-red-500 rounded text-[9px] font-bold tracking-wide uppercase">
                        <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                        {t('liveTV.liveTag')}
                      </div>
                      {/* Bottom name */}
                      <div className="absolute inset-x-0 bottom-0 p-2 pt-6 bg-gradient-to-t from-black/80 to-transparent">
                        <p className="text-[11px] font-medium text-white/90 truncate">{stream.name}</p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </motion.div>
            )}
          </div>
        )}

        {/* ── CHANNELS GRID (non-IPTV) ── */}
        {!loadingCatalogs && hasFullAccess && selectedSource !== 'iptv' && (
          <div className="pb-12">
            {loadingChannels ? (
              <ChannelSkeleton />
            ) : displayedChannels.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 gap-3">
                <Radio className="w-10 h-10 text-white opacity-10" />
                <p className="text-white/40 text-sm">
                  {searchQuery ? t('liveTV.noChannelMatch') : t('liveTV.noChannelInCategory')}
                </p>
              </div>
            ) : (
              <motion.div
                key={selectedCatalog}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
                className={cn(
                  'grid gap-3',
                  (selectedCatalog.startsWith('matches_') || selectedCatalog.startsWith('livetv_'))
                    ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5'
                    : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6'
                )}
              >
                {displayedChannels.map((channel, index) => {
                  const isWiflix = selectedCatalog.startsWith('wiflix_');
                  const isSosplay = selectedCatalog.startsWith('sosplay_');
                  const isLivetv = selectedCatalog.startsWith('livetv_');
                  const isMatch = selectedCatalog.startsWith('matches_');
                  const isEventCard = isMatch || isLivetv;
                  const isNoImage = isWiflix || isSosplay || isEventCard;
                  const isMatchLive = Boolean(channel._isLive);
                  const matchCompetition = channel._competition || channel._sport;
                  const timeRemaining = channel._timestamp ? formatTimeRemaining(channel._timestamp, t) : null;
                  const isClickableMatch = !isEventCard || isPlayableEventChannel(channel);
                  const livetvEmoji = channel._emoji || livetvSportEmojis[channel._sportKey || ''] || '📺';
                  const eventStatusLabel = !isEventCard
                    ? t('liveTV.liveTag')
                    : isClickableMatch
                      ? (isMatchLive ? t('liveTV.liveTag') : t('liveTV.imminentTag'))
                      : t('liveTV.upcomingTag');
                  void countdownUpdate;

                  return (
                    <motion.div
                      key={channel.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, delay: Math.min(index * 0.015, 0.3) }}
                      onClick={() => handleChannelClick(channel)}
                      className={cn('group', isEventCard && !isClickableMatch ? 'cursor-not-allowed' : 'cursor-pointer')}
                    >
                      <div className={cn(
                        'relative rounded-xl overflow-hidden border transition-all duration-300',
                        isEventCard ? 'aspect-[4/3]' : isNoImage ? 'aspect-video' : 'aspect-[2/3]',
                        isEventCard && !isClickableMatch
                          ? 'bg-white/[0.015] border-white/[0.03] opacity-50'
                          : 'bg-white/[0.02] border-white/[0.04] group-hover:border-white/10 group-hover:bg-white/[0.04]'
                      )}>
                        {/* Image or placeholder */}
                        {!isNoImage && channel.poster ? (
                          <img src={channel.poster} alt={channel.name} className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <div className={cn(
                            'w-full h-full flex flex-col items-center justify-center gap-1 p-3 text-center',
                            isEventCard && isClickableMatch ? 'bg-gradient-to-br from-emerald-950/40 to-transparent' : ''
                          )}>
                            {isEventCard ? (
                              <>
                                <span className="text-xl mb-1">{isLivetv ? livetvEmoji : '⚽'}</span>
                                <h3 className="text-[10px] sm:text-[11px] font-semibold text-white/80 line-clamp-3 leading-snug break-words w-full">
                                  {channel.name}
                                </h3>
                                {matchCompetition && (
                                  <p className="text-[10px] text-white/30 line-clamp-2 w-full">{matchCompetition}</p>
                                )}
                                {isMatchLive ? (
                                  <Badge className="mt-1 text-[9px] bg-emerald-500/20 text-emerald-400 border-emerald-500/20">
                                    {channel._score ? `${t('liveTV.inProgress')} • ${channel._score}` : t('liveTV.inProgress')}
                                  </Badge>
                                ) : timeRemaining ? (
                                  <p className={cn('text-[10px] font-mono font-bold mt-1', timeRemaining.isImminent ? 'text-emerald-400' : 'text-amber-400/70')}>
                                    {timeRemaining.text}
                                  </p>
                                ) : channel._timeText ? (
                                  <p className="text-[10px] font-medium mt-1 text-amber-400/70">
                                    {channel._timeText}
                                  </p>
                                ) : null}
                              </>
                            ) : (
                              <>
                                <Tv className={cn('w-6 h-6 mb-1', isSosplay ? 'text-emerald-500 opacity-40' : isLivetv ? 'text-amber-500 opacity-40' : isWiflix ? 'text-red-500 opacity-40' : 'text-white opacity-10')} />
                                <h3 className="text-xs font-medium text-white/60 line-clamp-2 leading-tight">{channel.name}</h3>
                              </>
                            )}
                          </div>
                        )}

                        {/* Hover overlay */}
                        {!isNoImage && (
                          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                        )}

                        {/* Live/status badge */}
                        <div className={cn(
                          'absolute top-2 right-2 flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide uppercase',
                          isEventCard
                            ? isClickableMatch ? 'bg-emerald-500 text-white' : 'bg-white/10 text-white/40'
                            : 'bg-red-500 text-white'
                        )}>
                          <span className={cn('w-1.5 h-1.5 rounded-full', isEventCard && !isClickableMatch ? 'bg-white/30' : 'bg-white animate-pulse')} />
                          {eventStatusLabel}
                        </div>

                        {/* Channel name (image channels) */}
                        {!isNoImage && (
                          <div className="absolute inset-x-0 bottom-0 p-2.5 pt-8 bg-gradient-to-t from-black/80 to-transparent">
                            <h3 className="text-xs font-medium text-white truncate">{channel.name}</h3>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </div>
        )}
      </div>

      {/* ── PLAYER MODAL ── */}
      <AnimatePresence>
        {selectedChannel && (
          <LiveTVPlayer
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
            channelPoster={selectedChannel.poster}
            onClose={handleClosePlayer}
          />
        )}
      </AnimatePresence>

      {/* ── AD POPUP ── */}
      {showAd && (
        <AdFreePlayerAds
          onClose={handleCloseAd}
          onAccept={handleAdAccept}
          variant="livetv"
        />
      )}
    </div>
  );
};

export default LiveTV;
