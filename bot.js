const axios = require('axios');

const TELEGRAM_BOT_TOKEN = '8756381855:AAH1cjj2bogwVfl0tP5yRcRfX7lZHJFohdQ';
const TELEGRAM_CHAT_ID = '8173449171';
const CRYPTOCURRENCIES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA'];
const ANALYSIS_INTERVAL = 5 * 60 * 1000;

let userPositions = {};
let priceHistory = {};
let signalHistory = [];

CRYPTOCURRENCIES.forEach(crypto => {
  priceHistory[crypto] = [];
});

const COINGECKO_IDS = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'BNB': 'binancecoin',
  'SOL': 'solana',
  'XRP': 'ripple',
  'ADA': 'cardano'
};

let userStopLoss = 5; // % por defecto

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
  try {
    const coinId = COINGECKO_IDS[crypto];
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`,
      { timeout: 10000 }
    );
    const priceData = response.data[coinId];
    if (!priceData) throw new Error(`No data for ${coinId}`);
    return {
      price: priceData.usd,
      marketCap: priceData.usd_market_cap,
      volume24h: priceData.usd_24h_vol
    };
  } catch (error) {
    console.error(`❌ Error obteniendo precio de ${crypto}:`, error.message);
    return null;
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

async function analyzeCrypto(crypto) {
  const priceData = await getCurrentPrice(crypto);
  if (!priceData) return null;
  const currentPrice = priceData.price;

  if (!priceHistory[crypto]) priceHistory[crypto] = [];
  priceHistory[crypto].push(currentPrice);
  if (priceHistory[crypto].length > 100) priceHistory[crypto].shift();

  const prices = priceHistory[crypto];
  const rsi = calculateRSI(prices);
  const bb = calculateBollingerBands(prices);
  const extremes = detectLocalExtremes(prices);
  const sellPressure = analyzeSellPressure(prices);

  let buyConfidence = 0, sellConfidence = 0;

  if (rsi !== null) {
    if (rsi < 30) buyConfidence += 25;
    if (rsi < 35) buyConfidence += 15;
    if (rsi > 70) sellConfidence += 25;
    if (rsi > 65) sellConfidence += 15;
  }

  if (bb) {
    if (currentPrice <= bb.lower * 1.02) buyConfidence += 20;
    if (currentPrice >= bb.upper * 0.98) sellConfidence += 20;
  }

  if (extremes.localMin) buyConfidence += 15;
  if (extremes.localMax) sellConfidence += 15;
  if (sellPressure > 5) sellConfidence += Math.min(20, sellPressure / 2);

  return {
    crypto,
    currentPrice: currentPrice.toFixed(2),
    rsi: rsi ? rsi.toFixed(2) : 'N/A',
    bb: bb ? {
      upper: bb.upper.toFixed(2),
      middle: bb.middle.toFixed(2),
      lower: bb.lower.toFixed(2)
    } : null,
    extremes,
    sellPressure: sellPressure.toFixed(2),
    buyConfidence: Math.min(100, buyConfidence),
    sellConfidence: Math.min(100, sellConfidence),
    priceData
  };
}

// ── COMANDOS ──────────────────────────────────────────

async function handleStatus() {
  const keys = Object.keys(userPositions);
  if (keys.length === 0) {
    await sendTelegramMessage('📊 <b>Estado actual</b>\n\nNo tienes posiciones abiertas.');
    return;
  }
  let msg = '📊 <b>Posiciones abiertas:</b>\n\n';
  for (const crypto of keys) {
    const pos = userPositions[crypto];
    const priceData = await getCurrentPrice(crypto);
    if (priceData) {
      const profit = ((priceData.price - pos.entry) / pos.entry * 100).toFixed(2);
      const emoji = profit >= 0 ? '📈' : '📉';
      msg += `${emoji} <b>${crypto}</b>\n`;
      msg += `   Entrada: $${pos.entry}\n`;
      msg += `   Actual: $${priceData.price.toFixed(2)}\n`;
      msg += `   Ganancia: ${profit}%\n\n`;
    }
  }
  await sendTelegramMessage(msg);
}

async function handlePrecios() {
  let msg = '💰 <b>Precios actuales:</b>\n\n';
  for (const crypto of CRYPTOCURRENCIES) {
    const priceData = await getCurrentPrice(crypto);
    await new Promise(r => setTimeout(r, 1500));
    if (priceData) {
      msg += `<b>${crypto}</b>: $${priceData.price.toLocaleString()}\n`;
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
  const partes = texto.trim().split(' ');
  if (partes.length < 2 || isNaN(partes[1])) {
    await sendTelegramMessage(
      `⚙️ <b>Stop Loss actual: ${userStopLoss}%</b>\n\nPara cambiarlo escribe:\n<code>/stoploss 3</code>\n\nEjemplo: /stoploss 5 = alerta si baja 5%`
    );
    return;
  }
  const nuevo = parseFloat(partes[1]);
  if (nuevo < 1 || nuevo > 50) {
    await sendTelegramMessage('❌ El stop loss debe estar entre 1% y 50%');
    return;
  }
  userStopLoss = nuevo;
  await sendTelegramMessage(`✅ Stop Loss configurado en <b>${userStopLoss}%</b>\n\nTe avisaré si alguna posición baja más de ${userStopLoss}%`);
}

// ── POLLING DE COMANDOS ───────────────────────────────

let lastUpdateId = 0;

async function handleBotUpdates() {
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`
    );
    const updates = response.data.result;
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const texto = msg.text.toLowerCase().trim();
      console.log(`📩 Comando recibido: ${texto}`);

      if (texto === '/start') {
        await sendTelegramMessage('🤖 <b>Bot de Trading activo!</b>\n\nComandos disponibles:\n/status - Ver posiciones abiertas\n/precios - Ver precios actuales\n/historial - Ver señales de hoy\n/stoploss - Configurar stop loss');
      } else if (texto === '/status') {
        await handleStatus();
      } else if (texto === '/precios') {
        await handlePrecios();
      } else if (texto === '/historial') {
        await handleHistorial();
      } else if (texto.startsWith('/stoploss')) {
        await handleStopLoss(texto.replace('/stoploss', '').trim() ? texto : texto);
      }
    }
  } catch (error) {
    console.error('Error en updates:', error.message);
  }
}

