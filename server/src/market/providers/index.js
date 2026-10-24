import { MockProvider } from './MockProvider.js';
import { UpstoxProvider } from './upstox/UpstoxProvider.js';
import { AngelOneProvider } from './angelone/AngelOneProvider.js';

// Register new brokers here (Fyers, Dhan...). Each must extend BaseProvider.
const registry = {
  mock: (env) => new MockProvider(),
  upstox: (env) => new UpstoxProvider(env.upstox),
  angelone: (env) => new AngelOneProvider(env.angelone),
};

export function createProvider(env) {
  const make = registry[env.provider];
  if (!make) throw new Error(`Unknown MARKET_DATA_PROVIDER "${env.provider}". Use one of: ${Object.keys(registry).join(', ')}`);
  return make(env);
}
