import {newId} from '../core/ids.js';
import type {ApprovalRequest} from '../tools/types.js';

interface PendingApproval {
  id: string;
  request: ApprovalRequest;
  createdAt: string;
  expiresAt: number;
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

/** Bridges agent approval requests to HTTP clients (SSE event + POST decision). */
export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();

  createWithId(request: ApprovalRequest, timeoutMs = 120_000): {id: string; promise: Promise<boolean>} {
    const id = newId('appr');
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {id, request, createdAt: new Date().toISOString(), expiresAt: Date.now() + timeoutMs, resolve, timer});
    });
    return {id, promise};
  }

  resolve(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(approved);
    return true;
  }

  list(): Array<{id: string; tool: string; risk: string; summary: string; createdAt: string; expiresAt: number}> {
    return [...this.pending.values()].map((entry) => ({
      id: entry.id,
      tool: entry.request.tool,
      risk: entry.request.risk,
      summary: entry.request.summary,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    }));
  }

  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(false);
      this.pending.delete(id);
    }
  }
}
