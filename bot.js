const axios = require('axios');
const xml2js = require('xml2js');

const TELEGRAM_BOT_TOKEN = '8756381855:AAH1cjj2bogwVfl0tP5yRcRfX7lZHJFohdQ';
const TELEGRAM_CHAT_ID = '8173449171';
const CRYPTOCURRENCIES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA'];
const ANALYSIS_INTERVAL = 60 * 1000;

let userPositions = {};
let priceHistory = {};
let volumeHistory = {};
let signalHistory = [];
let executedTrades = [];
let userStopLoss = 5;
let lastUpdateId = 0;
let isPolling = false;
let priceBase = {};
let lastNewsCheck = 0;
let cachedNews = {};

CRYPTOCURRENCIES.forEach(crypto => {
  priceHistory[crypto] = [];
  volumeHistory[crypto] = [];
  priceBase[crypto] = null;
  cachedNews[crypto] = { positive: 0, negative: 0, headlines: [] };
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
    `https://api2.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
    `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`
  ];

  for (const url of servers) {
    try {
      const response = await axios.get(url, { timeout: 8000 });
      return {
        price: parseFloat(response.data.lastPrice),
        volume: parseFloat(response.data.volume),
        quoteVolume: parseFloat(response.data.quoteVolume),
        change24h: parseFloat(response.data.priceChangePercent)
      };
    } catch (e) {
      continue;
    }
  }

  try {
    const r = await axios.get(
      `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${crypto}&tsyms=USD`,
      { timeout: 10000 }
    );
    const data = r.data.RAW[crypto].USD;
    return {
      price: data.PRICE,
      volume: data.VOLUME24HOUR,
      quoteVolume: data.VOLUME24HOURTO,
      change24h: data.CHANGEPCT24HOUR
    };
  } catch (e) {
    console.error(`❌ Error precio ${crypto}:`, e.message);
    return null;
  }
}

function detectWhale(crypto, currentVolume) {
  if (volumeHistory[crypto].length < 5) return { isWhale: false, strength: 0, desc: '' };
  const avgVolume = volumeHistory[crypto].slice(-5).reduce((a, b) => a + b) / 5;
  const volumeIncrease = ((currentVolume - avgVolume) / avgVolume) * 100;
  if (volumeIncrease >= 500) return { isWhale: true, strength: 40, desc: `🐋 Ballena enorme! Volumen +${volumeIncrease.toFixed(0)}%` };
  if (volumeIncrease >= 300) return { isWhale: true, strength: 30, desc: `🐋 Ballena grande! Volumen +${volumeIncrease.toFixed(0)}%` };
  if (volumeIncrease >= 150) return { isWhale: true, strength: 15, desc: `🐳 Movimiento grande. Volumen +${volumeIncrease.toFixed(0)}%` };
  return { isWhale: false, strength: 0, desc: '' };
}

async function fetchNews() {
  const now = Date.now();
  if (now - lastNewsCheck < 10 * 60 * 1000) return;
  lastNewsCheck = now;

  const feeds = [
    'https://www.coindesk.com/arc/outboundfeeds/rss/',
    'https://cointelegraph.com/rss'
  ];

  const positiveWords = ['surge', 'rally', 'bullish', 'adoption', 'approved', 'partnership', 'growth', 'record', 'high', 'gain', 'rises', 'jumps', 'soars', 'up', 'buy'];
  const negativeWords = ['crash', 'bearish', 'ban', 'hack', 'fraud', 'dump', 'fall', 'drop', 'down', 'sell', 'fear', 'risk', 'warning', 'loss'];

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
          const keywords = NEWS_KEYWORDS[crypto];
          if (keywords.some(kw => content.includes(kw))) {
            const posScore = positiveWords.filter(w => content.includes(w)).length;
            const negScore = negativeWords.filter(w => content.includes(w)).length;
            if (posScore > negScore) {
              cachedNews[crypto].positive += posScore;
              if (cachedNews[crypto].headlines.length < 2) {
                cachedNews[crypto].headlines.push(`📰 ${item.title?.[0]?.substring(0, 60)}...`);
              }
            } else if (negScore > posScore) {
              cachedNews[crypto].negative += negScore;
            }
          }
        }
      }
    } catch (e) {
      console.log('News fetch error:', e.message);
    }
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
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / (avgLoss || 1);
  return 100 - (100 / (1 + rs));
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;
  const recentPrices = prices.slice(-period);
  const sma = recentPrices.reduce((a, b) => a + b) / period;
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: sma + (std * stdDev), middle: sma, lower: sma - (std * stdDev) };
}

function calculateMA(prices, period) {
  if (prices.length < period) return null;
  return prices.slice(-period).reduce((a, b) => a + b) / period;
}

function calculateMomentum(prices, period = 10) {
  if (prices.length < period + 1) return null;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - period];
  return ((current - past) / past) * 100;
}

function detectLocalExtremes(prices, window = 3) {
  if (prices.length < window * 2 + 1) return { localMax: false, localMin: false };
  const lastIndex = prices.length - 1;
  const current = prices[lastIndex];
  const start = Math.max(0, lastIndex - window);
  const end = Math.min(prices.length - 1, lastIndex + window);
  let isLocalMax = true, isLocalMin = true;
  for (let i = start; i <= end; i++) {
    if (i !== lastIndex) {
      if (prices[i] >= current) isLocalMax = false;
      if (prices[i] <= current) isLocalMin = false;
    }
  }
  return {
    localMax: isLocalMax && lastIndex > window,
    localMin: isLocalMin && lastIndex > window
  };
}

function analyzeSellPressure(prices) {
  if (prices.length < 5) return 0;
  const recentPrices = prices.slice(-5);
  const avgPrice = recentPrices.reduce((a, b) => a + b) / recentPrices.length;
  const currentPrice = recentPrices[recentPrices.length - 1];
  if (currentPrice < avgPrice) {
    return Math.min(100, ((avgPrice - currentPrice) / avgPrice) * 100 * 2);
  }
  return 0;
}

function getAccumulatedChange(crypto, currentPrice) {
  if (!priceBase[crypto]) {
    priceBase[crypto] = currentPrice;
    return 0;
  }
  return ((currentPrice - priceBase[crypto]) / priceBase[crypto]) * 100;
}

function getSignalLevel(confidence) {
  if (confidence >= 100) return { emoji: '🚀', nivel: 'PERFECTA' };
  if (confidence >= 90) return { emoji: '🔴', nivel: 'FUERTE' };
  if (confidence >= 80) return { emoji: '🟠', nivel: 'BUENA' };
  return { emoji: '🟡', nivel: 'MODERADA' };
}

async function analyzeCrypto(crypto) {
  const priceData = await getCurrentPrice(crypto);
  if (!priceData) return null;
  const currentPrice = priceData.price;
  const currentVolume = priceData.volume;

  priceHistory[crypto].push(currentPrice);
  if (priceHistory[crypto].length > 100) priceHistory[crypto].shift();
  volumeHistory[crypto].push(currentVolume);
  if (volumeHistory[crypto].length > 20) volumeHistory[crypto].shift();

  const prices = priceHistory[crypto];
  const rsi = calculateRSI(prices);
  const bb = calculateBollingerBands(prices);
  const extremes = detectLocalExtremes(prices);
  const sellPressure = analyzeSellPressure(prices);
  const ma20 = calculateMA(prices, 20);
  const ma50 = calculateMA(prices, 50);
  const momentum = calculateMomentum(prices);
  const whale = detectWhale(crypto, currentVolume);
  const accumulatedChange = getAccumulatedChange(crypto, currentPrice);
  const news = cachedNews[crypto];

  let buyConfidence = 0, sellConfidence = 0;
  let buyReasons = [], sellReasons = [];

  if (accumulatedChange >= 3) { buyConfidence += 40; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado 🚀`); }
  else if (accumulatedChange >= 2) { buyConfidence += 30; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado`); }
  else if (accumulatedChange >= 1) { buyConfidence += 20; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado`); }
  else if (accumulatedChange >= 0.3) { buyConfidence += 10; buyReasons.push(`Subió ${accumulatedChange.toFixed(2)}% acumulado`); }

  if (accumulatedChange <= -3) { sellConfidence += 40; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado 🔻`); priceBase[crypto] = currentPrice; }
  else if (accumulatedChange <= -2) { sellConfidence += 30; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); }
  else if (accumulatedChange <= -1) { sellConfidence += 20; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); }
  else if (accumulatedChange <= -0.3) { sellConfidence += 10; sellReasons.push(`Bajó ${Math.abs(accumulatedChange).toFixed(2)}% acumulado`); priceBase[crypto] = currentPrice; }

  if (whale.isWhale) {
    if (accumulatedChange >= 0) { buyConfidence += whale.strength; buyReasons.push(whale.desc); }
    else { sellConfidence += whale.strength; sellReasons.push(whale.desc); }
  }

  if (rsi !== null) {
    if (rsi < 25) { buyConfidence += 25; buyReasons.push('RSI extremo de sobreventa'); }
    else if (rsi < 30) { buyConfidence += 20; buyReasons.push('RSI en sobreventa'); }
    else if (rsi < 35) { buyConfidence += 10; buyReasons.push('RSI acercándose a sobreventa'); }
    if (rsi > 75) { sellConfidence += 25; sellReasons.push('RSI extremo de sobrecompra'); }
    else if (rsi > 70) { sellConfidence += 20; sellReasons.push('RSI en sobrecompra'); }
    else if (rsi > 65) { sellConfidence += 10; sellReasons.push('RSI acercándose a sobrecompra'); }
  }

  if (bb) {
    if (currentPrice < bb.lower) { buyConfidence += 20; buyReasons.push('Precio bajo banda inferior'); }
    else if (currentPrice <= bb.lower * 1.02) { buyConfidence += 12; buyReasons.push('Precio cerca banda inferior'); }
    if (currentPrice > bb.upper) { sellConfidence += 20; sellReasons.push('Precio sobre banda superior'); }
    else if (currentPrice >= bb.upper * 0.98) { sellConfidence += 12; sellReasons.push('Precio cerca banda superior'); }
  }

  if (extremes.localMin) { buyConfidence += 15; buyReasons.push('Mínimo local detectado'); }
  if (extremes.localMax) { sellConfidence += 15; sellReasons.push('Máximo local detectado'); }

  if (ma20 && ma50) {
    if (ma20 > ma50 && currentPrice > ma20) { buyConfidence += 15; buyReasons.push('Tendencia alcista (MA20 > MA50)'); }
    if (ma20 < ma50 && currentPrice < ma20) { sellConfidence += 15; sellReasons.push('Tendencia bajista (MA20 < MA50)'); }
  }

  if (momentum !== null) {
    if (momentum < -3) { buyConfidence += 10; buyReasons.push('Momentum negativo (rebote posible)'); }
    if (momentum > 3) { sellConfidence += 10; sellReasons.push('Momentum alto (posible techo)'); }
  }

  if (sellPressure > 5) {
    sellConfidence += Math.min(15, sellPressure / 2);
    sellReasons.push('Presión bajista detectada');
  }

  if (news.positive >= 2) { buyConfidence += 20; buyReasons.push(...news.headlines); }
  else if (news.positive >= 1) { buyConfidence += 10; buyReasons.push(...news.headlines); }
  if (news.negative >= 2) { sellConfidence += 20; sellReasons.push('📰 Noticias negativas detectadas'); }
  else if (news.negative >= 1) { sellConfidence += 10; sellReasons.push('📰 Noticia negativa detectada'); }

  return {
    crypto,
    currentPrice: currentPrice.toFixed(2),
    rsi: rsi ? rsi.toFixed(2) : 'N/A',
    bb, extremes,
    buyConfidence: Math.min(100, buyConfidence),
    sellConfidence: Math.min(100, sellConfidence),
    buyReasons, sellReasons,
    accumulatedChange: accumulatedChange.toFixed(2),
    priceData
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
      const priceData = await getCurrentPrice(crypto);
      if (priceData) {
        const profit = ((priceData.price - pos.entry) / pos.entry * 100).toFixed(2);
        const emoji = parseFloat(profit) >= 0 ? '📈' : '📉';
        msg += `${emoji} <b>${crypto}</b>\n`;
        msg += `   Entrada: $${pos.entry}\n`;
        msg += `   Actual: $${priceData.price.toFixed(2)}\n`;
        msg += `   Ganancia: ${profit}%\n\n`;
      }
    }
  }
  if (executedTrades.length === 0) {
    msg += '📋 <b>Operaciones ejecutadas:</b> Ninguna aún\n';
  } else {
    msg += '📋 <b>Últimas operaciones:</b>\n';
    const ultimas = executedTrades.slice(-5);
    let totalProfit = 0;
    for (const t of ultimas) {
      const emoji = t.profit >= 0 ? '🟢' : '🔴';
      msg += `${emoji} <b>${t.crypto}</b>\n`;
      msg += `   Entrada: $${t.entry} → Salida: $${t.exit}\n`;
      msg += `   Ganancia: ${t.profit}%\n`;
      msg += `   Duración: ${t.duracion} min\n`;
      msg += `   🕐 ${t.time}\n\n`;
      totalProfit += t.profit;
    }
    const totalEmoji = totalProfit >= 0 ? '🟢' : '🔴';
    msg += `${totalEmoji} <b>Ganancia total: ${totalProfit.toFixed(2)}%</b>`;
  }
  await sendTelegramMessage(msg);
}

async function handlePrecios() {
  let msg = '💰 <b>Precios actuales:</b>\n\n';
  for (const crypto of CRYPTOCURRENCIES) {
    const priceData = await getCurrentPrice(crypto);
    if (priceData) {
      const changeEmoji = priceData.change24h >= 0 ? '📈' : '📉';
      msg += `<b>${crypto}</b>: $${priceData.price.toLocaleString()} ${changeEmoji} ${priceData.change24h.toFixed(2)}%\n`;
    } else {
      msg += `<b>${crypto}</b>: No disponible\n`;
    }
  }
  msg += `\n🕐 ${new Date().toLocaleTimeString()}`;
  await sendTelegramMessage(msg);
}

async function handleHistorial() {
  if (signalHistory.length === 0) {
    await sendTelegramMessage('📋 <b>Historial</b>\n\nNo hay señales registradas hoy.');
    return;
  }
  let msg = '📋 <b>Señales de hoy:</b>\n\n';
  const ultimas = signalHistory.slice(-10);
  for (const s of ultimas) {
    const emoji = s.type === 'BUY' ? '🟢' : '🔴';
    msg += `${emoji} ${s.crypto} - $${s.price} (${s.confidence}%)\n`;
    msg += `   🕐 ${s.time}\n\n`;
  }
  await sendTelegramMessage(msg);
}

async function handleStopLoss(texto) {
  const num = parseFloat(texto);
  if (isNaN(num)) {
    await sendTelegramMessage(`⚙️ <b>Stop Loss actual: ${userStopLoss}%</b>\n\nPara cambiarlo:\n<code>/stoploss 3</code>`);
    return;
  }
  if (num < 1 || num > 50) {
    await sendTelegramMessage('❌ El stop loss debe estar entre 1% y 50%');
    return;
  }
  userStopLoss = num;
  await sendTelegramMessage(`✅ Stop Loss configurado en <b>${userStopLoss}%</b>`);
}

async function handleBotUpdates() {
  if (isPolling) return;
  isPolling = true;
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`,
      { timeout: 10000 }
    );
    const updates = response.data.result;

    for (const update of updates) {
      lastUpdateId = update.update_id;

      if (update.callback_query) {
        const cb = update.callback_query;
        const data = cb.data;
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
          { callback_query_id: cb.id }
        );

        if (data.startsWith('buy_')) {
          const parts = data.split('_');
          const crypto = parts[1];
          const price = parts[2];
          userPositions[crypto] = { entry: parseFloat(price), timestamp: Date.now() };
          priceBase[crypto] = parseFloat(price);
          await sendTelegramMessage(
            `✅ <b>Compra registrada - ${crypto}</b>\n\n` +
            `💰 Entrada: $${price}\n` +
            `🛡️ Stop Loss: ${userStopLoss}%\n\n` +
            `Monitoreo activo. Te avisaré cuando vender.`
          );
        } else if (data.startsWith('skip_')) {
          const crypto = data.split('_')[1];
          priceBase[crypto] = null;
          await sendTelegramMessage(`❌ Señal de ${crypto} ignorada. Seguimos monitoreando.`);
        } else if (data.startsWith('sell_')) {
          const parts = data.split('_');
          const crypto = parts[1];
          const price = parts[2];
          if (userPositions[crypto]) {
            const entry = userPositions[crypto].entry;
            const profit = ((parseFloat(price) - entry) / entry * 100).toFixed(2);
            const duracion = Math.round((Date.now() - userPositions[crypto].timestamp) / 60000);
            const emoji = parseFloat(profit) >= 0 ? '🟢' : '🔴';
            executedTrades.push({
              crypto, entry, exit: parseFloat(price),
              profit: parseFloat(profit), duracion,
              time: new Date().toLocaleString()
            });
            await sendTelegramMessage(
              `✅ <b>Operación ejecutada - ${crypto}</b>\n\n` +
              `🏁 Entrada: $${entry}\n` +
              `🏆 Salida: $${price}\n` +
              `${emoji} Ganancia: ${profit}%\n` +
              `⏱️ Duración: ${duracion} minutos\n\n` +
              `Guardado en /status ✅`
            );
            delete userPositions[crypto];
            priceBase[crypto] = null;
          }
        } else if (data.startsWith('hold_')) {
          const crypto = data.split('_')[1];
          await sendTelegramMessage(`⏳ Manteniendo ${crypto}. Seguimos monitoreando.`);
        }
        continue;
      }

      const msg = update.message;
      if (!msg || !msg.text) continue;
      const texto = msg.text.trim();

      if (texto === '/start') {
        await sendTelegramMessage(
          '🤖 <b>Bot de Trading activo!</b>\n\n' +
          'Comandos:\n' +
          '/status - Posiciones y operaciones\n' +
          '/precios - Precios actuales\n' +
          '/historial - Señales de hoy\n' +
          '/stoploss [%] - Configurar stop loss'
        );
      } else if (texto === '/status') {
        await handleStatus();
      } else if (texto === '/precios') {
        await handlePrecios();
      } else if (texto === '/historial') {
        await handleHistorial();
      } else if (texto.toLowerCase().startsWith('/stoploss')) {
        await handleStopLoss(texto.replace(/\/stoploss/i, '').trim());
      }
    }
  } catch (error) {
    if (!error.message.includes('409')) {
      console.error('Error updates:', error.message);
    }
  } finally {
    isPolling = false;
  }
}

