const axios = require('axios');
const xml2js = require('xml2js');

const TELEGRAM_BOT_TOKEN = '8756381855:AAH1cjj2bogwVfl0tP5yRcRfX7lZHJFohdQ';
const TELEGRAM_CHAT_ID = '8173449171';
const CRYPTOCURRENCIES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA'];
const ANALYSIS_INTERVAL = 60 * 1000;

let userPositions = {};
let priceHistory = {};
let volumeHistory = {};
let rsiHistory = {};
let signalHistory = [];
let executedTrades = [];
let userStopLoss = 5;
let lastUpdateId = 0;
let isPolling = false;
let priceBase = {};
let lastNewsCheck = 0;
let cachedNews = {};
let pendingSignals = {}; // Para confirmaciones múltiples

CRYPTOCURRENCIES.forEach(crypto => {
  priceHistory[crypto] = [];
  volumeHistory[crypto] = [];
  rsiHistory[crypto] = [];
  priceBase[crypto] = null;
  cachedNews[crypto] = { positive: 0, negative: 0, headlines: [] };
  pendingSignals[crypto] = { buyCount: 0, sellCount: 0, lastBuyConfidence: 0, lastSellConfidence: 0 };
});

const BINANCE_SYMBOLS = {
  'BTC': 'BTCUSDT', 'ETH': 'ETHUSDT',
  'BNB': 'BNBUSDT', 'SOL': 'SOLUSDT',
  'XRP': 'XRPUSDT', 'ADA': 'ADAUSDT'
};

const NEWS_KEYWORDS = {
  'BTC': ['bitcoin', 'btc'],
  'ETH': ['ethereum', 'eth'],
  'BNB': ['binance', 'bnb'],
  'SOL': ['solana', 'sol'],
  'XRP': ['ripple', 'xrp'],
  'ADA': ['cardano', 'ada']
};

async function sendTelegramMessage(message, buttons = null) {
  try {
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    };
    if (buttons) {
      payload.reply_markup = { inline_keyboard: buttons };
    }
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload
    );
  } catch (error) {
    console.error('❌ Error enviando mensaje:', error.message);
  }
}

async function getCurrentPrice(crypto) {
  const symbol = BINANCE_SYMBOLS[crypto];
  const servers = [
    `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
    `https://api1.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`
  ];
  for (const url of servers) {
    try {
      const r = await axios.get(url, { timeout: 8000 });
      return {
        price: parseFloat(r.data.lastPrice),
        volume: parseFloat(r.data.volume),
        quoteVolume: parseFloat(r.data.quoteVolume),
        change24h: parseFloat(r.data.priceChangePercent),
        high24h: parseFloat(r.data.highPrice),
        low24h: parseFloat(r.data.lowPrice)
      };
    } catch (e) { continue; }
  }
  try {
    const r = await axios.get(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${crypto}&tsyms=USD`,
      { timeout: 10000 }
    );
    const d = r.data.RAW[crypto].USD;
    return {
      price: d.PRICE, volume: d.VOLUME24HOUR,
      quoteVolume: d.VOLUME24HOURTO, change24h: d.CHANGEPCT24HOUR,
      high24h: d.HIGH24HOUR, low24h: d.LOW24HOUR
    };
  } catch (e) {
    console.error(`❌ Error precio ${crypto}:`, e.message);
    return null;
  }
}

// ── 1. DETECCIÓN DE CAÍDA INMINENTE ──────────────────
async function detectImmediateDrop(crypto) {
  try {
    const symbol = BINANCE_SYMBOLS[crypto];
    const r = await axios.get(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`,
      { timeout: 8000 }
    );
    const bids = r.data.bids;
    const asks = r.data.asks;

    const totalBids = bids.reduce((s, b) => s + parseFloat(b[0]) * parseFloat(b[1]), 0);
    const totalAsks = asks.reduce((s, a) => s + parseFloat(a[0]) * parseFloat(a[1]), 0);
    const ratio = totalBids / (totalBids + totalAsks);

    // Detectar pared de venta masiva
    const bigAskWall = asks.some(a => parseFloat(a[1]) * parseFloat(a[0]) > totalBids * 0.3);

    return {
      dropRisk: ratio < 0.35 || bigAskWall,
      ratio,
      totalBids: (totalBids / 1000).toFixed(0) + 'K',
      totalAsks: (totalAsks / 1000).toFixed(0) + 'K',
      buyRatio: (ratio * 100).toFixed(0)
    };
  } catch (e) {
    return { dropRisk: false, ratio: 0.5, totalBids: '0', totalAsks: '0', buyRatio: '50' };
  }
}

