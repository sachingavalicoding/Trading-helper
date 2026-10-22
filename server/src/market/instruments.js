// Nifty 50 constituents. NSE rebalances the index twice a year (March and September),
// so check this list against https://www.niftyindices.com before relying on it.
// `seed` is only used by the MOCK feed as a starting point for simulated prices; it is not market data.
export const NIFTY50 = [
  { symbol: 'ADANIENT', name: 'Adani Enterprises', sector: 'Metals & Mining', seed: 2400 },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ', sector: 'Services', seed: 1400 },
  { symbol: 'APOLLOHOSP', name: 'Apollo Hospitals', sector: 'Healthcare', seed: 7500 },
  { symbol: 'ASIANPAINT', name: 'Asian Paints', sector: 'Consumer Durables', seed: 2400 },
  { symbol: 'AXISBANK', name: 'Axis Bank', sector: 'Financial Services', seed: 1150 },
  { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto', sector: 'Automobile', seed: 8500 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', sector: 'Financial Services', seed: 950 },
  { symbol: 'BAJAJFINSV', name: 'Bajaj Finserv', sector: 'Financial Services', seed: 2000 },
  { symbol: 'BEL', name: 'Bharat Electronics', sector: 'Capital Goods', seed: 400 },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', sector: 'Telecommunication', seed: 1900 },
  { symbol: 'CIPLA', name: 'Cipla', sector: 'Healthcare', seed: 1500 },
  { symbol: 'COALINDIA', name: 'Coal India', sector: 'Oil Gas & Fuels', seed: 390 },
  { symbol: 'DRREDDY', name: "Dr. Reddy's Laboratories", sector: 'Healthcare', seed: 1250 },
  { symbol: 'EICHERMOT', name: 'Eicher Motors', sector: 'Automobile', seed: 6500 },
  { symbol: 'ETERNAL', name: 'Eternal', sector: 'Consumer Services', seed: 320 },
  { symbol: 'GRASIM', name: 'Grasim Industries', sector: 'Construction Materials', seed: 2800 },
  { symbol: 'HCLTECH', name: 'HCL Technologies', sector: 'Information Technology', seed: 1500 },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', sector: 'Financial Services', seed: 980 },
  { symbol: 'HDFCLIFE', name: 'HDFC Life Insurance', sector: 'Financial Services', seed: 760 },
  { symbol: 'HINDALCO', name: 'Hindalco Industries', sector: 'Metals & Mining', seed: 750 },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever', sector: 'FMCG', seed: 2500 },
  { symbol: 'ICICIBANK', name: 'ICICI Bank', sector: 'Financial Services', seed: 1400 },
  { symbol: 'INDIGO', name: 'InterGlobe Aviation', sector: 'Services', seed: 5700 },
  { symbol: 'INFY', name: 'Infosys', sector: 'Information Technology', seed: 1500 },
  { symbol: 'ITC', name: 'ITC', sector: 'FMCG', seed: 410 },
  { symbol: 'JIOFIN', name: 'Jio Financial Services', sector: 'Financial Services', seed: 310 },
  { symbol: 'JSWSTEEL', name: 'JSW Steel', sector: 'Metals & Mining', seed: 1150 },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', sector: 'Financial Services', seed: 2100 },
  { symbol: 'LT', name: 'Larsen & Toubro', sector: 'Construction', seed: 3800 },
  { symbol: 'M&M', name: 'Mahindra & Mahindra', sector: 'Automobile', seed: 3500 },
  { symbol: 'MARUTI', name: 'Maruti Suzuki', sector: 'Automobile', seed: 16000 },
  { symbol: 'MAXHEALTH', name: 'Max Healthcare', sector: 'Healthcare', seed: 1150 },
  { symbol: 'NESTLEIND', name: 'Nestle India', sector: 'FMCG', seed: 1200 },
  { symbol: 'NTPC', name: 'NTPC', sector: 'Power', seed: 340 },
  { symbol: 'ONGC', name: 'Oil & Natural Gas Corp', sector: 'Oil Gas & Fuels', seed: 245 },
  { symbol: 'POWERGRID', name: 'Power Grid Corp', sector: 'Power', seed: 290 },
  { symbol: 'RELIANCE', name: 'Reliance Industries', sector: 'Oil Gas & Fuels', seed: 1400 },
  { symbol: 'SBILIFE', name: 'SBI Life Insurance', sector: 'Financial Services', seed: 1800 },
  { symbol: 'SBIN', name: 'State Bank of India', sector: 'Financial Services', seed: 870 },
  { symbol: 'SHRIRAMFIN', name: 'Shriram Finance', sector: 'Financial Services', seed: 650 },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', sector: 'Healthcare', seed: 1650 },
  { symbol: 'TATACONSUM', name: 'Tata Consumer Products', sector: 'FMCG', seed: 1120 },
  { symbol: 'TMPV', name: 'Tata Motors Passenger Vehicles', sector: 'Automobile', seed: 400 },
  { symbol: 'TATASTEEL', name: 'Tata Steel', sector: 'Metals & Mining', seed: 170 },
  { symbol: 'TCS', name: 'Tata Consultancy Services', sector: 'Information Technology', seed: 3100 },
  { symbol: 'TECHM', name: 'Tech Mahindra', sector: 'Information Technology', seed: 1450 },
  { symbol: 'TITAN', name: 'Titan Company', sector: 'Consumer Durables', seed: 3600 },
  { symbol: 'TRENT', name: 'Trent', sector: 'Consumer Services', seed: 4800 },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement', sector: 'Construction Materials', seed: 12000 },
  { symbol: 'WIPRO', name: 'Wipro', sector: 'Information Technology', seed: 245 },
];

// Indices shown in the header. Upstox keys are the documented NSE_INDEX/BSE_INDEX instrument keys.
// GIFT Nifty trades on NSE IX, which Upstox's feed does not carry, so it is omitted for Upstox.
export const INDICES = [
  { symbol: 'NIFTY 50', name: 'Nifty 50', upstoxKey: 'NSE_INDEX|Nifty 50', seed: 25000 },
  { symbol: 'NIFTY BANK', name: 'Bank Nifty', upstoxKey: 'NSE_INDEX|Nifty Bank', seed: 56000 },
  { symbol: 'SENSEX', name: 'Sensex', upstoxKey: 'BSE_INDEX|SENSEX', seed: 82000 },
];

const bySymbol = new Map(NIFTY50.map((s) => [s.symbol, s]));
const indexBySymbol = new Map(INDICES.map((s) => [s.symbol, s]));

export const isTradable = (symbol) => bySymbol.has(symbol);
export const getInstrument = (symbol) => bySymbol.get(symbol) || indexBySymbol.get(symbol) || null;
export const isIndex = (symbol) => indexBySymbol.has(symbol);
export const ALL_SYMBOLS = [...NIFTY50.map((s) => s.symbol), ...INDICES.map((s) => s.symbol)];
