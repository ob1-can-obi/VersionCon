import type { ConnectionStatus } from '../types/session.js';

/**
 * Events that drive connection state transitions.
 */
export type ConnectionEvent =
  | 'connect'
  | 'disconnect'
  | 'reconnect-start'
  | 'reconnect-success'
  | 'reconnect-fail';

/** Listener for connection status changes. */
type StatusChangeListener = (status: ConnectionStatus) => void;

/**
 * Deterministic connection state machine with three states (NET-05, D-10):
 *
 *   disconnected  --[connect]--> connected
 *   connected     --[drop]-----> reconnecting
 *   connected     --[close]----> disconnected
 *   reconnecting  --[success]--> connected
 *   reconnecting  --[fail]-----> disconnected
 *
 * Invalid transitions are silently rejected (return false).
 */
export class ConnectionStateMachine {
  private status: ConnectionStatus = 'disconnected';
  private readonly listeners: Set<StatusChangeListener> = new Set();

  /** Valid transitions from each state. */
  private static readonly TRANSITIONS: Record<
    ConnectionStatus,
    readonly ConnectionStatus[]
  > = {
    disconnected: ['connected'],
    connected: ['reconnecting', 'disconnected'],
    reconnecting: ['connected', 'disconnected'],
  };

  /** Current connection status. */
  get current(): ConnectionStatus {
    return this.status;
  }

  /**
   * Attempt a state transition.
   *
   * @param to - The target state
   * @returns true if the transition was valid and applied, false otherwise
   */
  transition(to: ConnectionStatus): boolean {
    const allowed = ConnectionStateMachine.TRANSITIONS[this.status];
    if (!allowed.includes(to)) {
      return false;
    }

    this.status = to;
    for (const listener of this.listeners) {
      try {
        listener(this.status);
      } catch {
        // Listener errors must not break the state machine
      }
    }
    return true;
  }

  /**
   * Subscribe to status changes.
   *
   * @param listener - Called whenever the status changes
   * @returns An unsubscribe function
   */
  onStatusChange(listener: StatusChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reset the state machine to 'disconnected'. */
  reset(): void {
    this.status = 'disconnected';
  }
}