// ── 2. ANÁLISIS ORDER BOOK + ZONAS TP/SL ─────────────
async function analyzeOrderBookZones(crypto, currentPrice) {
  try {
    const symbol = BINANCE_SYMBOLS[crypto];
    const r = await axios.get(
      `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`,
      { timeout: 8000 }
    );
    const bids = r.data.bids;
    const asks = r.data.asks;

    // Encontrar zona de soporte más fuerte (mayor volumen en bids)
    let maxBidVol = 0, supportZone = 0;
    for (const b of bids) {
      const vol = parseFloat(b[0]) * parseFloat(b[1]);
      if (vol > maxBidVol) { maxBidVol = vol; supportZone = parseFloat(b[0]); }
    }

    // Encontrar zona de resistencia más fuerte (mayor volumen en asks)
    let maxAskVol = 0, resistanceZone = 0;
    for (const a of asks) {
      const vol = parseFloat(a[0]) * parseFloat(a[1]);
      if (vol > maxAskVol) { maxAskVol = vol; resistanceZone = parseFloat(a[0]); }
    }

    const totalBids = bids.reduce((s, b) => s + parseFloat(b[0]) * parseFloat(b[1]), 0);
    const totalAsks = asks.reduce((s, a) => s + parseFloat(a[0]) * parseFloat(a[1]), 0);
    const ratio = totalBids / (totalBids + totalAsks);

    let buyStrength = 0, sellStrength = 0, obDesc = '';
    if (ratio >= 0.65) { buyStrength = 20; obDesc = `📊 Order Book: ${(ratio*100).toFixed(0)}% compradores`; }
    else if (ratio >= 0.55) { buyStrength = 10; obDesc = `📊 Order Book: más compradores`; }
    else if (ratio <= 0.35) { sellStrength = 20; obDesc = `📊 Order Book: ${((1-ratio)*100).toFixed(0)}% vendedores`; }
    else if (ratio <= 0.45) { sellStrength = 10; obDesc = `📊 Order Book: más vendedores`; }

    return {
      buyStrength, sellStrength, obDesc, ratio,
      supportZone: supportZone.toFixed(2),
      resistanceZone: resistanceZone.toFixed(2),
      supportVolume: (maxBidVol / 1000).toFixed(1) + 'K USD',
      resistanceVolume: (maxAskVol / 1000).toFixed(1) + 'K USD'
    };
  } catch (e) {
    return { buyStrength: 0, sellStrength: 0, obDesc: '', ratio: 0.5, supportZone: '0', resistanceZone: '0', supportVolume: '0', resistanceVolume: '0' };
  }
}

// ── 3. TENDENCIA MACRO 24H ────────────────────────────
function analyzeMacroTrend(change24h) {
  if (change24h <= -5) return { bearish: true, strength: 20, desc: `📉 Mercado bajista fuerte (-${Math.abs(change24h).toFixed(1)}% 24h)` };
  if (change24h <= -3) return { bearish: true, strength: 10, desc: `📉 Tendencia bajista (-${Math.abs(change24h).toFixed(1)}% 24h)` };
  if (change24h >= 5) return { bullish: true, strength: 20, desc: `📈 Mercado alcista fuerte (+${change24h.toFixed(1)}% 24h)` };
  if (change24h >= 3) return { bullish: true, strength: 10, desc: `📈 Tendencia alcista (+${change24h.toFixed(1)}% 24h)` };
  return { neutral: true, strength: 0, desc: '' };
}

// ── 4. VOLATILIDAD EXTREMA ────────────────────────────
function detectExtremeVolatility(prices) {
  if (prices.length < 10) return { extreme: false, desc: '' };
  const recent = prices.slice(-10);
  const max = Math.max(...recent);
  const min = Math.min(...recent);
  const volatility = ((max - min) / min) * 100;
  if (volatility >= 5) return { extreme: true, desc: `⚠️ Volatilidad extrema: ${volatility.toFixed(1)}% en 10 min` };
  if (volatility >= 3) return { extreme: true, desc: `⚠️ Alta volatilidad: ${volatility.toFixed(1)}% en 10 min` };
  return { extreme: false, desc: '' };
}

