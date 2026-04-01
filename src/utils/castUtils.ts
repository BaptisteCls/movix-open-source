// Utility functions for Chromecast and AirPlay functionality
import { buildApiProxyUrl } from '../config/runtime';

// AirPlay interfaces
export interface AirPlayMediaInfo {
  contentId: string;
  contentType: string;
  streamType: string;
  currentTime?: number;
  metadata?: {
    metadataType: number;
    title?: string;
    images?: Array<{
      url: string;
      height?: number;
      width?: number;
    }>;
  };
  customData?: {
    currentTime: number;
  };
}

export interface AirPlayState {
  isAvailable: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  error?: string;
}

export interface RemotePlaybackState {
  type: 'chromecast' | 'airplay' | null;
  state: 'disconnected' | 'connecting' | 'connected';
  error?: string;
}

// Unified casting interface
export interface UnifiedCastAdapter {
  type: 'chromecast' | 'airplay';
  isSupported: () => boolean;
  isAvailable: () => boolean;
  isConnected: () => boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  loadMedia: (mediaInfo: CastMediaInfo | AirPlayMediaInfo) => Promise<void>;
  getState: () => RemotePlaybackState;
}

// Extend Window interface for AirPlay
declare global {
  interface Window {
    WebKitPlaybackTargetAvailabilityEvent?: any;
  }
}

// Extend HTMLVideoElement for WebKit AirPlay APIs
interface HTMLVideoElementWithAirPlay extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
  webkitWirelessVideoPlaybackDisabled?: boolean;
}

export interface M3u8Stream {
  url: string;
  language?: string;
  quality?: string;
  subtitles?: any;
}

export interface Mp4Stream {
  url: string;
  language?: string;
  quality?: string;
}

export type MediaStream = M3u8Stream | Mp4Stream;

export type MediaType = 'm3u8' | 'mp4';

export interface CastMediaInfo {
  contentId: string;
  contentType: string;
  streamType: string;
  metadata?: {
    metadataType: number;
    title?: string;
    images?: Array<{
      url: string;
      height?: number;
      width?: number;
    }>;
  };
  customData?: any;
}

/**
 * Detect media type from URL
 */
export const detectMediaType = (url: string): MediaType | 'html' => {
  // Check for uqload URLs - they serve MP4 streams
  if (url.includes('uqload.cx') || url.includes('uqload')) {
    return 'mp4';
  }

  if (url.includes('.m3u8') || url.includes('m3u8')) {
    return 'm3u8';
  }
  if (url.includes('.mp4') || url.includes('mp4')) {
    return 'mp4';
  }

  // Check for HTML embed pages
  if (url.includes('.html') || url.includes('/embed-')) {
    return 'html';
  }

  // Default to m3u8 for unknown types
  return 'm3u8';
};

/**
 * Parse M3U8 manifest to extract streams and subtitles
 */
export const parseM3u8Manifest = async (m3u8Url: string): Promise<M3u8Stream[]> => {
  try {
    const response = await fetch(m3u8Url);
    const content = await response.text();
    const lines = content.split('\n');
    
    const streams: M3u8Stream[] = [];
    let currentStream: Partial<M3u8Stream> = {};
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        // Parse stream info
        const streamInfo = parseStreamInfo(line);
        currentStream = {
          quality: streamInfo.resolution,
          language: streamInfo.language,
          subtitles: []
        };

      } else if (line && !line.startsWith('#') && currentStream.quality) {
        // This is a stream URL
        currentStream.url = line.startsWith('http') ? line : new URL(line, m3u8Url).href;
        streams.push(currentStream as M3u8Stream);
        currentStream = {};
      }
    }
    
    return streams;
  } catch (error) {
    console.error('Error parsing M3U8 manifest:', error);
    return [];
  }
};

/**
 * Parse stream information from EXT-X-STREAM-INF line
 */
const parseStreamInfo = (line: string) => {
  const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1];
  const language = line.match(/LANGUAGE="([^"]+)"/)?.[1];
  
  return { resolution, language };
};



/**
 * Select the best stream based on language preference (French first)
 */
export const selectBestStream = (streams: MediaStream[]): MediaStream | null => {
  if (streams.length === 0) return null;
  
  // Priority order: French, English, then others
  const languagePriority = ['fr', 'fre', 'fra', 'en', 'eng', 'en-US', 'en-GB'];
  
  // First, try to find a French stream
  for (const priority of languagePriority) {
    const frenchStream = streams.find(stream => 
      stream.language?.toLowerCase().includes(priority.toLowerCase())
    );
    if (frenchStream) return frenchStream;
  }
  
  // If no French stream found, return the first available
  return streams[0];
};