// ── ANÁLISIS PRINCIPAL ────────────────────────────────

async function runAnalysis() {
  console.log(`\n📊 Análisis iniciado: ${new Date().toLocaleString()}`);

  for (const crypto of CRYPTOCURRENCIES) {
    const analysis = await analyzeCrypto(crypto);
    if (!analysis) continue;
    await new Promise(resolve => setTimeout(resolve, 2000));

    const { buyConfidence, sellConfidence, rsi, currentPrice } = analysis;

    // Verificar stop loss
    if (userPositions[crypto]) {
      const entry = userPositions[crypto].entry;
      const loss = ((parseFloat(currentPrice) - entry) / entry * 100);
      if (loss <= -userStopLoss) {
        await sendTelegramMessage(
          `🚨 <b>STOP LOSS - ${crypto}</b>\n\n💰 Precio: $${currentPrice}\n🏁 Entrada: $${entry}\n📉 Pérdida: ${loss.toFixed(2)}%\n\n⚠️ Considera vender para limitar pérdidas.`
        );
      }
    }

    if (buyConfidence >= 70 && !userPositions[crypto]) {
      const message = `
🟢 <b>SEÑAL DE COMPRA - ${crypto}</b>

💰 Precio actual: $${currentPrice}
📊 RSI: ${rsi}
📈 Confianza: ${buyConfidence.toFixed(0)}%

<b>Análisis:</b>
• RSI en zona de sobreventa
• Presión de compra detectada
• Oportunidad de entrada

¿Compraste?`;
      const buttons = [[
        { text: '✅ Sí, compré', callback_data: `buy_${crypto}_${currentPrice}` },
        { text: '❌ Pasamos', callback_data: `skip_${crypto}` }
      ]];
      await sendTelegramMessage(message, buttons);
      userPositions[crypto] = { entry: parseFloat(currentPrice), timestamp: Date.now() };
      signalHistory.push({ type: 'BUY', crypto, price: currentPrice, confidence: buyConfidence.toFixed(0), time: new Date().toLocaleTimeString() });
    }

    if (sellConfidence >= 65 && userPositions[crypto]) {
      const entry = userPositions[crypto].entry;
      const profit = ((parseFloat(currentPrice) - entry) / entry * 100).toFixed(2);
      const message = `
🔴 <b>SEÑAL DE VENTA - ${crypto}</b>

💰 Precio actual: $${currentPrice}
📊 RSI: ${rsi}
📉 Confianza: ${sellConfidence.toFixed(0)}%
🏁 Tu entrada: $${entry}
📊 Ganancia: ${profit}%

<b>Análisis:</b>
• RSI en zona de sobrecompra
• Máximo local detectado
• Presión bajista fuerte

¿Vendiste?`;
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
  console.log('🤖 Bot de Trading iniciado...');
  console.log(`📊 Analizando: ${CRYPTOCURRENCIES.join(', ')}`);

  await sendTelegramMessage('🤖 <b>Bot de Trading iniciado!</b>\n\nAnalizando: BTC, ETH, BNB, SOL, XRP, ADA\nRecibirás alertas cada 5 minutos.\n\nComandos:\n/status - Posiciones abiertas\n/precios - Precios actuales\n/historial - Señales de hoy\n/stoploss - Configurar stop loss');

  await runAnalysis();
  setInterval(runAnalysis, ANALYSIS_INTERVAL);
  setInterval(handleBotUpdates, 3000);
}

startBot().catch(error => {
  console.error('❌ Error al iniciar bot:', error);
  process.exit(1);
});
