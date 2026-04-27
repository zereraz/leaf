/**
 * consent.ts — cross-user data access consent management.
 *
 * When User B requests User A's data, User A must approve before access is granted.
 */

import type { SenderIdentity } from "./sender-identity.js";
import { getPrimaryIdentifier } from "./sender-identity.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type ConsentStatus = "pending" | "approved" | "denied" | "expired";

export interface ConsentRequest {
  /** Unique ID for this consent request */
  id: string;
  /** User requesting access */
  requesterId: string;
  /** User whose data is being requested */
  ownerId: string;
  /** What data is being requested (human readable) */
  dataDescription: string;
  /** Status of the request */
  status: ConsentStatus;
  /** When the request was created */
  createdAt: number;
  /** When the request expires (if not approved) */
  expiresAt: number;
  /** When the request was responded to */
  respondedAt?: number;
  /** Notification callback for the owner */
  notifyOwner?: () => Promise<void>;
}

export interface ConsentConfig {
  /** How long consent requests are valid (ms) */
  expiryMs: number;
  /** Whether to auto-deny expired requests */
  autoDenyExpired: boolean;
  /** Maximum pending requests per owner */
  maxPendingPerOwner: number;
  /** Callback when consent is requested */
  onConsentRequested?: (request: ConsentRequest) => Promise<void>;
  /** Callback when consent is responded to */
  onConsentResponded?: (request: ConsentRequest) => Promise<void>;
}

export const DEFAULT_CONSENT_CONFIG: ConsentConfig = {
  expiryMs: 5 * 60 * 1000, // 5 minutes
  autoDenyExpired: true,
  maxPendingPerOwner: 10,
};

// ── Consent Manager ────────────────────────────────────────────────────────

class ConsentManager {
  private requests: Map<string, ConsentRequest> = new Map();
  private ownerPending: Map<string, Set<string>> = new Map();
  private config: ConsentConfig;

  constructor(config: Partial<ConsentConfig> = {}) {
    this.config = { ...DEFAULT_CONSENT_CONFIG, ...config };
    this.startExpiryChecker();
  }

  private startExpiryChecker(): void {
    setInterval(() => this.checkExpired(), 30 * 1000); // Check every 30s
  }

  private checkExpired(): void {
    const now = Date.now();

    for (const [id, request] of this.requests) {
      if (request.status === "pending" && now > request.expiresAt) {
        request.status = "expired";
        request.respondedAt = now;
        this.removeFromOwnerPending(request.ownerId, id);

        if (this.config.autoDenyExpired) {
          console.log(`[consent] Request ${id} expired for ${request.requesterId} -> ${request.ownerId}`);
        }
      }
    }
  }

  private removeFromOwnerPending(ownerId: string, requestId: string): void {
    const pending = this.ownerPending.get(ownerId);
    if (pending) {
      pending.delete(requestId);
      if (pending.size === 0) {
        this.ownerPending.delete(ownerId);
      }
    }
  }

  /**
   * Request consent to access another user's data.
   */
  async requestConsent(
    requester: SenderIdentity,
    owner: SenderIdentity,
    dataDescription: string,
  ): Promise<ConsentRequest> {
    const requesterId = getPrimaryIdentifier(requester);
    const ownerId = getPrimaryIdentifier(owner);

    // Check if there's already a pending request
    const existing = this.findPendingRequest(requesterId, ownerId, dataDescription);
    if (existing) {
      return existing;
    }

    // Check pending limit
    const ownerPending = this.ownerPending.get(ownerId);
    if (ownerPending && ownerPending.size >= this.config.maxPendingPerOwner) {
      throw new ConsentError(`Too many pending requests for ${ownerId}`);
    }

    const request: ConsentRequest = {
      id: this.generateId(),
      requesterId,
      ownerId,
      dataDescription,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.expiryMs,
    };

    this.requests.set(request.id, request);

    // Track for owner
    if (!this.ownerPending.has(ownerId)) {
      this.ownerPending.set(ownerId, new Set());
    }
    this.ownerPending.get(ownerId)!.add(request.id);

    // Notify
    await this.config.onConsentRequested?.(request);

    console.log(`[consent] Request ${request.id}: ${requesterId} wants to access ${ownerId}'s ${dataDescription}`);

    return request;
  }