/**
 * Prefer French audio variant for providers that encode audio track id in the variant URL (e.g., darkibox: index-v1-a1.m3u8 vs index-v1-a2.m3u8)
 * - Reads the master manifest to find the French AUDIO URI and infer the audio id (a1/a2/...)
 * - Rewrites the provided variant URL to point to the French audio id when available
 */
export const preferFrenchAudioVariant = async (
  variantUrl: string,
  masterManifestUrl: string
): Promise<string> => {
  try {
    // Only attempt for providers that follow the -aN pattern
    if (!/\-a\d+\.m3u8(\?|$)/.test(variantUrl)) {
      return variantUrl;
    }

    const response = await fetch(masterManifestUrl);
    const content = await response.text();

    // Find AUDIO French line and capture its URI to infer aN id
    // Example line: TYPE=AUDIO,...,LANGUAGE="fr",...,URI=".../index-a2.m3u8"
    const audioLines = content.split('\n').filter(l => l.includes('TYPE=AUDIO'));
    const frenchLine = audioLines.find(l => /LANGUAGE="fr"/i.test(l));
    if (!frenchLine) return variantUrl;

    const uriMatch = frenchLine.match(/URI="([^"]+)"/);
    if (!uriMatch) return variantUrl;

    const frenchUri = uriMatch[1];
    const audioIdMatch = frenchUri.match(/\-a(\d+)\.m3u8/);
    if (!audioIdMatch) return variantUrl;

    const frenchAudioId = audioIdMatch[1]; // e.g., "2"

    // Replace existing -aX.m3u8 in the variant URL with the French one
    const updated = variantUrl.replace(/\-a\d+\.m3u8/, `-a${frenchAudioId}.m3u8`);
    return updated;
  } catch (e) {
    console.warn('preferFrenchAudioVariant failed, using original variant:', e);
    return variantUrl;
  }
};

/**
 * Prepare media info for Chromecast with proper language selection
 */
export const prepareCastMediaInfo = (
  mediaUrl: string,
  title: string,
  poster?: string,
  currentTime: number = 0
): CastMediaInfo => {
  // Detect media type
  const mediaType = detectMediaType(mediaUrl);

  // Handle darkibox.com URLs with proxy
  let castUrl = mediaUrl;
  if (mediaUrl.includes('darkibox.com')) {
    castUrl = buildApiProxyUrl(mediaUrl);
  }

  // Set appropriate content type based on media type
  let contentType: string;
  if (mediaType === 'mp4') {
    contentType = 'video/mp4';
  } else if (mediaType === 'html') {
    contentType = 'text/html';
  } else {
    contentType = 'application/x-mpegURL';
  }

  const mediaInfo: CastMediaInfo = {
    contentId: castUrl,
    contentType: contentType,
    streamType: 'BUFFERED',
    metadata: {
      metadataType: 1, // Movie metadata
      title: title,
      images: poster ? [{
        url: poster.startsWith('http') ? poster : `https://image.tmdb.org/t/p/w500${poster}`,
        height: 480,
        width: 320
      }] : undefined
    },
    customData: {
      currentTime: currentTime
    }
  };

  return mediaInfo;
};

/**
 * Load media on AirPlay with proper video URL handling
 */
/**
 * Prepare video element for AirPlay playback
 * 
 * IMPORTANT: For AirPlay to work with HLS streams, you must use Safari's native HLS support.
 * This means you should NOT use HLS.js when AirPlay is active.
 * Safari has built-in HLS support and AirPlay works seamlessly with it.
 * 
 * @param videoElement - The video element to configure
 * @param mediaUrl - URL of the media (can be HLS or MP4)
 * @param useNativePlayback - If true, will set src directly (for Safari native HLS)
 */
