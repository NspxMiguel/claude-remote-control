/**
 * The agents this app can drive. Each driver implements the contract in
 * ./README.md; the session layer above them is agent-agnostic.
 */
import * as claudeCode from './claude-code.js';
import * as antigravity from './antigravity.js';

export const DRIVERS = [claudeCode, antigravity];

export const DEFAULT_DRIVER = claudeCode.id;

export function getDriver(driverId) {
  return DRIVERS.find((d) => d.id === (driverId || DEFAULT_DRIVER)) || null;
}

/**
 * Which agents are actually usable on this machine right now. Detection never
 * throws: a driver whose binary is missing reports itself unavailable with the
 * command that would install it, and the UI simply does not offer it.
 */
export async function detectDrivers(config = {}) {
  return Promise.all(
    DRIVERS.map(async (driver) => {
      let status;
      try {
        status = await driver.detect(config);
      } catch (err) {
        status = { available: false, detail: err?.message || 'detection failed' };
      }
      const { describeCredential } = await import('../credentials.js');
      const { canSignIn } = await import('../login.js');
      return {
        id: driver.id,
        label: driver.label,
        capabilities: driver.capabilities,
        ...status,
        credential: describeCredential(config, driver.id),
        canSignIn: canSignIn(driver.id),
      };
    }),
  );
}