// ── 5. CVD + BALLENAS CON MONTO ──────────────────────
async function analyzeCVDAndWhales(crypto) {
  try {
    const symbol = BINANCE_SYMBOLS[crypto];
    const r = await axios.get(
      `https://api.binance.com/api/v3/trades?symbol=${symbol}&limit=200`,
      { timeout: 8000 }
    );
    const trades = r.data;

    let buyVolume = 0, sellVolume = 0;
    let bigBuys = [], bigSells = [];

    for (const trade of trades) {
      const vol = parseFloat(trade.qty) * parseFloat(trade.price);
      if (!trade.isBuyerMaker) {
        buyVolume += vol;
        if (vol > 50000) bigBuys.push(vol); // Compras > $50K = ballena
      } else {
        sellVolume += vol;
        if (vol > 50000) bigSells.push(vol); // Ventas > $50K = ballena
      }
    }

    const cvdPercent = (buyVolume / (buyVolume + sellVolume)) * 100;
    const totalWhaleBuys = bigBuys.reduce((a, b) => a + b, 0);
    const totalWhaleSells = bigSells.reduce((a, b) => a + b, 0);

    let buyStrength = 0, sellStrength = 0;
    let cvdDesc = '', whaleDesc = '';

    if (cvdPercent >= 65) { buyStrength += 20; cvdDesc = `💹 CVD: ${cvdPercent.toFixed(0)}% compradores`; }
    else if (cvdPercent >= 55) { buyStrength += 10; cvdDesc = `💹 CVD: compradores dominando`; }
    else if (cvdPercent <= 35) { sellStrength += 20; cvdDesc = `💹 CVD: ${(100-cvdPercent).toFixed(0)}% vendedores`; }
    else if (cvdPercent <= 45) { sellStrength += 10; cvdDesc = `💹 CVD: vendedores dominando`; }

    if (totalWhaleBuys > 0) {
      const whaleAmount = totalWhaleBuys >= 1000000
        ? `$${(totalWhaleBuys/1000000).toFixed(2)}M`
        : `$${(totalWhaleBuys/1000).toFixed(0)}K`;
      buyStrength += bigBuys.length >= 3 ? 30 : 15;
      whaleDesc = `🐋 ${bigBuys.length} ballena(s) comprando: ${whaleAmount} USD`;
    }

    if (totalWhaleSells > 0 && totalWhaleSells > totalWhaleBuys) {
      const whaleAmount = totalWhaleSells >= 1000000
        ? `$${(totalWhaleSells/1000000).toFixed(2)}M`
        : `$${(totalWhaleSells/1000).toFixed(0)}K`;
      sellStrength += bigSells.length >= 3 ? 30 : 15;
      whaleDesc = `🐋 ${bigSells.length} ballena(s) vendiendo: ${whaleAmount} USD`;
    }

    // Volumen general
    if (volumeHistory[crypto].length >= 5) {
      const avgVol = volumeHistory[crypto].slice(-5).reduce((a, b) => a + b) / 5;
      const currentVol = buyVolume + sellVolume;
      const volIncrease = ((currentVol - avgVol) / avgVol) * 100;
      if (volIncrease >= 300 && !whaleDesc) {
        buyStrength += 15;
        whaleDesc = `🐳 Volumen explosivo +${volIncrease.toFixed(0)}%`;
      }
    }

    return { buyStrength, sellStrength, cvdDesc, whaleDesc, cvdPercent, totalWhaleBuys, totalWhaleSells };
  } catch (e) {
    return { buyStrength: 0, sellStrength: 0, cvdDesc: '', whaleDesc: '', cvdPercent: 50, totalWhaleBuys: 0, totalWhaleSells: 0 };
  }
}

// ── 6. DIVERGENCIA RSI ────────────────────────────────
function analyzeRSIDivergence(prices, rsiValues) {
  if (prices.length < 5 || rsiValues.length < 5) return { bullish: false, bearish: false, desc: '' };
  const priceDir = prices[prices.length-1] - prices[prices.length-5];
  const rsiDir = rsiValues[rsiValues.length-1] - rsiValues[rsiValues.length-5];
  if (priceDir < 0 && rsiDir > 2) return { bullish: true, bearish: false, desc: '📈 Divergencia alcista RSI (señal potente)' };
  if (priceDir > 0 && rsiDir < -2) return { bullish: false, bearish: true, desc: '📉 Divergencia bajista RSI (señal potente)' };
  return { bullish: false, bearish: false, desc: '' };
}