export const prepareVideoForAirPlay = (
  videoElement: HTMLVideoElement,
  mediaUrl: string,
  useNativePlayback: boolean = true
): void => {
  if (!isAirPlaySupported()) {
    console.warn('[AirPlay] Not supported on this device/browser');
    return;
  }

  const video = videoElement as HTMLVideoElementWithAirPlay;
  
  console.log('[AirPlay] Preparing video element', {
    url: mediaUrl,
    useNativePlayback
  });
  
  // Configure video element for AirPlay
  video.setAttribute('x-webkit-airplay', 'allow');
  
  if (typeof video.webkitWirelessVideoPlaybackDisabled !== 'undefined') {
    video.webkitWirelessVideoPlaybackDisabled = false;
  }
  
  if ('disableRemotePlayback' in video) {
    (video as any).disableRemotePlayback = false;
  }
  
  // If using native playback (recommended for AirPlay with HLS)
  // The caller should set video.src directly and destroy HLS.js instance
  if (useNativePlayback && mediaUrl) {
    console.log('[AirPlay] Setting up native playback for AirPlay');
    
    // Apply proxy if needed
    let finalUrl = mediaUrl;
    if (mediaUrl.includes('darkibox.com')) {
      finalUrl = buildApiProxyUrl(mediaUrl);
    }
    
    // For Safari, we can set src directly for both HLS and MP4
    // Safari has native HLS support
    video.src = finalUrl;
  }
  
  console.log('[AirPlay] Video element prepared successfully');
};

/**
 * @deprecated Use prepareVideoForAirPlay instead
 * This function is kept for backward compatibility but should not be used
 * as it interferes with HLS.js
 */
export const loadMediaOnAirPlay = async (
  videoElement: HTMLVideoElement,
  mediaUrl: string,
  _title: string,
  _poster?: string,
  currentTime: number = 0
): Promise<void> => {
  console.warn('[AirPlay] loadMediaOnAirPlay is deprecated. Use prepareVideoForAirPlay instead.');
  
  if (!isAirPlaySupported()) {
    throw new Error('AirPlay is not supported on this device');
  }

  try {
    prepareVideoForAirPlay(videoElement, mediaUrl, true);
    
    if (currentTime > 0) {
      videoElement.currentTime = currentTime;
    }
    
    console.log('[AirPlay] Media prepared for AirPlay:', mediaUrl);
  } catch (error) {
    console.error('[AirPlay] Failed to prepare media:', error);
    throw error;
  }
};

// ============================================================================
// Unified Cast Adapter
// ============================================================================

/**
 * Create a unified adapter for both Chromecast and AirPlay
 */
