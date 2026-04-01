import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import { db } from '../config/firebase';

interface HistoryItem {
  id: string;
  type: 'movie' | 'tv';
  title: string;
  poster_path: string;
  timestamp: number;
}

/**
 * Saves a movie or TV show to the user's watch history
 * @param userId The user ID
 * @param item The item to save to history
 */
export const saveToHistory = async (userId: string, item: HistoryItem): Promise<void> => {
  if (!userId) return;
  
  try {
    const historyRef = doc(db, 'users', userId, 'data', 'history');
    const historyDoc = await getDoc(historyRef);
    
    if (historyDoc.exists()) {
      // Get existing history and add new item
      const history = historyDoc.data().items || [];
      
      // Remove item if it already exists to avoid duplicates
      const filteredHistory = history.filter((historyItem: HistoryItem) => 
        !(historyItem.id === item.id && historyItem.type === item.type)
      );
      
      // Add new item at the beginning
      const updatedHistory = [item, ...filteredHistory].slice(0, 50); // Keep only last 50 items
      
      await updateDoc(historyRef, { items: updatedHistory });
    } else {
      // Create new history document
      await setDoc(historyRef, { items: [item] });
    }
  } catch (error) {
    console.error('Error saving to history:', error);
  }
}; 