async function fetchNews() {
  const now = Date.now();
  if (now - lastNewsCheck < 10 * 60 * 1000) return;
  lastNewsCheck = now;

  const feeds = ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'https://cointelegraph.com/rss'];
  const positiveWords = ['surge', 'rally', 'bullish', 'adoption', 'approved', 'partnership', 'growth', 'record', 'high', 'gain', 'rises', 'jumps'];
  const negativeWords = ['crash', 'bearish', 'ban', 'hack', 'fraud', 'dump', 'fall', 'drop', 'sell', 'fear', 'warning', 'loss'];

  CRYPTOCURRENCIES.forEach(crypto => {
    cachedNews[crypto] = { positive: 0, negative: 0, headlines: [] };
  });

  for (const feedUrl of feeds) {
    try {
      const response = await axios.get(feedUrl, { timeout: 8000 });
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(response.data);
      const items = result.rss.channel[0].item || [];

      for (const item of items.slice(0, 20)) {
        const title = (item.title?.[0] || '').toLowerCase();
        const desc = (item.description?.[0] || '').toLowerCase();
        const content = `${title} ${desc}`;

        for (const crypto of CRYPTOCURRENCIES) {
          if (NEWS_KEYWORDS[crypto].some(kw => content.includes(kw))) {
            const posScore = positiveWords.filter(w => content.includes(w)).length;
            const negScore = negativeWords.filter(w => content.includes(w)).length;
            if (posScore > negScore) {
              cachedNews[crypto].positive += posScore;
              if (cachedNews[crypto].headlines.length < 1)
                cachedNews[crypto].headlines.push(`📰 ${item.title?.[0]?.substring(0, 55)}...`);
            } else if (negScore > posScore) {
              cachedNews[crypto].negative += negScore;
            }
          }
        }
      }
    } catch (e) { console.log('News error:', e.message); }
  }
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const rs = (gains / period) / ((losses / period) || 1);
  return 100 - (100 / (1 + rs));
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;
  const recent = prices.slice(-period);
  const sma = recent.reduce((a, b) => a + b) / period;
  const variance = recent.reduce((s, p) => s + Math.pow(p - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + std * stdDev, middle: sma, lower: sma - std * stdDev };
}

function calculateMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b) / period;
}

function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;
  return ((prices[prices.length-1] - prices[prices.length-1-period]) / prices[prices.length-1-period]) * 100;
}

function detectLocalExtremes(prices, window = 3) {
  if (prices.length < window * 2 + 1) return { localMax: false, localMin: false };
  const last = prices.length - 1;
  const cur = prices[last];
  let isMax = true, isMin = true;
  for (let i = Math.max(0, last-window); i <= Math.min(prices.length-1, last+window); i++) {
    if (i !== last) {
      if (prices[i] >= cur) isMax = false;
      if (prices[i] <= cur) isMin = false;
    }
  }
  return { localMax: isMax && last > window, localMin: isMin && last > window };
}

function getAccumulatedChange(crypto, currentPrice) {
  if (!priceBase[crypto]) { priceBase[crypto] = currentPrice; return 0; }
  return ((currentPrice - priceBase[crypto]) / priceBase[crypto]) * 100;
}

function getSignalLevel(confidence) {
  if (confidence >= 90) return { emoji: '🔴', nivel: 'FUERTE' };
  if (confidence >= 80) return { emoji: '🟠', nivel: 'BUENA' };
  return { emoji: '🟡', nivel: 'MODERADA' }; // No se usa, solo 3 niveles desde 80%
}

