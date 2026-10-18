import { z } from "zod";
import { assert } from "./model.ts";
import type { Lease } from "./resources.ts";
import type { TeamService } from "./service.ts";

/**
 * Lock reconciliation after a crash, restart or ownership transfer.
 *
 * Leases used to be released unconditionally at startup. That is only safe when every process that
 * could still be writing is gone. A crashed or force-quit backend can leave its provider CLI
 * running, and a slow shutdown can overlap the next backend, so we now keep a lease **draining**
 * while the backend that granted it (`ownerPid`) or a provider process registered through
 * `ResourceCoordinator.attachProcess` still exists:
 *   - the lease keeps conflicting with every overlapping request, including a resume of its own
 *     task, so a second writer cannot start;
 *   - `ResourceCoordinator.release` defers while a registered process is alive (a task moving to
 *     `interrupted` during recovery therefore does not free it);
 *   - `sweep()` (scheduler tick) releases it once every registered process has exited;
 *   - ownership transfers (`TeamService.control`) are refused for an agent with a draining lease;
 *   - the user can force-release after confirming the process is gone (recorded as an event).
 * Limits: only direct-CLI providers and the ACP adapter register processes; a recycled process id
 * keeps a lease draining until that id exits (use the explicit force release).
 */
export const forceReleaseSchema = z
  .object({
    /** The user confirms no provider process is still writing in the leased paths. */
    confirmStopped: z.literal(true),
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export class LockRecovery {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  private get res() {
    return this.service.resources;
  }
  /** Startup/idempotent: free leases of dead processes, keep and flag the rest as draining. */
  reconcile() {
    const released: string[] = [],
      draining: { id: string; pids: number[]; reason: string }[] = [];
    for (const lease of this.store.list<Lease>("lease")) {
      const live = this.res.livePids(lease);
      if (!live.length) {
        this.store.remove("lease", lease.id);
        this.store.emit("resource.released", lease.id, { recovered: true });
        released.push(lease.id);
        continue;
      }
      const owner =
        lease.ownerPid && live.includes(lease.ownerPid)
          ? `backend process ${lease.ownerPid} that granted it is still running`
          : `provider process ${live.join(", ")} may still be writing`;
      const keep: Lease = {
        ...lease,
        draining: lease.draining ?? {
          since: new Date().toISOString(),
          reason: owner,
        },
      };
      if (!lease.draining) {
        this.store.put("lease", keep);
        this.store.emit("resource.draining", lease.id, {
          pids: live,
          reason: keep.draining!.reason,
        });
      }
      draining.push({
        id: lease.id,
        pids: live,
        reason: keep.draining!.reason,
      });
    }
    return { released, draining };
  }
  /** Release draining leases whose processes have exited. */
  sweep() {
    const released: string[] = [];
    for (const lease of this.store.list<Lease>("lease"))
      if (lease.draining && !this.res.livePids(lease).length) {
        this.store.remove("lease", lease.id);
        this.store.emit("resource.released", lease.id, { drained: true });
        released.push(lease.id);
      }
    return released;
  }
  /** Explicit override: the user says the process is gone (or accepts the risk of two writers). */
  forceRelease(id: string, input: unknown) {
    const data = forceReleaseSchema.parse(input);
    const lease = this.store.list<Lease>("lease").find((l) => l.id === id);
    assert(lease, "not_found", "No such lease", 404);
    this.store.emit("resource.force_released", id, {
      reason: data.reason,
      livePids: this.res.livePids(lease),
    });
    this.res.release(id, true);
    return { released: id };
  }
  /** Leases still draining, with the live process ids, for the Resources view. */
  view() {
    return this.store
      .list<Lease>("lease")
      .filter((l) => l.draining)
      .map((l) => ({
        id: l.id,
        agentId: l.agentId,
        paths: l.paths,
        since: l.draining!.since,
        reason: l.draining!.reason,
        livePids: this.res.livePids(l),
      }));
  }
}
