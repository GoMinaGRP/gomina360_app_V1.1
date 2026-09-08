"use client";

export interface OfflineQueueItem {
  id: string;
  type: "TRANSACTION" | "SPECIALIZED_LOG";
  businessCode?: string;
  payload: any;
  timestamp: string;
}

const OFFLINE_KEY = "gomina360_offline_queue";

export function getOfflineQueue(): OfflineQueueItem[] {
  if (typeof window === "undefined") return [];
  try {
    const data = localStorage.getItem(OFFLINE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

export function addToOfflineQueue(
  type: "TRANSACTION" | "SPECIALIZED_LOG",
  payload: any,
  businessCode?: string
): OfflineQueueItem {
  const queue = getOfflineQueue();
  const newItem: OfflineQueueItem = {
    id: `OFF-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    type,
    businessCode,
    payload,
    timestamp: new Date().toISOString(),
  };
  queue.push(newItem);
  if (typeof window !== "undefined") {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(queue));
  }
  return newItem;
}

export function clearOfflineQueue(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(OFFLINE_KEY);
  }
}

export async function synchronizeOfflineQueue(): Promise<{
  syncedCount: number;
  errors: string[];
}> {
  const queue = getOfflineQueue();
  if (queue.length === 0) {
    return { syncedCount: 0, errors: [] };
  }

  let syncedCount = 0;
  const errors: string[] = [];

  for (const item of queue) {
    try {
      if (item.type === "TRANSACTION") {
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload),
        });
        if (res.ok) syncedCount++;
        else errors.push(`Transaction sync failed: ${await res.text()}`);
      } else if (item.type === "SPECIALIZED_LOG" && item.businessCode) {
        const res = await fetch(`/api/logs/${item.businessCode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload),
        });
        if (res.ok) syncedCount++;
        else errors.push(`Log sync failed for ${item.businessCode}`);
      }
    } catch (e: any) {
      errors.push(`Network error syncing item ${item.id}: ${e.message}`);
    }
  }

  if (syncedCount > 0 && errors.length === 0) {
    clearOfflineQueue();
  }

  return { syncedCount, errors };
}
