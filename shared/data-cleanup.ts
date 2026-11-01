export interface CleanupPolicy { maxAgeDays: number; maxCount: number }
export interface DataCleanupSettings { enabled: boolean; history: CleanupPolicy; requests: CleanupPolicy; jobs: CleanupPolicy }
export interface DataCleanupReport {
  revisions: number; requests: number; jobs: number; chapters: number; images: number;
  protectedRevisions: number; protectedRequests: number; protectedJobs: number;
  fingerprint: string; completedAt?: string;
}
export interface DataCleanupState { settings: DataCleanupSettings; lastRun?: DataCleanupReport }
export const defaultDataCleanupSettings = (): DataCleanupSettings => ({ enabled: false,
  history: { maxAgeDays: 0, maxCount: 0 }, requests: { maxAgeDays: 0, maxCount: 0 }, jobs: { maxAgeDays: 0, maxCount: 0 },
});
