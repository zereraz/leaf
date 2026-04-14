/**
 * user-data-store.ts — user-scoped data storage with cross-user access prevention.
 *
 * This module provides data isolation between users. Each piece of data
 * is tagged with an owner identifier, and cross-user access is blocked
 * unless explicitly permitted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SenderIdentity } from "./sender-identity.js";
import { getPrimaryIdentifier } from "./sender-identity.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DataItem<T = unknown> {
  /** Unique key within the user's namespace */
  key: string;
  /** The data value */
  value: T;
  /** Owner identifier (primary sender ID) */
  ownerId: string;
  /** When the data was created */
  createdAt: number;
  /** When the data was last modified */
  updatedAt: number;
  /** Data category/type for grouping */
  category?: string | undefined;
  /** Whether other users can read this data */
  allowOthersRead: boolean;
  /** Whether other users can modify this data */
  allowOthersWrite: boolean;
  /** List of specific users allowed to access (if not empty, overrides allowOthersRead) */
  allowedReaders?: string[] | undefined;
}

export interface UserDataStoreConfig {
  /** Base directory for user data */
  baseDir: string;
  /** Default permissions for new data */
  defaultPermissions: {
    allowOthersRead: boolean;
    allowOthersWrite: boolean;
  };
  /** Maximum items per user */
  maxItemsPerUser: number;
  /** Maximum total storage across all users (bytes) */
  maxTotalStorage: number;
}

export interface StorageStats {
  totalUsers: number;
  totalItems: number;
  totalSizeBytes: number;
  perUser: Map<string, { items: number; sizeBytes: number }>;
}

export const DEFAULT_STORE_CONFIG: UserDataStoreConfig = {
  baseDir: "",
  defaultPermissions: {
    allowOthersRead: false,
    allowOthersWrite: false,
  },
  maxItemsPerUser: 1000,
  maxTotalStorage: 100 * 1024 * 1024, // 100MB
};

// ── Access Control Errors ──────────────────────────────────────────────────

export class CrossUserAccessError extends Error {
  constructor(
    public readonly accessorId: string,
    public readonly ownerId: string,
    public readonly key: string,
    public readonly operation: "read" | "write" | "delete",
  ) {
    super(
      `Access denied: ${accessorId} cannot ${operation} ${key} owned by ${ownerId}`,
    );
    this.name = "CrossUserAccessError";
  }
}

export class StorageQuotaError extends Error {
  constructor(
    public readonly userId: string,
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(
      `Storage quota exceeded for ${userId}: ${current}/${limit}`,
    );
    this.name = "StorageQuotaError";
  }
}

// ── User Data Store ────────────────────────────────────────────────────────

export class UserDataStore {
  private config: UserDataStoreConfig;
  private memoryCache: Map<string, DataItem> = new Map();

  constructor(config: Partial<UserDataStoreConfig> = {}) {
    this.config = { ...DEFAULT_STORE_CONFIG, ...config };
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (this.config.baseDir && !existsSync(this.config.baseDir)) {
      mkdirSync(this.config.baseDir, { recursive: true });
    }
  }