async function analyzeCrypto(crypto) {
  const priceData = await getCurrentPrice(crypto);
  if (!priceData) return null;
  const { price: currentPrice, volume: currentVolume, change24h, high24h, low24h } = priceData;

  priceHistory[crypto].push(currentPrice);
  if (priceHistory[crypto].length > 100) priceHistory[crypto].shift();
  volumeHistory[crypto].push(currentVolume);
  if (volumeHistory[crypto].length > 20) volumeHistory[crypto].shift();

  const prices = priceHistory[crypto];
  const rsi = calculateRSI(prices);
  if (rsi !== null) {
    rsiHistory[crypto].push(rsi);
    if (rsiHistory[crypto].length > 20) rsiHistory[crypto].shift();
  }

  const bb = calculateBollingerBands(prices);
  const extremes = detectLocalExtremes(prices);
  const ma20 = calculateMA(prices, 20);
  const ma50 = calculateMA(prices, 50);
  const momentum = calculateMomentum(prices);
  const accumulatedChange = getAccumulatedChange(crypto, currentPrice);

  // Todos los análisis avanzados
  const dropCheck = await detectImmediateDrop(crypto);
  const obZones = await analyzeOrderBookZones(crypto, currentPrice);
  const macro = analyzeMacroTrend(change24h);
  const volatility = detectExtremeVolatility(prices);
  const cvdWhale = await analyzeCVDAndWhales(crypto);
  const rsiDiv = analyzeRSIDivergence(prices, rsiHistory[crypto]);
  const news = cachedNews[crypto];

  let buyConfidence = 0, sellConfidence = 0;
  let buyReasons = [], sellReasons = [];
  let blockBuy = false;

  // ── PROTECCIONES (bloquean señal de compra) ──
  if (dropCheck.dropRisk) {
    blockBuy = true;
    sellReasons.push(`⚠️ Pared de venta detectada (${dropCheck.buyRatio}% compradores)`);
  }
  if (macro.bearish) {
    blockBuy = true;
    sellReasons.push(macro.desc);
  }
  if (volatility.extreme && accumulatedChange < 0) {
    blockBuy = true;
    sellReasons.push(volatility.desc);
  }
  if (news.negative >= 2) {
    blockBuy = true;
    sellReasons.push('📰 Noticias muy negativas - señal bloqueada');
  }

  // ── PRECIO ACUMULATIVO ──
  if (accumulatedChange >= 3) { buyConfidence += 35; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado 🚀`); }
  else if (accumulatedChange >= 2) { buyConfidence += 25; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado`); }
  else if (accumulatedChange >= 1) { buyConfidence += 15; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado`); }
  else if (accumulatedChange >= 0.3) { buyConfidence += 8; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado`); }

  if (accumulatedChange <= -3) { sellConfidence += 35; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); priceBase[crypto] = currentPrice; }
  else if (accumulatedChange <= -2) { sellConfidence += 25; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); }
  else if (accumulatedChange <= -1) { sellConfidence += 15; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); }
  else if (accumulatedChange <= -0.3) { sellConfidence += 8; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); priceBase[crypto] = currentPrice; }

  // ── ORDER BOOK ──
  if (obZones.buyStrength > 0) { buyConfidence += obZones.buyStrength; buyReasons.push(obZones.obDesc); }
  if (obZones.sellStrength > 0) { sellConfidence += obZones.sellStrength; sellReasons.push(obZones.obDesc); }

  // ── CVD + BALLENAS ──
  if (cvdWhale.buyStrength > 0) {
    buyConfidence += cvdWhale.buyStrength;
    if (cvdWhale.cvdDesc) buyReasons.push(cvdWhale.cvdDesc);
    if (cvdWhale.whaleDesc) buyReasons.push(cvdWhale.whaleDesc);
  }
  if (cvdWhale.sellStrength > 0) {
    sellConfidence += cvdWhale.sellStrength;
    if (cvdWhale.cvdDesc) sellReasons.push(cvdWhale.cvdDesc);
    if (cvdWhale.whaleDesc) sellReasons.push(cvdWhale.whaleDesc);
  }

  // ── DIVERGENCIA RSI ──
  if (rsiDiv.bullish) { buyConfidence += 25; buyReasons.push(rsiDiv.desc); }
  if (rsiDiv.bearish) { sellConfidence += 25; sellReasons.push(rsiDiv.desc); }

  // ── RSI ──
  if (rsi !== null) {
    if (rsi < 25) { buyConfidence += 25; buyReasons.push('RSI extremo de sobreventa'); }
    else if (rsi < 30) { buyConfidence += 20; buyReasons.push('RSI en sobreventa'); }
    else if (rsi < 35) { buyConfidence += 10; buyReasons.push('RSI acercándose a sobreventa'); }
    if (rsi > 75) { sellConfidence += 25; sellReasons.push('RSI extremo de sobrecompra'); }
    else if (rsi > 70) { sellConfidence += 20; sellReasons.push('RSI en sobrecompra'); }
    else if (rsi > 65) { sellConfidence += 10; sellReasons.push('RSI acercándose a sobrecompra'); }
  }

  // ── BOLLINGER ──
  if (bb) {
    if (currentPrice < bb.lower) { buyConfidence += 20; buyReasons.push('Precio bajo banda inferior'); }
    else if (currentPrice <= bb.lower * 1.02) { buyConfidence += 12; buyReasons.push('Precio cerca banda inferior'); }
    if (currentPrice > bb.upper) { sellConfidence += 20; sellReasons.push('Precio sobre banda superior'); }
    else if (currentPrice >= bb.upper * 0.98) { sellConfidence += 12; sellReasons.push('Precio cerca banda superior'); }
  }

  // ── EXTREMOS LOCALES ──
  if (extremes.localMin) { buyConfidence += 12; buyReasons.push('Mínimo local detectado'); }
  if (extremes.localMax) { sellConfidence += 12; sellReasons.push('Máximo local detectado'); }

  // ── MEDIAS MÓVILES ──
  if (ma20 && ma50) {
    if (ma20 > ma50 && currentPrice > ma20) { buyConfidence += 12; buyReasons.push('Tendencia alcista (MA20 > MA50)'); }
    if (ma20 < ma50 && currentPrice < ma20) { sellConfidence += 12; sellReasons.push('Tendencia bajista (MA20 < MA50)'); }
  }

  // ── MOMENTUM ──
  if (momentum !== null) {
    if (momentum < -3) { buyConfidence += 8; buyReasons.push('Momentum: rebote posible'); }
    if (momentum > 3) { sellConfidence += 8; sellReasons.push('Momentum alto (posible techo)'); }
  }

  // ── TENDENCIA MACRO POSITIVA ──
  if (macro.bullish) { buyConfidence += macro.strength; buyReasons.push(macro.desc); }

  // ── NOTICIAS POSITIVAS ──
  if (news.positive >= 2) { buyConfidence += 15; buyReasons.push(...news.headlines); }
  else if (news.positive >= 1) { buyConfidence += 8; buyReasons.push(...news.headlines); }

  // Bloquear compra si hay riesgo
  if (blockBuy) buyConfidence = Math.min(buyConfidence, 40);

  return {
    crypto,
    currentPrice: currentPrice.toFixed(2),
    rsi: rsi ? rsi.toFixed(2) : 'N/A',
    buyConfidence: Math.min(100, buyConfidence),
    sellConfidence: Math.min(100, sellConfidence),
    buyReasons, sellReasons,
    accumulatedChange: accumulatedChange.toFixed(2),
    obZones, cvdWhale, blockBuy,
    high24h, low24h
  };
}

