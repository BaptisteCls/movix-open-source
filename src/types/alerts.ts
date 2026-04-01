export interface EpisodeAlert {
  id: string; // Unique identifier for the alert
  showId: string; // TMDB ID of the TV show
  showName: string; // Name of the TV show
  season: number; // Season number
  episode: number; // Episode number
  episodeName?: string; // Optional episode name
  airDate: string; // ISO string of the air date
  notifyBeforeDays: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // Days before air date to notify
  createdAt: string; // ISO string of when the alert was created
  lastNotified?: string; // ISO string of when the alert was last shown
  dismissed?: boolean; // Whether the user dismissed the alert permanently
}

export interface AlertStorage {
  [alertId: string]: EpisodeAlert;
}

export interface NotificationData {
  id: string;
  showId: string;
  showName: string;
  season: number;
  episode: number;
  episodeName?: string;
  airDate: string;
  daysUntilAir: number;
  message: string;
}

export interface AlertCheckResult {
  alertsToShow: NotificationData[];
  alertsToRemove: string[]; // IDs of alerts that have passed their air date
}

export type NotifyBeforeDays = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface AlertMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (notifyBeforeDays: NotifyBeforeDays) => void;
  showName: string;
  season: number;
  episode: number;
  episodeName?: string;
  airDate: string;
}

export interface AlertButtonProps {
  showId: string;
  showName: string;
  season: number;
  episode: number;
  episodeName?: string;
  airDate: string;
  className?: string;
}

export interface NotificationToastProps {
  notification: NotificationData;
  onDismiss: () => void;
  onGoToShow: () => void;
  onRemindLater: () => void;
}