export const createUnifiedCastAdapter = (
  videoElement: HTMLVideoElement,
  onStateChange?: (state: RemotePlaybackState) => void
): {
  chromecast: UnifiedCastAdapter | null;
  airplay: UnifiedCastAdapter | null;
  getBestAvailable: () => UnifiedCastAdapter | null;
} => {
  let chromecastSession: any = null;
  let airplayCleanup: (() => void) | null = null;

  // Chromecast adapter
  const chromecastAdapter: UnifiedCastAdapter | null = (() => {
    if (typeof window === 'undefined' || !(window as any).chrome?.cast?.isAvailable) {
      return null;
    }

    return {
      type: 'chromecast',
      isSupported: () => !!(window as any).chrome?.cast?.isAvailable,
      isAvailable: () => !!(window as any).chrome?.cast?.isAvailable,
      isConnected: () => !!chromecastSession,
      
      connect: async () => {
        try {
          onStateChange?.({ type: 'chromecast', state: 'connecting' });
          chromecastSession = await requestCastSession();
          onStateChange?.({ type: 'chromecast', state: 'connected' });
        } catch (error) {
          onStateChange?.({ 
            type: 'chromecast', 
            state: 'disconnected', 
            error: error instanceof Error ? error.message : 'Connection failed' 
          });
          throw error;
        }
      },
      
      disconnect: async () => {
        if (chromecastSession) {
          chromecastSession.stop();
          chromecastSession = null;
        }
        onStateChange?.({ type: 'chromecast', state: 'disconnected' });
      },
      
      loadMedia: async (mediaInfo) => {
        if (!chromecastSession) {
          throw new Error('No active Chromecast session');
        }
        await loadMediaOnCast(chromecastSession, mediaInfo as CastMediaInfo);
      },
      
      getState: () => ({
        type: 'chromecast' as const,
        state: chromecastSession ? 'connected' : 'disconnected'
      })
    };
  })();

  // AirPlay adapter
  const airplayAdapter: UnifiedCastAdapter | null = (() => {
    if (!isAirPlaySupported()) {
      return null;
    }

    let isConnected = false;

    return {
      type: 'airplay',
      isSupported: () => isAirPlaySupported(),
      isAvailable: () => isAirPlayAvailable(videoElement),
      isConnected: () => isConnected,
      
      connect: async () => {
        try {
          onStateChange?.({ type: 'airplay', state: 'connecting' });
          
          // Initialize AirPlay if not already done
          if (!airplayCleanup) {
            airplayCleanup = initializeAirPlay(videoElement, (state) => {
              isConnected = state.isConnected;
              onStateChange?.({
                type: 'airplay',
                state: state.isConnected ? 'connected' : 'disconnected',
                error: state.error
              });
            });
          }
          
          await requestAirPlay(videoElement);
          // Note: AirPlay connection state will be updated via event listeners
        } catch (error) {
          onStateChange?.({ 
            type: 'airplay', 
            state: 'disconnected', 
            error: error instanceof Error ? error.message : 'Connection failed' 
          });
          throw error;
        }
      },
      
      disconnect: async () => {
        // AirPlay disconnection is typically handled by the system
        // We can only clean up our event listeners
        if (airplayCleanup) {
          airplayCleanup();
          airplayCleanup = null;
        }
        isConnected = false;
        onStateChange?.({ type: 'airplay', state: 'disconnected' });
      },
      
      loadMedia: async (mediaInfo) => {
        // For AirPlay, media loading is handled automatically when connecting
        // The video element's src should be set to the media URL
        const airplayInfo = mediaInfo as AirPlayMediaInfo;
        videoElement.src = airplayInfo.contentId;
        if (airplayInfo.currentTime) {
          videoElement.currentTime = airplayInfo.currentTime;
        }
      },
      
      getState: () => ({
        type: 'airplay' as const,
        state: isConnected ? 'connected' : 'disconnected'
      })
    };
  })();

  return {
    chromecast: chromecastAdapter,
    airplay: airplayAdapter,
    getBestAvailable: () => {
      // Prefer Chromecast if available, fallback to AirPlay
      if (chromecastAdapter?.isAvailable()) {
        return chromecastAdapter;
      }
      if (airplayAdapter?.isAvailable()) {
        return airplayAdapter;
      }
      return null;
    }
  };
};

/**
 * Simple unified function to request casting (auto-detects best option)
 */
export const requestUnifiedCast = async (
  videoElement: HTMLVideoElement,
  mediaUrl: string,
  title: string,
  poster?: string,
  currentTime: number = 0
): Promise<{ type: 'chromecast' | 'airplay'; adapter: UnifiedCastAdapter }> => {
  const adapters = createUnifiedCastAdapter(videoElement);
  const bestAdapter = adapters.getBestAvailable();
  
  if (!bestAdapter) {
    throw new Error('No casting options available on this device');
  }

  // Prepare appropriate media info
  const mediaInfo = bestAdapter.type === 'chromecast' 
    ? prepareCastMediaInfo(mediaUrl, title, poster, currentTime)
    : prepareAirPlayMediaInfo(mediaUrl, title, poster, currentTime);

  // Connect and load media
  await bestAdapter.connect();
  await bestAdapter.loadMedia(mediaInfo);

  return { type: bestAdapter.type, adapter: bestAdapter };
};

/**
 * Check what casting options are available
 */
export const getAvailableCastOptions = (videoElement?: HTMLVideoElement): {
  chromecast: boolean;
  airplay: boolean;
  any: boolean;
} => {
  const chromecastAvailable = !!(window as any).chrome?.cast?.isAvailable;
  const airplayAvailable = isAirPlaySupported() && (videoElement ? isAirPlayAvailable(videoElement) : true);
  
  return {
    chromecast: chromecastAvailable,
    airplay: airplayAvailable,
    any: chromecastAvailable || airplayAvailable
  };
};



/**
 * Initialize Chromecast API
 */
export const initializeCastApi = (): Promise<boolean> => {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !(window as any).chrome?.cast?.isAvailable) {
      resolve(false);
      return;
    }
    
    const applicationID = 'CC1AD845'; // Default receiver app ID
    
    try {
      const sessionRequest = new (window as any).chrome.cast.SessionRequest(applicationID);
      const apiConfig = new (window as any).chrome.cast.ApiConfig(
        sessionRequest,
        () => {
          console.log('Cast session started');
        },
        (availability: string) => {
          console.log('Cast availability:', availability);
        }
      );
      
      (window as any).chrome.cast.initialize(apiConfig, () => {
        console.log('Cast API initialized successfully');
        resolve(true);
      }, (error: any) => {
        console.error('Cast API initialization failed:', error);
        resolve(false);
      });
    } catch (error) {
      console.error('Error initializing Cast API:', error);
      resolve(false);
    }
  });
};

