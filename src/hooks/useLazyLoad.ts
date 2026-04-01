import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Configuration pour le lazy loading
 */
interface LazyLoadConfig {
    /**
     * Mode de chargement:
     * - 'viewport': Charge quand visible dans le viewport (Intersection Observer)
     * - 'click': Charge uniquement sur interaction utilisateur
     * - 'immediate': Charge immédiatement (comportement par défaut)
     */
    mode: 'viewport' | 'click' | 'immediate';

    /**
     * Marge avant que l'élément entre dans le viewport (défaut: '200px')
     * Plus grand = préchargement plus tôt
     */
    rootMargin?: string;

    /**
     * Seuil d'intersection (0-1, défaut: 0.01)
     */
    threshold?: number;

    /**
     * Délai avant le chargement en ms (optionnel)
     */
    delay?: number;

    /**
     * Priorité de chargement (sections avec index plus bas = chargées en premier)
     */
    priority?: number;
}

interface LazyLoadResult<T> {
    /**
     * Ref à attacher au conteneur de l'élément
     */
    ref: React.RefObject<HTMLDivElement>;

    /**
     * true si l'élément doit être rendu/chargé
     */
    shouldLoad: boolean;

    /**
     * true si le chargement a été déclenché (ne revient jamais à false)
     */
    hasTriggered: boolean;

    /**
     * true si le composant est actuellement visible dans le viewport
     */
    isVisible: boolean;

    /**
     * Fonction pour déclencher manuellement le chargement (pour mode 'click')
     */
    triggerLoad: () => void;

    /**
     * Données chargées (si fetchFn est fournie)
     */
    data: T | null;

    /**
     * true pendant le chargement des données
     */
    isLoading: boolean;

    /**
     * Erreur lors du chargement (si applicable)
     */
    error: Error | null;
}

/**
 * Hook pour le lazy loading basé sur le viewport ou l'interaction utilisateur
 * 
 * @param config Configuration du lazy loading
 * @param fetchFn Fonction optionnelle pour charger les données quand shouldLoad devient true
 * @returns État du lazy loading et ref pour le conteneur
 */
