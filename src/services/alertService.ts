import { EpisodeAlert, AlertStorage, NotificationData, AlertCheckResult, NotifyBeforeDays } from '../types/alerts';
import i18n from '../i18n';

const STORAGE_KEY = 'episodeReleaseAlerts';
const LAST_CHECK_KEY = 'episodeAlertsLastCheck';

export class AlertService {
  /**
   * Get all alerts from localStorage
   */
  static getAllAlerts(): AlertStorage {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    } catch (error) {
      console.error('Error reading alerts from localStorage:', error);
      return {};
    }
  }

  /**
   * Save alerts to localStorage
   */
  static saveAlerts(alerts: AlertStorage): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
    } catch (error) {
      console.error('Error saving alerts to localStorage:', error);
    }
  }

  /**
   * Generate a unique alert ID
   */
  static generateAlertId(showId: string, season: number, episode: number): string {
    return `${showId}_s${season}_e${episode}`;
  }

  /**
   * Add a new alert
   */
  static addAlert(
    showId: string,
    showName: string,
    season: number,
    episode: number,
    episodeName: string | undefined,
    airDate: string,
    notifyBeforeDays: NotifyBeforeDays
  ): boolean {
    try {
      const alerts = this.getAllAlerts();
      const alertId = this.generateAlertId(showId, season, episode);

      const newAlert: EpisodeAlert = {
        id: alertId,
        showId,
        showName,
        season,
        episode,
        episodeName,
        airDate,
        notifyBeforeDays,
        createdAt: new Date().toISOString(),
        dismissed: false
      };

      alerts[alertId] = newAlert;
      this.saveAlerts(alerts);
      return true;
    } catch (error) {
      console.error('Error adding alert:', error);
      return false;
    }
  }

  /**
   * Remove an alert
   */
  static removeAlert(alertId: string): boolean {
    try {
      const alerts = this.getAllAlerts();
      delete alerts[alertId];
      this.saveAlerts(alerts);
      return true;
    } catch (error) {
      console.error('Error removing alert:', error);
      return false;
    }
  }

  /**
   * Check if an alert exists for a specific episode
   */
  static hasAlert(showId: string, season: number, episode: number): boolean {
    const alerts = this.getAllAlerts();
    const alertId = this.generateAlertId(showId, season, episode);
    return alertId in alerts;
  }

  /**
   * Get a specific alert
   */
  static getAlert(showId: string, season: number, episode: number): EpisodeAlert | null {
    const alerts = this.getAllAlerts();
    const alertId = this.generateAlertId(showId, season, episode);
    return alerts[alertId] || null;
  }

  /**
   * Update an existing alert's notification timing
   */
  static updateAlert(
    showId: string,
    season: number,
    episode: number,
    notifyBeforeDays: NotifyBeforeDays
  ): boolean {
    try {
      const alerts = this.getAllAlerts();
      const alertId = this.generateAlertId(showId, season, episode);
      
      if (alerts[alertId]) {
        alerts[alertId].notifyBeforeDays = notifyBeforeDays;
        this.saveAlerts(alerts);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error updating alert:', error);
      return false;
    }
  }

  /**
   * Check which alerts should be triggered now
   */
  static checkAlertsToTrigger(): AlertCheckResult {
    const alerts = this.getAllAlerts();
    const now = new Date();
    const alertsToShow: NotificationData[] = [];
    const alertsToRemove: string[] = [];

    console.log('Current time:', now.toISOString());
    console.log('All alerts:', alerts);

    Object.values(alerts).forEach(alert => {
      const airDate = new Date(alert.airDate);
      const timeDiff = airDate.getTime() - now.getTime();
      const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));

      console.log(`Alert ${alert.id}:`, {
        airDate: airDate.toISOString(),
        timeDiff,
        daysDiff,
        notifyBeforeDays: alert.notifyBeforeDays,
        dismissed: alert.dismissed,
        lastNotified: alert.lastNotified,
        shouldTrigger: daysDiff <= alert.notifyBeforeDays && !alert.dismissed,
        willSkipBecauseDismissed: alert.dismissed === true
      });

      // If the episode has already aired, remove the alert
      if (daysDiff < 0) {
        alertsToRemove.push(alert.id);
        return;
      }

      // Skip if user dismissed this alert permanently
      if (alert.dismissed === true) {
        console.log(`Skipping dismissed alert: ${alert.id}`);
        return;
      }

      // Check if we should trigger the alert
      // Trigger if we're at or past the notification threshold
      const shouldTrigger = daysDiff <= alert.notifyBeforeDays;

      // Check if we already notified recently (within last 12 hours to avoid spam)
      const lastNotified = alert.lastNotified ? new Date(alert.lastNotified) : null;
      const twelveHoursAgo = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      const recentlyNotified = lastNotified && lastNotified > twelveHoursAgo;

      if (shouldTrigger && !recentlyNotified) {
        const message = this.generateNotificationMessage(alert, daysDiff);
        alertsToShow.push({
          id: alert.id,
          showId: alert.showId,
          showName: alert.showName,
          season: alert.season,
          episode: alert.episode,
          episodeName: alert.episodeName,
          airDate: alert.airDate,
          daysUntilAir: daysDiff,
          message
        });
      }
    });

    console.log('Final result:', { alertsToShow, alertsToRemove });
    return { alertsToShow, alertsToRemove };
  }

  /**
   * Generate notification message based on days until air
   */
  static generateNotificationMessage(alert: EpisodeAlert, daysUntilAir: number): string {
    const episodeText = alert.episodeName 
      ? i18n.t('alerts.notification.episodeWithName', { season: alert.season, episode: alert.episode, episodeName: alert.episodeName })
      : i18n.t('alerts.notification.episodeWithoutName', { season: alert.season, episode: alert.episode });

    if (daysUntilAir === 0) {
      return i18n.t('alerts.notification.airsToday', { episodeText, showName: alert.showName });
    } else if (daysUntilAir === 1) {
      return i18n.t('alerts.notification.airsTomorrow', { episodeText, showName: alert.showName });
    } else {
      return i18n.t('alerts.notification.airsInDays', { episodeText, showName: alert.showName, count: daysUntilAir });
    }
  }

  /**
   * Get the last check timestamp
   */
  static getLastCheckTime(): number {
    try {
      const stored = localStorage.getItem(LAST_CHECK_KEY);
      return stored ? parseInt(stored, 10) : 0;
    } catch (error) {
      console.error('Error reading last check time:', error);
      return 0;
    }
  }

  /**
   * Update the last check timestamp
   */
  static updateLastCheckTime(): void {
    try {
      localStorage.setItem(LAST_CHECK_KEY, Date.now().toString());
    } catch (error) {
      console.error('Error updating last check time:', error);
    }
  }

  /**
   * Check if it's time to run the alert check (every 5 minutes after initial check)
   */
  static shouldRunCheck(): boolean {
    const lastCheck = this.getLastCheckTime();
    const now = Date.now();

    // If no previous check (first time), always run
    if (lastCheck === 0) {
      console.log('First time check - running immediately');
      return true;
    }

    // Otherwise check every 5 minutes
    const checkInterval = 5 * 60 * 1000; // 5 minutes

    const shouldRun = (now - lastCheck) >= checkInterval;
    console.log('Should run check:', {
      lastCheck: new Date(lastCheck).toISOString(),
      now: new Date(now).toISOString(),
      timeSinceLastCheck: now - lastCheck,
      checkInterval: '5 minutes',
      shouldRun
    });

    return shouldRun;
  }

  /**
   * Clean up expired alerts (episodes that have already aired)
   */
  static cleanupExpiredAlerts(): number {
    const alerts = this.getAllAlerts();
    const now = new Date();
    let removedCount = 0;

    Object.values(alerts).forEach(alert => {
      const airDate = new Date(alert.airDate);
      if (airDate < now) {
        delete alerts[alert.id];
        removedCount++;
      }
    });

    if (removedCount > 0) {
      this.saveAlerts(alerts);
    }

    return removedCount;
  }

  /**
   * Get alerts count
   */
  static getAlertsCount(): number {
    const alerts = this.getAllAlerts();
    return Object.keys(alerts).length;
  }

  /**
   * Get alerts for a specific show
   */
  static getAlertsForShow(showId: string): EpisodeAlert[] {
    const alerts = this.getAllAlerts();
    return Object.values(alerts).filter(alert => alert.showId === showId);
  }

  /**
   * Mark an alert as notified (update lastNotified timestamp)
   */
  static markAsNotified(alertId: string): boolean {
    try {
      const alerts = this.getAllAlerts();
      if (alerts[alertId]) {
        alerts[alertId].lastNotified = new Date().toISOString();
        this.saveAlerts(alerts);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error marking alert as notified:', error);
      return false;
    }
  }

  /**
   * Dismiss an alert permanently
   */
  static dismissAlert(alertId: string): boolean {
    try {
      const alerts = this.getAllAlerts();
      console.log(`Attempting to dismiss alert: ${alertId}`);
      console.log(`Alert exists:`, !!alerts[alertId]);

      if (alerts[alertId]) {
        alerts[alertId].dismissed = true;
        this.saveAlerts(alerts);
        console.log(`Alert ${alertId} dismissed successfully`);
        console.log(`Updated alert:`, alerts[alertId]);
        return true;
      }
      console.log(`Alert ${alertId} not found`);
      return false;
    } catch (error) {
      console.error('Error dismissing alert:', error);
      return false;
    }
  }

  /**
   * Reset alert notification status (for "remind me later")
   */
  static resetNotificationStatus(alertId: string): boolean {
    try {
      const alerts = this.getAllAlerts();
      if (alerts[alertId]) {
        delete alerts[alertId].lastNotified;
        alerts[alertId].dismissed = false;
        this.saveAlerts(alerts);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error resetting notification status:', error);
      return false;
    }
  }
}