/**
 * Request a cast session
 */
export const requestCastSession = (): Promise<any> => {
  return new Promise((resolve, reject) => {
    if (!(window as any).chrome?.cast) {
      reject(new Error('Cast API not available'));
      return;
    }
    
    (window as any).chrome.cast.requestSession(
      (session: any) => resolve(session),
      (error: any) => reject(error)
    );
  });
};

/**
 * Load media on cast device
 */
export const loadMediaOnCast = async (
  session: any,
  mediaInfo: CastMediaInfo,
  currentTime: number = 0,
  autoplay: boolean = true
): Promise<void> => {
  return new Promise((resolve, reject) => {
    if (!session || !(window as any).chrome?.cast?.media) {
      reject(new Error('Invalid session or Cast media API not available'));
      return;
    }
    
    const request = new (window as any).chrome.cast.media.LoadRequest(mediaInfo);
    request.currentTime = currentTime;
    request.autoplay = autoplay;
    
    session.loadMedia(request, () => {
      console.log('Media loaded on cast device');
      resolve();
    }, (error: any) => {
      console.error('Failed to load media on cast device:', error);
      reject(error);
    });
  });
};

// ============================================================================
// AirPlay Functions
// ============================================================================

/**
 * Check if AirPlay is supported on the current device
 */
/**
 * Check if AirPlay is supported by the browser (Safari only)
 */
export const isAirPlaySupported = (): boolean => {
  if (typeof window === 'undefined') return false;
  
  // Check for WebKit AirPlay API - only available in Safari
  const video = document.createElement('video') as any;
  return typeof video.webkitShowPlaybackTargetPicker === 'function';
};

/**
 * Check if AirPlay is currently available (devices detected)
 * This is a best-effort check as WebKit doesn't expose device availability directly
 */
export const isAirPlayAvailable = (videoElement?: HTMLVideoElement): boolean => {
  if (!isAirPlaySupported() || !videoElement) return false;
  
  const video = videoElement as HTMLVideoElementWithAirPlay;
  
  // AirPlay is available if wireless playback is not explicitly disabled
  // Note: This doesn't guarantee devices are present, only that AirPlay is enabled
  return video.webkitWirelessVideoPlaybackDisabled !== true;
};

/**
 * Check if currently connected to AirPlay
 */
export const isAirPlayConnected = (videoElement?: HTMLVideoElement): boolean => {
  if (!videoElement) return false;
  
  const video = videoElement as HTMLVideoElementWithAirPlay;
  return video.webkitCurrentPlaybackTargetIsWireless === true;
};

/**
 * Initialize AirPlay for a video element
 * Sets up event listeners and configures the video element for AirPlay
 * 
 * @returns Cleanup function to remove event listeners
 */