export function useLazyLoad<T = unknown>(
    config: LazyLoadConfig,
    fetchFn?: () => Promise<T>
): LazyLoadResult<T> {
    const {
        mode,
        rootMargin = '200px',
        threshold = 0.01,
        delay = 0,
        priority = 0
    } = config;

    const containerRef = useRef<HTMLDivElement>(null);
    const [shouldLoad, setShouldLoad] = useState(mode === 'immediate');
    const [hasTriggered, setHasTriggered] = useState(mode === 'immediate');
    const [isVisible, setIsVisible] = useState(false);
    const [data, setData] = useState<T | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    const observerRef = useRef<IntersectionObserver | null>(null);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Fonction pour déclencher manuellement le chargement
    const triggerLoad = useCallback(() => {
        if (!hasTriggered) {
            if (delay > 0) {
                timeoutRef.current = setTimeout(() => {
                    setShouldLoad(true);
                    setHasTriggered(true);
                }, delay);
            } else {
                setShouldLoad(true);
                setHasTriggered(true);
            }
        }
    }, [hasTriggered, delay]);

    // Observer pour le mode viewport
    useEffect(() => {
        if (mode !== 'viewport') return;

        const element = containerRef.current;
        if (!element) return;

        observerRef.current = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    setIsVisible(entry.isIntersecting);

                    if (entry.isIntersecting && !hasTriggered) {
                        // Utiliser requestIdleCallback si disponible pour éviter de bloquer le thread principal
                        if ('requestIdleCallback' in window) {
                            (window as any).requestIdleCallback(() => {
                                triggerLoad();
                            }, { timeout: 100 + priority * 50 });
                        } else {
                            setTimeout(() => {
                                triggerLoad();
                            }, priority * 50);
                        }
                    }
                });
            },
            {
                rootMargin,
                threshold
            }
        );

        observerRef.current.observe(element);

        return () => {
            if (observerRef.current) {
                observerRef.current.disconnect();
            }
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, [mode, rootMargin, threshold, hasTriggered, triggerLoad, priority]);

    // Charger les données quand shouldLoad devient true
    useEffect(() => {
        if (!shouldLoad || !fetchFn || data !== null) return;

        let isCancelled = false;

        const loadData = async () => {
            setIsLoading(true);
            setError(null);

            try {
                const result = await fetchFn();
                if (!isCancelled) {
                    setData(result);
                }
            } catch (err) {
                if (!isCancelled) {
                    setError(err instanceof Error ? err : new Error('Erreur de chargement'));
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadData();

        return () => {
            isCancelled = true;
        };
    }, [shouldLoad, fetchFn, data]);

    return {
        ref: containerRef,
        shouldLoad,
        hasTriggered,
        isVisible,
        triggerLoad,
        data,
        isLoading,
        error
    };
}

/**
 * Hook pour les carousels avec chargement différé des données
 * 
 * Ce hook est optimisé pour les rangées de contenu qui ne doivent charger leurs données
 * que lorsqu'elles approchent du viewport.
 * 
 * @param fetchFn Fonction pour charger les données de la rangée
 * @param immediateCount Nombre de rangées à charger immédiatement (par ex. les 2 premières)
 * @param index Index de la rangée dans la liste
 */
export function useLazyCarouselData<T>(
    fetchFn: () => Promise<T>,
    immediateCount: number,
    index: number
): {
    ref: React.RefObject<HTMLDivElement>;
    data: T | null;
    isLoading: boolean;
    shouldRender: boolean;
} {
    const isImmediate = index < immediateCount;

    const { ref, data, isLoading, shouldLoad } = useLazyLoad<T>(
        {
            mode: isImmediate ? 'immediate' : 'viewport',
            rootMargin: '400px', // Précharger 400px avant
            priority: index
        },
        fetchFn
    );

    return {
        ref,
        data,
        isLoading,
        shouldRender: shouldLoad
    };
}

/**
 * Hook pour les sections de détail avec chargement au scroll
 * 
 * @param sectionName Nom de la section (pour le debug)
 * @param fetchFn Fonction pour charger les données de la section
 */
export function useLazyDetailSection<T>(
    sectionName: string,
    fetchFn: () => Promise<T>
): {
    ref: React.RefObject<HTMLDivElement>;
    data: T | null;
    isLoading: boolean;
    shouldRender: boolean;
    error: Error | null;
} {
    const { ref, data, isLoading, shouldLoad, error } = useLazyLoad<T>(
        {
            mode: 'viewport',
            rootMargin: '300px',
            threshold: 0.01
        },
        fetchFn
    );

    return {
        ref,
        data,
        isLoading,
        shouldRender: shouldLoad,
        error
    };
}

/**
 * Hook pour les sections à chargement au clic (vidéos, épisodes, etc.)
 * 
 * @param fetchFn Fonction pour charger les données
 */
export function useClickToLoad<T>(
    fetchFn: () => Promise<T>
): {
    data: T | null;
    isLoading: boolean;
    error: Error | null;
    triggerLoad: () => void;
    hasLoaded: boolean;
} {
    const [data, setData] = useState<T | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);

    const triggerLoad = useCallback(async () => {
        if (hasLoaded || isLoading) return;

        setIsLoading(true);
        setError(null);

        try {
            const result = await fetchFn();
            setData(result);
            setHasLoaded(true);
        } catch (err) {
            setError(err instanceof Error ? err : new Error('Erreur de chargement'));
        } finally {
            setIsLoading(false);
        }
    }, [fetchFn, hasLoaded, isLoading]);

    return {
        data,
        isLoading,
        error,
        triggerLoad,
        hasLoaded
    };
}

export default useLazyLoad;