async function runAnalysis() {
  console.log(`\n📊 Análisis: ${new Date().toLocaleString()}`);
  await fetchNews();

  for (const crypto of CRYPTOCURRENCIES) {
    const analysis = await analyzeCrypto(crypto);
    if (!analysis) continue;

    const { buyConfidence, sellConfidence, rsi, currentPrice, buyReasons, sellReasons, accumulatedChange } = analysis;

    if (userPositions[crypto]) {
      const entry = userPositions[crypto].entry;
      const loss = ((parseFloat(currentPrice) - entry) / entry * 100);
      if (loss <= -userStopLoss) {
        const slButtons = [[
          { text: '✅ Sí, vendí', callback_data: `sell_${crypto}_${currentPrice}` },
          { text: '❌ Sigo esperando', callback_data: `hold_${crypto}` }
        ]];
        await sendTelegramMessage(
          `🚨 <b>STOP LOSS - ${crypto}</b>\n\n` +
          `💰 Precio: $${currentPrice}\n` +
          `🏁 Entrada: $${entry}\n` +
          `📉 Pérdida: ${loss.toFixed(2)}%\n\n` +
          `⚠️ Considera vender para limitar pérdidas.`,
          slButtons
        );
      }
    }

    if (buyConfidence >= 70 && !userPositions[crypto]) {
      const level = getSignalLevel(buyConfidence);
      const reasons = buyReasons.map(r => `• ${r}`).join('\n');
      const message =
        `🟢 <b>SEÑAL DE COMPRA ${level.emoji} ${level.nivel} - ${crypto}</b>\n\n` +
        `💰 Precio: $${currentPrice}\n` +
        `📊 RSI: ${rsi}\n` +
        `📈 Confianza: ${buyConfidence.toFixed(0)}%\n` +
        `📉 Cambio acumulado: ${accumulatedChange}%\n\n` +
        `<b>Análisis:</b>\n${reasons}\n\n` +
        `¿Compraste?`;
      const buttons = [[
        { text: '✅ Sí, compré', callback_data: `buy_${crypto}_${currentPrice}` },
        { text: '❌ Pasamos', callback_data: `skip_${crypto}` }
      ]];
      await sendTelegramMessage(message, buttons);
      signalHistory.push({ type: 'BUY', crypto, price: currentPrice, confidence: buyConfidence.toFixed(0), time: new Date().toLocaleTimeString() });
      priceBase[crypto] = parseFloat(currentPrice);
    }

    if (sellConfidence >= 70 && userPositions[crypto]) {
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
        `<b>Análisis:</b>\n${reasons}\n\n` +
        `¿Vendiste?`;
      const buttons = [[
        { text: '✅ Sí, vendí', callback_data: `sell_${crypto}_${currentPrice}` },
        { text: '❌ Sigo esperando', callback_data: `hold_${crypto}` }
      ]];
      await sendTelegramMessage(message, buttons);
      signalHistory.push({ type: 'SELL', crypto, price: currentPrice, confidence: sellConfidence.toFixed(0), time: new Date().toLocaleTimeString() });
    }
  }
  console.log('✅ Análisis completado');
}

async function startBot() {
  console.log('🤖 Bot iniciado...');
  try {
    await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    console.log('✅ Webhook limpiado');
  } catch (e) {
    console.log('Webhook ya estaba limpio');
  }

  await sendTelegramMessage(
    '🤖 <b>Bot actualizado!</b>\n\n' +
    '✅ Solo señales 70%+ (Moderada a Perfecta)\n' +
    '✅ Análisis cada 1 minuto\n' +
    '✅ Precio acumulativo\n' +
    '✅ Ballenas + Noticias + RSI\n\n' +
    'Niveles:\n' +
    '🟡 70-79% Moderada\n' +
    '🟠 80-89% Buena\n' +
    '🔴 90-99% Fuerte\n' +
    '🚀 100% Perfecta\n\n' +
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