export const initializeAirPlay = (
  videoElement: HTMLVideoElement,
  onStateChange?: (state: AirPlayState) => void
): (() => void) => {
  const video = videoElement as HTMLVideoElementWithAirPlay;
  
  // Check if AirPlay is supported
  const isSupported = isAirPlaySupported();
  
  if (!isSupported) {
    console.log('[AirPlay] Not supported on this device/browser');
    onStateChange?.({ isAvailable: false, isConnected: false, isConnecting: false });
    return () => {}; // Return empty cleanup function
  }

  console.log('[AirPlay] Initializing...');

  // Configure video element for AirPlay compatibility
  // x-webkit-airplay="allow" enables AirPlay for this video element
  video.setAttribute('x-webkit-airplay', 'allow');
  
  // Enable wireless video playback (required for AirPlay)
  if (typeof video.webkitWirelessVideoPlaybackDisabled !== 'undefined') {
    video.webkitWirelessVideoPlaybackDisabled = false;
  }
  
  // Also ensure standard remote playback is not disabled
  if ('disableRemotePlayback' in video) {
    (video as any).disableRemotePlayback = false;
  }

  /**
   * Handle changes in AirPlay device availability
   * Fired when AirPlay devices become available or unavailable
   */
  const handleTargetAvailabilityChange = (event: any) => {
    const isAvailable = event.availability === 'available';
    const isConnected = video.webkitCurrentPlaybackTargetIsWireless || false;
    
    console.log('[AirPlay] Device availability changed:', {
      availability: event.availability,
      isAvailable,
      isConnected
    });
    
    onStateChange?.({
      isAvailable,
      isConnected,
      isConnecting: false
    });
  };

  /**
   * Handle changes in wireless playback target
   * Fired when connecting/disconnecting to/from AirPlay device
   */
  const handleWirelessTargetChange = () => {
    const isConnected = video.webkitCurrentPlaybackTargetIsWireless || false;
    
    console.log('[AirPlay] Wireless target changed:', {
      isConnected,
      readyState: video.readyState,
      paused: video.paused
    });
    
    onStateChange?.({
      isAvailable: isSupported,
      isConnected,
      isConnecting: false
    });
  };

  // Add event listeners for AirPlay state changes
  video.addEventListener('webkitplaybacktargetavailabilitychanged', handleTargetAvailabilityChange);
  video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', handleWirelessTargetChange);

  // Report initial state
  const initialIsConnected = video.webkitCurrentPlaybackTargetIsWireless || false;
  onStateChange?.({
    isAvailable: isSupported,
    isConnected: initialIsConnected,
    isConnecting: false
  });

  console.log('[AirPlay] Initialized successfully', {
    isConnected: initialIsConnected
  });

  // Return cleanup function to remove event listeners
  return () => {
    console.log('[AirPlay] Cleaning up event listeners');
    video.removeEventListener('webkitplaybacktargetavailabilitychanged', handleTargetAvailabilityChange);
    video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', handleWirelessTargetChange);
  };
};

/**
 * Show AirPlay device picker
 * Note: This must be triggered by a user gesture (e.g., button click)
 */
export const requestAirPlay = async (videoElement: HTMLVideoElement): Promise<void> => {
  if (!isAirPlaySupported()) {
    throw new Error('AirPlay is not supported on this device/browser');
  }

  const video = videoElement as HTMLVideoElementWithAirPlay;
  
  if (typeof video.webkitShowPlaybackTargetPicker !== 'function') {
    throw new Error('AirPlay device picker is not available');
  }

  try {
    console.log('[AirPlay] Showing device picker...');
    
    // Ensure AirPlay is enabled before showing picker
    video.setAttribute('x-webkit-airplay', 'allow');
    if (typeof video.webkitWirelessVideoPlaybackDisabled !== 'undefined') {
      video.webkitWirelessVideoPlaybackDisabled = false;
    }
    
    // Show the native AirPlay device picker
    // Note: This method doesn't return a promise, it just shows the UI
    video.webkitShowPlaybackTargetPicker();
    
    console.log('[AirPlay] Device picker shown successfully');
  } catch (error) {
    console.error('[AirPlay] Failed to show device picker:', error);
    throw error;
  }
};

/**
 * Prepare media info for AirPlay
 */
export const prepareAirPlayMediaInfo = (
  mediaUrl: string,
  title: string,
  poster?: string,
  currentTime: number = 0
): AirPlayMediaInfo => {
  // Detect media type
  const mediaType = detectMediaType(mediaUrl);

  // Handle proxy URLs for AirPlay
  let airPlayUrl = mediaUrl;
  if (mediaUrl.includes('darkibox.com')) {
    airPlayUrl = buildApiProxyUrl(mediaUrl);
  }

  // For AirPlay, we should avoid modifying M3U8 URLs too much
  // AirPlay handles HLS streams natively and modifying URLs can cause issues
  // Only apply basic proxy if needed, but keep the original structure

  // Set appropriate content type
  let contentType: string;
  if (mediaType === 'mp4') {
    contentType = 'video/mp4';
  } else if (mediaType === 'html') {
    contentType = 'text/html';
  } else {
    contentType = 'application/x-mpegURL';
  }

  const mediaInfo: AirPlayMediaInfo = {
    contentId: airPlayUrl,
    contentType: contentType,
    streamType: 'BUFFERED',
    metadata: {
      metadataType: 1,
      title: title,
      images: poster ? [{
        url: poster.startsWith('http') ? poster : `https://image.tmdb.org/t/p/w500${poster}`,
        height: 480,
        width: 320
      }] : undefined
    },
    customData: {
      currentTime: currentTime
    }
  };

  return mediaInfo;
};
