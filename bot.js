const axios = require('axios');

// Configuración
const TELEGRAM_BOT_TOKEN = '8756381855:AAH1cjj2bogwVfl0tP5yRcRfX7lZHJFohdQ';
const TELEGRAM_CHAT_ID = '8173449171';
const CRYPTOCURRENCIES = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA'];
const ANALYSIS_INTERVAL = 5 * 60 * 1000; // 5 minutos

// Variables globales para monitoreo
let userPositions = {};
let priceHistory = {};

// Inicializar histórico de precios
CRYPTOCURRENCIES.forEach(crypto => {
  priceHistory[crypto] = [];
});

// Enviar mensaje a Telegram
async function sendTelegramMessage(message, buttons = null) {
  try {
    const payload = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    };

    if (buttons) {
      payload.reply_markup = {
        inline_keyboard: buttons
      };
    }

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      payload
    );
    console.log(`✅ Mensaje enviado a Telegram: ${message.substring(0, 50)}...`);
  } catch (error) {
    console.error('❌ Error enviando mensaje a Telegram:', error.message);
  }
}

// Obtener precio actual
async function getCurrentPrice(crypto) {
  try {
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${crypto.toLowerCase()}&vs_currencies=usd&include_market_cap=true&include_24hr_vol=true`
    );
    
    const priceData = response.data[crypto.toLowerCase()];
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

// Calcular RSI
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = prices.length - period; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / (avgLoss || 1);
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

// Calcular Bollinger Bands
function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) return null;

  const recentPrices = prices.slice(-period);
  const sma = recentPrices.reduce((a, b) => a + b) / period;
  
  const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + (std * stdDev),
    middle: sma,
    lower: sma - (std * stdDev)
  };
}

// Detectar máximos y mínimos locales
function detectLocalExtremes(prices, window = 3) {
  if (prices.length < window * 2 + 1) return { localMax: false, localMin: false };

  const lastIndex = prices.length - 1;
  const current = prices[lastIndex];
  const start = Math.max(0, lastIndex - window);
  const end = Math.min(prices.length - 1, lastIndex + window);

  let isLocalMax = true;
  let isLocalMin = true;

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

// Analizar presión de venta
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

// Análisis técnico completo
async function analyzeCrypto(crypto) {
  const priceData = await getCurrentPrice(crypto);
  if (!priceData) return null;

  const currentPrice = priceData.price;
  
  // Mantener histórico de precios (últimas 100 velas)
  if (!priceHistory[crypto]) {
    priceHistory[crypto] = [];
  }
  priceHistory[crypto].push(currentPrice);
  if (priceHistory[crypto].length > 100) {
    priceHistory[crypto].shift();
  }

  const prices = priceHistory[crypto];

  // Calcular indicadores
  const rsi = calculateRSI(prices);
  const bb = calculateBollingerBands(prices);
  const extremes = detectLocalExtremes(prices);
  const sellPressure = analyzeSellPressure(prices);

  // Lógica de análisis
  let buyConfidence = 0;
  let sellConfidence = 0;

  if (rsi !== null) {
    // Señales de COMPRA
    if (rsi < 30) buyConfidence += 25; // Sobreventa
    if (rsi < 35) buyConfidence += 15;
    
    // Señales de VENTA
    if (rsi > 70) sellConfidence += 25; // Sobrecompra
    if (rsi > 65) sellConfidence += 15;
  }

  if (bb) {
    // Precio tocando o bajo banda inferior = oportunidad de compra
    if (currentPrice <= bb.lower * 1.02) buyConfidence += 20;
    
    // Precio en banda superior = oportunidad de venta
    if (currentPrice >= bb.upper * 0.98) sellConfidence += 20;
  }

  // Máximos/mínimos locales
  if (extremes.localMin) buyConfidence += 15;
  if (extremes.localMax) sellConfidence += 15;

  // Presión de venta
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

// Ejecutar análisis y enviar alertas
async function runAnalysis() {
  console.log(`\n📊 Análisis iniciado: ${new Date().toLocaleString()}`);

  for (const crypto of CRYPTOCURRENCIES) {
    const analysis = await analyzeCrypto(crypto);
    if (!analysis) continue;

    const { buyConfidence, sellConfidence, rsi, currentPrice } = analysis;

    // ALERTA DE COMPRA (70% confianza)
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

¿Compraste?
      `;

      const buttons = [[
        { text: '✅ Sí, compré', callback_data: `buy_${crypto}_${currentPrice}` },
        { text: '❌ Pasamos', callback_data: `skip_${crypto}` }
      ]];

      await sendTelegramMessage(message, buttons);
      userPositions[crypto] = { entry: parseFloat(currentPrice), timestamp: Date.now() };
    }

    // ALERTA DE VENTA (65% confianza + posición abierta)
    if (sellConfidence >= 65 && userPositions[crypto]) {
      const entry = userPositions[crypto].entry;
      const profit = ((parseFloat(currentPrice) - entry) / entry * 100).toFixed(2);

      const message = `
🔴 <b>SEÑAL DE VENTA - ${crypto}</b>

💰 Precio actual: $${currentPrice}
📊 RSI: ${rsi}
📉 Confianza: ${sellConfidence.toFixed(0)}%
💵 Tu entrada: $${entry}
📈 Ganancia: ${profit}%

<b>Análisis:</b>
• RSI en zona de sobrecompra
• Máximo local detectado
• Presión bajista fuerte

¿Vendiste?
      `;

      const buttons = [[
        { text: '✅ Sí, vendí', callback_data: `sell_${crypto}_${currentPrice}` },
        { text: '❌ Sigo esperando', callback_data: `hold_${crypto}` }
      ]];

      await sendTelegramMessage(message, buttons);
    }
  }

  console.log('✅ Análisis completado');
}

// Manejo de mensajes del bot (para futuros updates)
async function handleBotUpdates() {
  try {
    const response = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`
    );
    // Aquí puedes procesar callbacks cuando el usuario haga click en botones
    // Por ahora solo es informativo
  } catch (error) {
    console.error('Error obteniendo updates:', error.message);
  }
}

// Iniciar bot
async function startBot() {
  console.log('🤖 Bot de Trading iniciado...');
  console.log(`📡 Analizando: ${CRYPTOCURRENCIES.join(', ')}`);
  console.log(`⏱️  Frecuencia: Cada ${ANALYSIS_INTERVAL / 1000 / 60} minutos`);

  // Primer análisis inmediato
  await runAnalysis();

  // Análisis repetido cada 5 minutos
  setInterval(runAnalysis, ANALYSIS_INTERVAL);

  // Mantener el proceso vivo
  setInterval(handleBotUpdates, 30000);
}

// Iniciar
startBot().catch(error => {
  console.error('❌ Error al iniciar bot:', error);
  process.exit(1);
});
