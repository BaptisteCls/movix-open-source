import React, { useRef, useState, useEffect } from 'react';
import ContentRowSkeleton from './skeletons/ContentRowSkeleton';

/**
 * Props pour le composant LazySection
 */
interface LazySectionProps {
    /**
     * Index de la section (pour déterminer la priorité de chargement)
     */
    index: number;

    /**
     * Nombre de sections à charger immédiatement au montage
     * Les sections avec index < immediateLoadCount seront affichées immédiatement
     */
    immediateLoadCount?: number;

    /**
     * Contenu à afficher une fois la section chargée
     */
    children: React.ReactNode;

    /**
     * Composant de placeholder pendant le chargement (défaut: ContentRowSkeleton)
     */
    placeholder?: React.ReactNode;

    /**
     * Marge avant l'intersection (défaut: '400px')
     * Plus grand = préchargement plus tôt
     */
    rootMargin?: string;

    /**
     * Hauteur minimum du conteneur (pour éviter les sauts de layout)
     */
    minHeight?: string;

    /**
     * Callback optionnel quand la section devient visible
     */
    onVisible?: () => void;

    /**
     * Callback optionnel pour charger des données (sera appelé quand visible)
     */
    onLoad?: () => Promise<void>;

    /**
     * Si true, affiche un état de chargement personnalisé pendant onLoad
     */
    showLoadingDuringFetch?: boolean;

    /**
     * Classe CSS additionnelle
     */
    className?: string;
}

/**
 * Composant de lazy loading optimisé pour les sections de contenu
 * 
 * Utilise IntersectionObserver pour différer le rendu des sections
 * qui ne sont pas dans le viewport initial.
 * 
 * @example
 * ```tsx
 * // Les 2 premières sections sont chargées immédiatement
 * {sections.map((section, index) => (
 *   <LazySection key={section.id} index={index} immediateLoadCount={2}>
 *     <ContentRow items={section.items} />
 *   </LazySection>
 * ))}
 * ```
 */
const LazySection: React.FC<LazySectionProps> = ({
    index,
    immediateLoadCount = 2,
    children,
    placeholder = <ContentRowSkeleton />,
    rootMargin = '400px',
    minHeight = '200px',
    onVisible,
    onLoad,
    showLoadingDuringFetch = false,
    className = ''
}) => {
    // Les premières sections sont visibles immédiatement
    const isImmediate = index < immediateLoadCount;

    const [isVisible, setIsVisible] = useState(isImmediate);
    const [hasLoaded, setHasLoaded] = useState(isImmediate);
    const [isFetching, setIsFetching] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<IntersectionObserver | null>(null);

    useEffect(() => {
        // Si c'est une section immédiate, pas besoin d'observer
        if (isImmediate) {
            // Déclencher le callback onLoad si fourni
            if (onLoad) {
                setIsFetching(true);
                onLoad().finally(() => setIsFetching(false));
            }
            if (onVisible) {
                onVisible();
            }
            return;
        }

        const element = containerRef.current;
        if (!element) return;

        observerRef.current = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting && !hasLoaded) {
                        // Utiliser requestIdleCallback pour éviter de bloquer le thread principal
                        const triggerLoad = () => {
                            setIsVisible(true);
                            setHasLoaded(true);

                            if (onVisible) {
                                onVisible();
                            }

                            if (onLoad) {
                                setIsFetching(true);
                                onLoad().finally(() => setIsFetching(false));
                            }
                        };

                        if ('requestIdleCallback' in window) {
                            (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
                                .requestIdleCallback(triggerLoad, { timeout: 100 + index * 50 });
                        } else {
                            // Fallback pour les navigateurs ne supportant pas requestIdleCallback
                            setTimeout(triggerLoad, index * 30);
                        }
                    }
                });
            },
            {
                rootMargin,
                threshold: 0.01
            }
        );

        observerRef.current.observe(element);

        return () => {
            if (observerRef.current) {
                observerRef.current.disconnect();
            }
        };
    }, [hasLoaded, isImmediate, index, rootMargin, onVisible, onLoad]);

    // Déterminer ce qu'il faut afficher
    const shouldShowPlaceholder = !isVisible || (showLoadingDuringFetch && isFetching);

    return (
        <div
            ref={containerRef}
            className={className}
            style={{ minHeight: shouldShowPlaceholder ? minHeight : undefined }}
        >
            {shouldShowPlaceholder ? placeholder : children}
        </div>
    );
};

/**
 * Composant pour le lazy loading de sections sur clic/interaction
 * 
 * Utilisé pour les sections qui ne doivent charger leurs données
 * que lorsque l'utilisateur interagit (ex: onglets, modales)
 */
interface ClickToLoadSectionProps {
    /**
     * true si la section est active/ouverte
     */
    isActive: boolean;

    /**
     * Contenu à afficher une fois chargé
     */
    children: React.ReactNode;

    /**
     * Placeholder pendant le chargement
     */
    placeholder?: React.ReactNode;

    /**
     * Fonction de chargement des données
     */
    onLoad?: () => Promise<void>;

    /**
     * Classe CSS additionnelle
     */
    className?: string;
}

const ClickToLoadSection: React.FC<ClickToLoadSectionProps> = ({
    isActive,
    children,
    placeholder = <ContentRowSkeleton />,
    onLoad,
    className = ''
}) => {
    const [hasLoaded, setHasLoaded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (isActive && !hasLoaded) {
            if (onLoad) {
                setIsLoading(true);
                onLoad()
                    .then(() => setHasLoaded(true))
                    .finally(() => setIsLoading(false));
            } else {
                setHasLoaded(true);
            }
        }
    }, [isActive, hasLoaded, onLoad]);

    if (!isActive) {
        return null;
    }

    if (isLoading || !hasLoaded) {
        return <div className={className}>{placeholder}</div>;
    }

    return <div className={className}>{children}</div>;
};

export { LazySection, ClickToLoadSection };
export default LazySection;