  /**
   * Respond to a consent request.
   */
  async respond(
    owner: SenderIdentity,
    requestId: string,
    approved: boolean,
  ): Promise<ConsentRequest> {
    const ownerId = getPrimaryIdentifier(owner);
    const request = this.requests.get(requestId);

    if (!request) {
      throw new ConsentError(`Request ${requestId} not found`);
    }

    if (request.ownerId !== ownerId) {
      throw new ConsentError(`Not authorized to respond to this request`);
    }

    if (request.status !== "pending") {
      throw new ConsentError(`Request is already ${request.status}`);
    }

    request.status = approved ? "approved" : "denied";
    request.respondedAt = Date.now();

    this.removeFromOwnerPending(ownerId, requestId);
    await this.config.onConsentResponded?.(request);

    console.log(`[consent] Request ${requestId} ${request.status} by ${ownerId}`);

    return request;
  }

  /**
   * Check if consent exists for a data access.
   */
  hasConsent(requesterId: string, ownerId: string, dataDescription: string): boolean {
    // Check for any approved request matching this access
    for (const request of this.requests.values()) {
      if (
        request.requesterId === requesterId &&
        request.ownerId === ownerId &&
        request.status === "approved" &&
        (dataDescription.includes(request.dataDescription) ||
         request.dataDescription.includes(dataDescription))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get pending requests for an owner.
   */
  getPendingRequests(owner: SenderIdentity): ConsentRequest[] {
    const ownerId = getPrimaryIdentifier(owner);
    const pendingIds = this.ownerPending.get(ownerId);

    if (!pendingIds) return [];

    return Array.from(pendingIds)
      .map(id => this.requests.get(id))
      .filter((r): r is ConsentRequest => r !== undefined && r.status === "pending");
  }

  /**
   * Get a specific request.
   */
  getRequest(requestId: string): ConsentRequest | undefined {
    return this.requests.get(requestId);
  }

  private findPendingRequest(
    requesterId: string,
    ownerId: string,
    dataDescription: string,
  ): ConsentRequest | undefined {
    for (const request of this.requests.values()) {
      if (
        request.requesterId === requesterId &&
        request.ownerId === ownerId &&
        request.status === "pending" &&
        request.dataDescription === dataDescription
      ) {
        return request;
      }
    }
    return undefined;
  }

  private generateId(): string {
    return `consent_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

// ── Error Class ────────────────────────────────────────────────────────────

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsentError";
  }
}

// ── Singleton Instance ─────────────────────────────────────────────────────

let globalConsentManager: ConsentManager | null = null;

export function getConsentManager(config?: Partial<ConsentConfig>): ConsentManager {
  if (!globalConsentManager) {
    globalConsentManager = new ConsentManager(config);
  }
  return globalConsentManager;
}

export function resetConsentManager(): void {
  globalConsentManager = null;
}

// ── Convenience Functions ──────────────────────────────────────────────────

/**
 * Request consent for cross-user data access.
 * Returns the consent request - caller should wait for approval.
 */
export async function requestDataAccessConsent(
  requester: SenderIdentity,
  owner: SenderIdentity,
  dataDescription: string,
  config?: Partial<ConsentConfig>,
): Promise<ConsentRequest> {
  const manager = getConsentManager(config);
  return manager.requestConsent(requester, owner, dataDescription);
}

/**
 * Check if data access is consented.
 */
export function isDataAccessConsented(
  requesterId: string,
  ownerId: string,
  dataDescription: string,
): boolean {
  const manager = getConsentManager();
  return manager.hasConsent(requesterId, ownerId, dataDescription);
}

/**
 * Format consent request for display.
 */
export function formatConsentRequest(request: ConsentRequest): string {
  const timeLeft = Math.max(0, Math.floor((request.expiresAt - Date.now()) / 1000));
  const minutes = Math.floor(timeLeft / 60);
  const seconds = timeLeft % 60;

  return `
🔒 **Data Access Request**

${request.requesterId} wants to access:
**${request.dataDescription}**

Owned by: ${request.ownerId}
Time remaining: ${minutes}m ${seconds}s

Reply **approve ${request.id}** to allow
Reply **deny ${request.id}** to reject
`.trim();
}
