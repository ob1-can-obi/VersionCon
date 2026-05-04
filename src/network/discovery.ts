import { Bonjour, type Service } from 'bonjour-service';

/** mDNS service type for VersionCon sessions. */
const SERVICE_TYPE = 'versioncon';

/** How long to browse for sessions before timing out (ms). */
const BROWSE_TIMEOUT_MS = 10_000;

/**
 * A session discovered via mDNS on the local network.
 */
export interface DiscoveredSession {
  name: string;
  host: string;
  port: number;
}

/**
 * Manages mDNS service publication and discovery for LAN sessions (NET-07).
 *
 * mDNS is ADDITIVE — the manual IP join path is the primary connection method.
 * mDNS makes LAN sessions conveniently discoverable but the extension works
 * without it. All mDNS operations gracefully degrade when multicast is
 * unavailable (corporate VLANs, firewalled networks).
 *
 * Threat model:
 * - T-01-09 (Spoofing): Accepted — mDNS sessions are convenience hints only.
 *   Actual authentication happens via invite code at connection time.
 * - T-01-10 (Information Disclosure): Accepted — session name + port visible
 *   on LAN by design. No sensitive data in mDNS TXT records.
 */
export class DiscoveryManager {
  private bonjour: Bonjour | null = null;
  private publishedService: Service | null = null;
  private browseTimer: ReturnType<typeof setTimeout> | null = null;
  private browser: ReturnType<Bonjour['find']> | null = null;

  /**
   * Lazily initialize the Bonjour instance.
   *
   * Returns null if bonjour-service fails to initialize (e.g., no
   * multicast support on the network). This is expected in many
   * corporate/university environments.
   */
  private initBonjour(): Bonjour | null {
    if (this.bonjour) {
      return this.bonjour;
    }
    try {
      this.bonjour = new Bonjour();
      return this.bonjour;
    } catch (err) {
      console.warn(
        '[VersionCon] mDNS unavailable — LAN discovery disabled. Manual IP join still works.',
        err
      );
      return null;
    }
  }

  /**
   * Publish this session on the local network via mDNS.
   *
   * @param name - Session name to advertise
   * @param port - Port the session is listening on
   * @returns true if published successfully, false if mDNS unavailable
   */
  publishSession(name: string, port: number): boolean {
    const bonjourInstance = this.initBonjour();
    if (!bonjourInstance) {
      return false;
    }

    try {
      // Unpublish any existing service first
      if (this.publishedService) {
        this.publishedService.stop?.();
        this.publishedService = null;
      }

      this.publishedService = bonjourInstance.publish({
        name,
        type: SERVICE_TYPE,
        port,
        txt: { version: '1' },
      });
      return true;
    } catch (err) {
      console.warn('[VersionCon] Failed to publish mDNS service:', err);
      return false;
    }
  }

  /**
   * Browse for VersionCon sessions on the local network.
   *
   * Calls onFound for each discovered session. If no sessions are found
   * within BROWSE_TIMEOUT_MS, calls onTimeout (if provided).
   *
   * If mDNS is unavailable, immediately calls onTimeout.
   *
   * @param onFound - Callback invoked for each discovered session
   * @param onTimeout - Optional callback invoked when browsing times out
   */
  browseSessions(
    onFound: (session: DiscoveredSession) => void,
    onTimeout?: () => void
  ): void {
    const bonjourInstance = this.initBonjour();
    if (!bonjourInstance) {
      // mDNS unavailable — immediately signal timeout
      if (onTimeout) {
        onTimeout();
      }
      return;
    }

    try {
      this.browser = bonjourInstance.find(
        { type: SERVICE_TYPE },
        (service: Service) => {
          const host =
            service.host || (service.addresses && service.addresses[0]) || '';
          onFound({
            name: service.name,
            host,
            port: service.port,
          });
        }
      );

      // Set browse timeout
      this.browseTimer = setTimeout(() => {
        this.stopBrowsing();
        if (onTimeout) {
          onTimeout();
        }
      }, BROWSE_TIMEOUT_MS);
    } catch (err) {
      console.warn('[VersionCon] Failed to browse mDNS services:', err);
      if (onTimeout) {
        onTimeout();
      }
    }
  }

  /**
   * Stop the active browse operation.
   */
  stopBrowsing(): void {
    if (this.browseTimer) {
      clearTimeout(this.browseTimer);
      this.browseTimer = null;
    }
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
  }

  /**
   * Unpublish the currently published session.
   */
  unpublish(): void {
    if (this.publishedService) {
      this.publishedService.stop?.();
      this.publishedService = null;
    }
  }

  /**
   * Clean up all mDNS resources.
   *
   * Should be called when the extension is deactivated or the session ends.
   */
  dispose(): void {
    this.unpublish();
    this.stopBrowsing();
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }
}
