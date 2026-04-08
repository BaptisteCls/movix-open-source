import axios from 'axios';

interface Provider {
  id: string;
  name: string;
  checkUrl: string;
}

const PROVIDERS = {
  FREMBED: {
    id: 'frembed',
    name: 'Frembed',
    checkUrl: 'https://frembed.help/api/public/v1'
  },
  STREAMTAPE: {
    id: 'streamtape',
    name: 'Streamtape',
    checkUrl: 'https://api.streamtape.com'
  }
};

export const checkContentAvailability = async (contentId: number, mediaType: 'movie' | 'tv') => {
  const availabilityChecks = await Promise.allSettled([
    checkFrembedAvailability(contentId, mediaType),
    checkStreamtapeAvailability(contentId, mediaType)
  ]);

  return availabilityChecks.reduce((acc, result, index) => {
    const providerName = Object.values(PROVIDERS)[index].name;
    if (result.status === 'fulfilled') {
      acc[providerName] = result.value;
    } else {
      acc[providerName] = false;
    }
    return acc;
  }, {} as Record<string, boolean>);
};

const checkFrembedAvailability = async (contentId: number, mediaType: 'movie' | 'tv') => {
  try {
    const endpoint = mediaType === 'movie'
      ? `${PROVIDERS.FREMBED.checkUrl}/movies/${contentId}`
      : `${PROVIDERS.FREMBED.checkUrl}/tv/${contentId}`;

    const response = await axios.get(endpoint);
    return response.data.status === 200 && !!response.data.result;
  } catch (error) {
    console.error(`Error checking Frembed availability:`, error);
    return false;
  }
};

const checkStreamtapeAvailability = async (contentId: number, mediaType: 'movie' | 'tv') => {
  try {
    const endpoint = `${PROVIDERS.STREAMTAPE.checkUrl}/check/${mediaType}/${contentId}`;
    const response = await axios.get(endpoint);
    return response.data.available;
  } catch (error) {
    console.error(`Error checking Streamtape availability:`, error);
    return false;
  }
}; 