import { MockProvider } from './MockProvider.js';
import { UpstoxProvider } from './upstox/UpstoxProvider.js';

// Register new brokers here (Angel One, Fyers, Dhan...). Each must extend BaseProvider.
const registry = {
  mock: (env) => new MockProvider({ lotSize: env.niftyLotSize }),
  upstox: (env) => new UpstoxProvider(env.upstox),
};

export function createProvider(env) {
  const make = registry[env.provider];
  if (!make) throw new Error(`Unknown MARKET_DATA_PROVIDER "${env.provider}". Use one of: ${Object.keys(registry).join(', ')}`);
  return make(env);
}
