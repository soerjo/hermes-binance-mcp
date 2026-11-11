/** Shared Binance response types (only the fields we actually read). */

export type BinanceKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote volume
  number, // trades
  string, // taker buy base
  string, // taker buy quote
  string, // ignore
];

export interface Ticker24hr {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string;
  quoteVolume: string;
  [key: string]: unknown;
}

export interface BookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  [key: string]: unknown;
}

export interface MarkPrice {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice?: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate?: string;
  time: number;
  [key: string]: unknown;
}

export interface ExchangeFilter {
  filterType: string;
  [key: string]: unknown;
}

export interface SymbolInfo {
  symbol: string;
  pair: string;
  contractType: string;
  status: string;
  filters: ExchangeFilter[];
  [key: string]: unknown;
}

export interface ExchangeInfo {
  symbols: SymbolInfo[];
  [key: string]: unknown;
}

export interface AccountAsset {
  asset: string;
  walletBalance: string;
  availableBalance: string;
  unrealizedProfit: string;
  initialMargin: string;
  [key: string]: unknown;
}

export interface AccountPosition {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  positionSide: string;
  marginType?: string;
  initialMargin?: string;
  [key: string]: unknown;
}

export interface AccountInfo {
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  totalMarginBalance: string;
  availableBalance: string;
  canTrade: boolean;
  assets: AccountAsset[];
  positions: AccountPosition[];
  [key: string]: unknown;
}

export interface PositionRisk {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage: string;
  positionSide: string;
  marginType?: string;
  initialMargin?: string;
  isolatedWallet?: string;
  positionInitialMargin?: string;
  [key: string]: unknown;
}

export interface AlgoOrder {
  algoId: number;
  symbol: string;
  orderType: string;
  side: string;
  quantity?: string;
  triggerPrice?: string;
  [key: string]: unknown;
}

export interface IncomeRecord {
  symbol: string;
  incomeType: string;
  income: string;
  asset: string;
  time: number;
  tranId?: number | string;
  [key: string]: unknown;
}

export interface SpotBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface SpotAccount {
  accountType: string;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  balances: SpotBalance[];
  [key: string]: unknown;
}

export interface SpotOrder {
  symbol: string;
  orderId: number;
  clientOrderId?: string;
  price: string;
  origQty: string;
  executedQty: string;
  status: string;
  type: string;
  side: string;
  timeInForce?: string;
  time?: number;
  [key: string]: unknown;
}

export type OrderParams = Record<string, string | number | boolean | null | undefined>;