async function handleStatus() {
  let msg = '📊 <b>ESTADO DEL BOT</b>\n\n';
  const keys = Object.keys(userPositions);
  if (keys.length === 0) {
    msg += '📂 <b>Posiciones abiertas:</b> Ninguna\n\n';
  } else {
    msg += '📂 <b>Posiciones abiertas:</b>\n';
    for (const crypto of keys) {
      const pos = userPositions[crypto];
      const pd = await getCurrentPrice(crypto);
      if (pd) {
        const profit = ((pd.price - pos.entry) / pos.entry * 100).toFixed(2);
        const emoji = parseFloat(profit) >= 0 ? '📈' : '📉';
        msg += `${emoji} <b>${crypto}</b>\n`;
        msg += `   Entrada: $${pos.entry}\n`;
        msg += `   Actual: $${pd.price.toFixed(2)}\n`;
        msg += `   Ganancia: ${profit}%\n\n`;
      }
    }
  }
  if (executedTrades.length === 0) {
    msg += '📋 <b>Operaciones ejecutadas:</b> Ninguna aún\n';
  } else {
    msg += '📋 <b>Últimas operaciones:</b>\n';
    let total = 0;
    for (const t of executedTrades.slice(-5)) {
      const e = t.profit >= 0 ? '🟢' : '🔴';
      msg += `${e} <b>${t.crypto}</b>: $${t.entry} → $${t.exit} (${t.profit}%) ${t.duracion}min\n\n`;
      total += t.profit;
    }
    msg += `${total >= 0 ? '🟢' : '🔴'} <b>Total: ${total.toFixed(2)}%</b>`;
  }
  await sendTelegramMessage(msg);
}

async function handlePrecios() {
  let msg = '💰 <b>Precios actuales:</b>\n\n';
  for (const crypto of CRYPTOCURRENCIES) {
    const pd = await getCurrentPrice(crypto);
    if (pd) {
      const e = pd.change24h >= 0 ? '📈' : '📉';
      msg += `<b>${crypto}</b>: $${pd.price.toLocaleString()} ${e} ${pd.change24h.toFixed(2)}%\n`;
    } else {
      msg += `<b>${crypto}</b>: No disponible\n`;
    }
  }
  msg += `\n🕐 ${new Date().toLocaleTimeString()}`;
  await sendTelegramMessage(msg);
}

async function handleHistorial() {
  if (signalHistory.length === 0) {
    await sendTelegramMessage('📋 <b>Historial</b>\n\nNo hay señales hoy.');
    return;
  }
  let msg = '📋 <b>Señales de hoy:</b>\n\n';
  for (const s of signalHistory.slice(-10)) {
    const e = s.type === 'BUY' ? '🟢' : '🔴';
    msg += `${e} ${s.crypto} - $${s.price} (${s.confidence}%) 🕐${s.time}\n\n`;
  }
  await sendTelegramMessage(msg);
}

async function handleStopLoss(texto) {
  const num = parseFloat(texto);
  if (isNaN(num)) {
    await sendTelegramMessage(`⚙️ <b>Stop Loss actual: ${userStopLoss}%</b>\n\nPara cambiarlo:\n<code>/stoploss 3</code>`);
    return;
  }
  if (num < 1 || num > 50) { await sendTelegramMessage('❌ Debe estar entre 1% y 50%'); return; }
  userStopLoss = num;
  await sendTelegramMessage(`✅ Stop Loss: <b>${userStopLoss}%</b>`);
}