  private getUserDir(userId: string): string {
    // Sanitize userId for filesystem safety
    const sanitized = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.config.baseDir, sanitized);
  }

  private getItemPath(userId: string, key: string): string {
    const userDir = this.getUserDir(userId);
    // Sanitize key for filesystem safety
    const sanitizedKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(userDir, `${sanitizedKey}.json`);
  }

  private getCacheKey(userId: string, key: string): string {
    return `${userId}:${key}`;
  }

  /**
   * Check if accessor can read owner's data.
   */
  private canRead(
    accessorId: string,
    item: DataItem,
  ): boolean {
    // Owner can always read
    if (accessorId === item.ownerId) return true;

    // Check explicit allowed readers list
    if (item.allowedReaders && item.allowedReaders.length > 0) {
      return item.allowedReaders.includes(accessorId);
    }

    // Fall back to general permission
    return item.allowOthersRead;
  }

  /**
   * Check if accessor can write owner's data.
   */
  private canWrite(
    accessorId: string,
    item: DataItem,
  ): boolean {
    // Owner can always write
    if (accessorId === item.ownerId) return true;

    return item.allowOthersWrite;
  }

  /**
   * Get the primary identifier from a SenderIdentity.
   */
  private getUserId(identity: SenderIdentity): string {
    return getPrimaryIdentifier(identity);
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Store data for a user.
   */
  set<T>(
    identity: SenderIdentity,
    key: string,
    value: T,
    options?: {
      category?: string;
      allowOthersRead?: boolean;
      allowOthersWrite?: boolean;
      allowedReaders?: string[];
    },
  ): void {
    const userId = this.getUserId(identity);
    const now = Date.now();

    const item: DataItem<T> = {
      key,
      value,
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
      category: options?.category,
      allowOthersRead: options?.allowOthersRead ?? this.config.defaultPermissions.allowOthersRead,
      allowOthersWrite: options?.allowOthersWrite ?? this.config.defaultPermissions.allowOthersWrite,
      allowedReaders: options?.allowedReaders,
    };

    // Check quota
    const userStats = this.getUserStats(userId);
    if (userStats.items >= this.config.maxItemsPerUser) {
      throw new StorageQuotaError(
        userId,
        this.config.maxItemsPerUser,
        userStats.items,
      );
    }

    // Persist to disk
    const itemPath = this.getItemPath(userId, key);
    const userDir = this.getUserDir(userId);

    if (!existsSync(userDir)) {
      mkdirSync(userDir, { recursive: true });
    }

    writeFileSync(itemPath, JSON.stringify(item, null, 2), "utf-8");

    // Update cache
    this.memoryCache.set(this.getCacheKey(userId, key), item as DataItem);
  }

  /**
   * Retrieve data with cross-user access control.
   */
  get<T>(accessor: SenderIdentity, ownerIdOrKey: string, key?: string): T | undefined {
    let ownerId: string;
    let dataKey: string;

    if (key === undefined) {
      // Assume owner is accessing their own data
      ownerId = this.getUserId(accessor);
      dataKey = ownerIdOrKey;
    } else {
      // Explicit owner specified
      ownerId = ownerIdOrKey;
      dataKey = key;
    }

    const accessorId = this.getUserId(accessor);
    const cacheKey = this.getCacheKey(ownerId, dataKey);

    // Try cache first
    let item = this.memoryCache.get(cacheKey) as DataItem<T> | undefined;

    // Load from disk if not in cache
    if (!item) {
      const itemPath = this.getItemPath(ownerId, dataKey);
      if (existsSync(itemPath)) {
        try {
          const content = readFileSync(itemPath, "utf-8");
          item = JSON.parse(content) as DataItem<T>;
          this.memoryCache.set(cacheKey, item as DataItem);
        } catch {
          return undefined;
        }
      }
    }

    if (!item) return undefined;

    // Check access
    if (!this.canRead(accessorId, item)) {
      throw new CrossUserAccessError(accessorId, ownerId, dataKey, "read");
    }

    return item.value;
  }

  /**
   * Delete data with access control.
   */
  delete(accessor: SenderIdentity, key: string): boolean {
    const accessorId = this.getUserId(accessor);
    const itemPath = this.getItemPath(accessorId, key);

    // Check if exists and can delete
    if (!existsSync(itemPath)) return false;

    try {
      const content = readFileSync(itemPath, "utf-8");
      const item = JSON.parse(content) as DataItem;

      // Owner can delete, others cannot delete even with write permission
      if (accessorId !== item.ownerId) {
        throw new CrossUserAccessError(accessorId, item.ownerId, key, "delete");
      }

      // Actually delete
      const fs = require("node:fs");
      fs.unlinkSync(itemPath);

      // Remove from cache
      this.memoryCache.delete(this.getCacheKey(accessorId, key));

      return true;
    } catch (err) {
      if (err instanceof CrossUserAccessError) throw err;
      return false;
    }
  }

  /**
   * List keys for a user (own data only).
   */
  listKeys(identity: SenderIdentity, category?: string): string[] {
    const userId = this.getUserId(identity);
    const userDir = this.getUserDir(userId);

    if (!existsSync(userDir)) return [];

    const keys: string[] = [];

    for (const file of readdirSync(userDir)) {
      if (!file.endsWith(".json")) continue;

      const key = file.slice(0, -5); // Remove .json

      if (category) {
        // Load and check category
        try {
          const content = readFileSync(join(userDir, file), "utf-8");
          const item = JSON.parse(content) as DataItem;
          if (item.category === category) {
            keys.push(key);
          }
        } catch {
          // Skip invalid files
        }
      } else {
        keys.push(key);
      }
    }

    return keys;
  }

  /**
   * Check if data exists (without loading).
   */
  has(identity: SenderIdentity, key: string): boolean {
    const userId = this.getUserId(identity);
    const itemPath = this.getItemPath(userId, key);
    return existsSync(itemPath);
  }

  /**
   * Get statistics for a user.
   */
  private getUserStats(userId: string): { items: number; sizeBytes: number } {
    const userDir = this.getUserDir(userId);

    if (!existsSync(userDir)) {
      return { items: 0, sizeBytes: 0 };
    }

    let items = 0;
    let sizeBytes = 0;

    for (const file of readdirSync(userDir)) {
      if (!file.endsWith(".json")) continue;

      const stat = require("node:fs").statSync(join(userDir, file));
      items++;
      sizeBytes += stat.size;
    }

    return { items, sizeBytes };
  }

  /**
   * Get storage statistics.
   */
  getStats(): StorageStats {
    const perUser = new Map<string, { items: number; sizeBytes: number }>();
    let totalItems = 0;
    let totalSizeBytes = 0;

    if (existsSync(this.config.baseDir)) {
      for (const userDir of readdirSync(this.config.baseDir)) {
        const stats = this.getUserStats(userDir);
        perUser.set(userDir, stats);
        totalItems += stats.items;
        totalSizeBytes += stats.sizeBytes;
      }
    }

    return {
      totalUsers: perUser.size,
      totalItems,
      totalSizeBytes,
      perUser,
    };
  }

  /**
   * Grant read access to specific users.
   */
  grantReadAccess(
    owner: SenderIdentity,
    key: string,
    readers: string[],
  ): boolean {
    const ownerId = this.getUserId(owner);
    const itemPath = this.getItemPath(ownerId, key);

    if (!existsSync(itemPath)) return false;

    try {
      const content = readFileSync(itemPath, "utf-8");
      const item = JSON.parse(content) as DataItem;

      // Only owner can grant access
      if (ownerId !== item.ownerId) {
        throw new CrossUserAccessError(ownerId, item.ownerId, key, "write");
      }

      item.allowedReaders = [...new Set([...(item.allowedReaders || []), ...readers])];
      item.updatedAt = Date.now();

      writeFileSync(itemPath, JSON.stringify(item, null, 2), "utf-8");
      this.memoryCache.set(this.getCacheKey(ownerId, key), item);

      return true;
    } catch (err) {
      if (err instanceof CrossUserAccessError) throw err;
      return false;
    }
  }

  /**
   * Revoke read access from specific users.
   */
  revokeReadAccess(
    owner: SenderIdentity,
    key: string,
    readers: string[],
  ): boolean {
    const ownerId = this.getUserId(owner);
    const itemPath = this.getItemPath(ownerId, key);

    if (!existsSync(itemPath)) return false;

    try {
      const content = readFileSync(itemPath, "utf-8");
      const item = JSON.parse(content) as DataItem;

      // Only owner can revoke access
      if (ownerId !== item.ownerId) {
        throw new CrossUserAccessError(ownerId, item.ownerId, key, "write");
      }

      if (item.allowedReaders) {
        item.allowedReaders = item.allowedReaders.filter(
          (r) => !readers.includes(r),
        );
        item.updatedAt = Date.now();

        writeFileSync(itemPath, JSON.stringify(item, null, 2), "utf-8");
        this.memoryCache.set(this.getCacheKey(ownerId, key), item);
      }

      return true;
    } catch (err) {
      if (err instanceof CrossUserAccessError) throw err;
      return false;
    }
  }
}