async function handleBotUpdates() {
  if (isPolling) return;
  isPolling = true;
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`,
      { timeout: 10000 }
    );
    for (const update of response.data.result) {
      lastUpdateId = update.update_id;

      if (update.callback_query) {
        const cb = update.callback_query;
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cb.id });

        if (cb.data.startsWith('buy_')) {
          const [, crypto, price] = cb.data.split('_');
          userPositions[crypto] = { entry: parseFloat(price), timestamp: Date.now() };
          priceBase[crypto] = parseFloat(price);
          pendingSignals[crypto] = { buyCount: 0, sellCount: 0 };
          await sendTelegramMessage(`✅ <b>Compra registrada - ${crypto}</b>\n\n💰 Entrada: $${price}\n🛡️ Stop Loss: ${userStopLoss}%\n\nMonitoreo activo. Te avisaré cuando vender.`);
        } else if (cb.data.startsWith('skip_')) {
          const crypto = cb.data.split('_')[1];
          priceBase[crypto] = null;
          pendingSignals[crypto] = { buyCount: 0, sellCount: 0 };
          await sendTelegramMessage(`❌ Señal de ${crypto} ignorada.`);
        } else if (cb.data.startsWith('sell_')) {
          const [, crypto, price] = cb.data.split('_');
          if (userPositions[crypto]) {
            const entry = userPositions[crypto].entry;
            const profit = ((parseFloat(price) - entry) / entry * 100).toFixed(2);
            const duracion = Math.round((Date.now() - userPositions[crypto].timestamp) / 60000);
            executedTrades.push({ crypto, entry, exit: parseFloat(price), profit: parseFloat(profit), duracion, time: new Date().toLocaleString() });
            await sendTelegramMessage(
              `✅ <b>Operación ejecutada - ${crypto}</b>\n\n🏁 Entrada: $${entry}\n🏆 Salida: $${price}\n${parseFloat(profit) >= 0 ? '🟢' : '🔴'} Ganancia: ${profit}%\n⏱️ ${duracion} minutos\n\nGuardado en /status ✅`
            );
            delete userPositions[crypto];
            priceBase[crypto] = null;
          }
        } else if (cb.data.startsWith('hold_')) {
          await sendTelegramMessage(`⏳ Manteniendo ${cb.data.split('_')[1]}. Seguimos monitoreando.`);
        }
        continue;
      }

      const msg = update.message;
      if (!msg?.text) continue;
      const texto = msg.text.trim();

      if (texto === '/start') {
        await sendTelegramMessage('🤖 <b>Bot Pro activo!</b>\n\nComandos:\n/status\n/precios\n/historial\n/stoploss [%]');
      } else if (texto === '/status') { await handleStatus();
      } else if (texto === '/precios') { await handlePrecios();
      } else if (texto === '/historial') { await handleHistorial();
      } else if (texto.toLowerCase().startsWith('/stoploss')) {
        await handleStopLoss(texto.replace(/\/stoploss/i, '').trim());
      }
    }
  } catch (error) {
    if (!error.message?.includes('409')) console.error('Error updates:', error.message);
  } finally {
    isPolling = false;
  }
}

async function runAnalysis() {
  console.log(`\n📊 Análisis: ${new Date().toLocaleString()}`);
  await fetchNews();

  for (const crypto of CRYPTOCURRENCIES) {
    const a = await analyzeCrypto(crypto);
    if (!a) continue;

    const { buyConfidence, sellConfidence, rsi, currentPrice, buyReasons, sellReasons, accumulatedChange, obZones, cvdWhale, blockBuy, high24h, low24h } = a;

    // Stop Loss con botones
    if (userPositions[crypto]) {
      const entry = userPositions[crypto].entry;
      const loss = ((parseFloat(currentPrice) - entry) / entry * 100);
      if (loss <= -userStopLoss) {
        await sendTelegramMessage(
          `🚨 <b>STOP LOSS - ${crypto}</b>\n\n💰 Precio: $${currentPrice}\n🏁 Entrada: $${entry}\n📉 Pérdida: ${loss.toFixed(2)}%\n\n⚠️ Considera vender para limitar pérdidas.`,
          [[{ text: '✅ Sí, vendí', callback_data: `sell_${crypto}_${currentPrice}` }, { text: '❌ Sigo esperando', callback_data: `hold_${crypto}` }]]
        );
      }
    }

    // ── CONFIRMACIÓN: necesita 2 análisis seguidos con 80%+ ──
    if (buyConfidence >= 80 && !userPositions[crypto] && !blockBuy) {
      pendingSignals[crypto].buyCount++;
      pendingSignals[crypto].lastBuyConfidence = buyConfidence;
      pendingSignals[crypto].sellCount = 0;

      if (pendingSignals[crypto].buyCount >= 2) {
        const level = getSignalLevel(buyConfidence);
        const reasons = buyReasons.map(r => `• ${r}`).join('\n');

        // Calcular TP/SL sugeridos
        const suggestedTP = (parseFloat(currentPrice) * 1.03).toFixed(2);
        const suggestedSL = (parseFloat(currentPrice) * (1 - userStopLoss/100)).toFixed(2);

        const message =
          `🟢 <b>SEÑAL DE COMPRA ${level.emoji} ${level.nivel} - ${crypto}</b>\n\n` +
          `💰 Precio: $${currentPrice}\n` +
          `📊 RSI: ${rsi}\n` +
          `📈 Confianza: ${buyConfidence.toFixed(0)}%\n` +
          `📉 Cambio acumulado: ${accumulatedChange}%\n\n` +
          `<b>🎯 Zonas clave:</b>\n` +
          `   🛡️ Soporte: $${obZones.supportZone} (${obZones.supportVolume})\n` +
          `   🚧 Resistencia: $${obZones.resistanceZone} (${obZones.resistanceVolume})\n` +
          `   ✅ TP sugerido: $${suggestedTP}\n` +
          `   ❌ SL sugerido: $${suggestedSL}\n\n` +
          `<b>Análisis:</b>\n${reasons}\n\n` +
          `¿Compraste?`;
        const buttons = [[
          { text: '✅ Sí, compré', callback_data: `buy_${crypto}_${currentPrice}` },
          { text: '❌ Pasamos', callback_data: `skip_${crypto}` }
        ]];
        await sendTelegramMessage(message, buttons);
        signalHistory.push({ type: 'BUY', crypto, price: currentPrice, confidence: buyConfidence.toFixed(0), time: new Date().toLocaleTimeString() });
        priceBase[crypto] = parseFloat(currentPrice);
        pendingSignals[crypto].buyCount = 0;
      }
    } else {
      if (buyConfidence < 80) pendingSignals[crypto].buyCount = 0;
    }

    if (sellConfidence >= 80 && userPositions[crypto]) {
      pendingSignals[crypto].sellCount++;
      pendingSignals[crypto].buyCount = 0;

      if (pendingSignals[crypto].sellCount >= 2) {
        const level = getSignalLevel(sellConfidence);
        const entry = userPositions[crypto].entry;
        const profit = ((parseFloat(currentPrice) - entry) / entry * 100).toFixed(2);
        const reasons = sellReasons.map(r => `• ${r}`).join('\n');

        const message =
          `🔴 <b>SEÑAL DE VENTA ${level.emoji} ${level.nivel} - ${crypto}</b>\n\n` +
          `💰 Precio: $${currentPrice}\n` +
          `📊 RSI: ${rsi}\n` +
          `📉 Confianza: ${sellConfidence.toFixed(0)}%\n` +
          `🏁 Entrada: $${entry}\n` +
          `📊 Ganancia: ${profit}%\n\n` +
          `<b>🎯 Zonas clave:</b>\n` +
          `   🛡️ Soporte: $${obZones.supportZone}\n` +
          `   🚧 Resistencia: $${obZones.resistanceZone}\n\n` +
          `<b>Análisis:</b>\n${reasons}\n\n` +
          `¿Vendiste?`;
        const buttons = [[
          { text: '✅ Sí, vendí', callback_data: `sell_${crypto}_${currentPrice}` },
          { text: '❌ Sigo esperando', callback_data: `hold_${crypto}` }
        ]];
        await sendTelegramMessage(message, buttons);
        signalHistory.push({ type: 'SELL', crypto, price: currentPrice, confidence: sellConfidence.toFixed(0), time: new Date().toLocaleTimeString() });
        pendingSignals[crypto].sellCount = 0;
      }
    } else {
      if (sellConfidence < 80) pendingSignals[crypto].sellCount = 0;
    }
  }
  console.log('✅ Análisis completado');
}

async function startBot() {
  console.log('🤖 Bot Pro iniciado...');
  try {
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    console.log('✅ Webhook limpiado');
  } catch (e) { console.log('Webhook limpio'); }

  await sendTelegramMessage(
    '🤖 <b>Bot Pro - Versión Definitiva!</b>\n\n' +
    '✅ 6 protecciones anti-caída\n' +
    '✅ Confirmación doble antes de señal\n' +
    '✅ Ballenas con monto en USD\n' +
    '✅ Zonas TP/SL del mercado\n' +
    '✅ Order Book + CVD\n' +
    '✅ Divergencia RSI\n' +
    '✅ Noticias en tiempo real\n' +
    '✅ Stop Loss con botones\n' +
    '✅ Solo señales 80%+\n\n' +
    'Niveles:\n' +
    '🟡 80-89% Moderada\n' +
    '🟠 90-99% Buena → Fuerte\n' +
    '🔴 100% Perfecta\n\n' +
    'Comandos:\n/status /precios /historial /stoploss'
  );

  await runAnalysis();
  setInterval(runAnalysis, ANALYSIS_INTERVAL);
  setInterval(handleBotUpdates, 3000);
}

startBot().catch(error => {
  console.error('❌ Error:', error);
  process.exit(1);
});
