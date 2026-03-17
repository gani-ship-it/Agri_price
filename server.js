/* ============================================================
   AgriPrice Portal - server.js
   Database: MySQL (Railway)
   APIs: Gemini AI, OpenWeatherMap, Agmarknet
   ============================================================ */

const express = require('express');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const mysql   = require('mysql2/promise');

const app  = express();
const PORT = process.env.PORT || 3000;

// Load .env for local dev
try {
  const fs  = require('fs');
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key && val.length) process.env[key.trim()] = val.join('=').trim();
  });
} catch (e) {}

const GEMINI_API_KEY  = process.env.GEMINI_API_KEY  || '';
const WEATHER_API_KEY = process.env.WEATHER_API_KEY || '';

// ── DATABASE CONNECTION ───────────────────────────────────────
// Railway provides MYSQL_URL automatically when you add MySQL plugin
// For local: set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME in .env
let db;

async function connectDB() {
  try {
    // Railway MySQL URL format: mysql://user:password@host:port/database
    if (process.env.MYSQL_URL || process.env.DATABASE_URL) {
      db = await mysql.createPool(process.env.MYSQL_URL || process.env.DATABASE_URL);
    } else {
      db = await mysql.createPool({
        host:     process.env.DB_HOST     || 'localhost',
        user:     process.env.DB_USER     || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME     || 'agriprice',
        port:     process.env.DB_PORT     || 3306,
        waitForConnections: true,
        connectionLimit: 10,
      });
    }

    // Create tables if they don't exist
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        phone      VARCHAR(15)  NOT NULL UNIQUE,
        password   VARCHAR(255) NOT NULL,
        role       ENUM('farmer','buyer') NOT NULL,
        location   VARCHAR(200),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS listings (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        farmer_id       INT NOT NULL,
        farmer_name     VARCHAR(100),
        farmer_contact  VARCHAR(15),
        name            VARCHAR(100) NOT NULL,
        emoji           VARCHAR(10),
        qty             DECIMAL(10,2) NOT NULL,
        price           DECIMAL(10,2) NOT NULL,
        location        VARCHAR(200),
        description     TEXT,
        available_until DATE,
        lat             DECIMAL(10,7),
        lng             DECIMAL(10,7),
        posted_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS orders (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        buyer_id        INT NOT NULL,
        buyer_name      VARCHAR(100),
        buyer_phone     VARCHAR(15),
        farmer_id       INT NOT NULL,
        farmer_name     VARCHAR(100),
        farmer_contact  VARCHAR(15),
        listing_id      INT,
        crop_name       VARCHAR(100),
        crop_emoji      VARCHAR(10),
        qty             DECIMAL(10,2),
        price_per_kg    DECIMAL(10,2),
        total_price     DECIMAL(12,2),
        location        VARCHAR(200),
        message         TEXT,
        status          ENUM('Pending','Confirmed','Delivered','Cancelled') DEFAULT 'Pending',
        placed_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (buyer_id)  REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (farmer_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        user_id    INT NOT NULL,
        message    TEXT NOT NULL,
        type       VARCHAR(20),
        is_read    BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    console.log('  Database    : Connected & tables ready');
  } catch (err) {
    console.error('  Database    : FAILED -', err.message);
    console.error('  Make sure MySQL is running and .env has correct DB credentials');
    db = null;
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// ── DB CHECK MIDDLEWARE ───────────────────────────────────────
function requireDB(req, res, next) {
  if (!db) return res.status(503).json({ error: 'Database not connected. Check your DB settings.' });
  next();
}

// ── HELPER: HTTP GET ──────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Failed to parse response')); }
      });
    }).on('error', reject)
      .setTimeout(10000, function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

// ══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', requireDB, async (req, res) => {
  const { name, phone, password, role, location } = req.body;
  if (!name || !phone || !password || !role) return res.status(400).json({ error: 'All fields required.' });
  if (phone.length < 10) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });

  try {
    const [existing] = await db.execute('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existing.length > 0) return res.status(400).json({ error: 'This phone number is already registered.' });

    const [result] = await db.execute(
      'INSERT INTO users (name, phone, password, role, location) VALUES (?, ?, ?, ?, ?)',
      [name, phone, password, role, location || '']
    );
    const user = { id: result.insertId, name, phone, role, location: location || '' };
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', requireDB, async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'Phone and password required.' });

  try {
    const [rows] = await db.execute(
      'SELECT id, name, phone, role, location FROM users WHERE phone = ? AND password = ?',
      [phone, password]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid phone number or password.' });
    res.json({ success: true, user: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  LISTINGS ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/listings — all listings (for buyers)
app.get('/api/listings', requireDB, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM listings ORDER BY posted_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/listings/my?farmerId=X — farmer's own listings
app.get('/api/listings/my', requireDB, async (req, res) => {
  const { farmerId } = req.query;
  try {
    const [rows] = await db.execute(
      'SELECT * FROM listings WHERE farmer_id = ? ORDER BY posted_at DESC',
      [farmerId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/listings — add new listing
app.post('/api/listings', requireDB, async (req, res) => {
  const { farmerId, farmerName, farmerContact, name, emoji, qty, price, location, description, availableUntil, lat, lng } = req.body;
  if (!farmerId || !name || !qty || !price) return res.status(400).json({ error: 'Missing required fields.' });

  try {
    const [result] = await db.execute(
      `INSERT INTO listings (farmer_id, farmer_name, farmer_contact, name, emoji, qty, price, location, description, available_until, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [farmerId, farmerName, farmerContact, name, emoji, qty, price, location || '', description || '', availableUntil || null, lat || null, lng || null]
    );
    const [rows] = await db.execute('SELECT * FROM listings WHERE id = ?', [result.insertId]);
    res.json({ success: true, listing: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/listings/:id
app.delete('/api/listings/:id', requireDB, async (req, res) => {
  try {
    await db.execute('DELETE FROM listings WHERE id = ? AND farmer_id = ?', [req.params.id, req.body.farmerId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  ORDERS ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/orders — place new order
app.post('/api/orders', requireDB, async (req, res) => {
  const { buyerId, buyerName, buyerPhone, farmerId, farmerName, farmerContact,
          listingId, cropName, cropEmoji, qty, pricePerKg, totalPrice, location, message } = req.body;

  try {
    const [result] = await db.execute(
      `INSERT INTO orders (buyer_id, buyer_name, buyer_phone, farmer_id, farmer_name, farmer_contact,
        listing_id, crop_name, crop_emoji, qty, price_per_kg, total_price, location, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [buyerId, buyerName, buyerPhone, farmerId, farmerName, farmerContact,
       listingId, cropName, cropEmoji, qty, pricePerKg, totalPrice, location, message || '']
    );

    // Notify farmer
    await db.execute(
      'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
      [farmerId, `New order from ${buyerName} for ${qty} kg of ${cropName} (Rs.${totalPrice})`, 'order']
    );

    res.json({ success: true, orderId: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/farmer?farmerId=X
app.get('/api/orders/farmer', requireDB, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM orders WHERE farmer_id = ? ORDER BY placed_at DESC',
      [req.query.farmerId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/buyer?buyerId=X
app.get('/api/orders/buyer', requireDB, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM orders WHERE buyer_id = ? ORDER BY placed_at DESC',
      [req.query.buyerId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/orders/:id/status — update order status
app.patch('/api/orders/:id/status', requireDB, async (req, res) => {
  const { status, buyerId } = req.body;
  try {
    await db.execute('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);

    // Notify buyer
    const [orders] = await db.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (orders.length > 0) {
      const o = orders[0];
      const msgs = {
        'Confirmed': `Your order for ${o.qty} kg of ${o.crop_name} has been Confirmed by the farmer!`,
        'Delivered': `Your order for ${o.crop_name} has been Delivered!`,
        'Cancelled': `Your order for ${o.crop_name} was Cancelled by the farmer.`,
      };
      if (msgs[status]) {
        await db.execute(
          'INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)',
          [o.buyer_id, msgs[status], status === 'Cancelled' ? 'cancel' : 'update']
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  NOTIFICATIONS ROUTES
// ══════════════════════════════════════════════════════════════

// GET /api/notifications?userId=X
app.get('/api/notifications', requireDB, async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.query.userId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/read?userId=X — mark all as read
app.patch('/api/notifications/read', requireDB, async (req, res) => {
  try {
    await db.execute('UPDATE notifications SET is_read = TRUE WHERE user_id = ?', [req.query.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications?userId=X — clear all
app.delete('/api/notifications', requireDB, async (req, res) => {
  try {
    await db.execute('DELETE FROM notifications WHERE user_id = ?', [req.query.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
//  WEATHER API
// ══════════════════════════════════════════════════════════════
app.get('/api/weather', async (req, res) => {
  if (!WEATHER_API_KEY) return res.json({ error: 'Weather API key not configured', temp: null });
  try {
    let url;
    if (req.query.lat && req.query.lon) {
      url = `https://api.openweathermap.org/data/2.5/weather?lat=${req.query.lat}&lon=${req.query.lon}&appid=${WEATHER_API_KEY}&units=metric`;
    } else {
      url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(req.query.location || 'Bangalore')},IN&appid=${WEATHER_API_KEY}&units=metric`;
    }
    const data = await httpGet(url);
    if (data.cod !== 200) return res.json({ error: 'Location not found', temp: null });
    res.json({
      temp: Math.round(data.main.temp), humidity: data.main.humidity,
      rainfall: data.rain ? (data.rain['1h'] || data.rain['3h'] || 0) : 0,
      description: data.weather[0].description, city: data.name,
    });
  } catch (err) { res.json({ error: err.message, temp: null }); }
});

// ══════════════════════════════════════════════════════════════
//  MANDI PRICE API
// ══════════════════════════════════════════════════════════════
const FALLBACK_PRICES = {
  'rice':       { min: 1800, max: 2200, modal: 2000, market: 'Bangalore' },
  'wheat':      { min: 2000, max: 2400, modal: 2200, market: 'Bangalore' },
  'maize':      { min: 1400, max: 1800, modal: 1600, market: 'Davangere' },
  'tomato':     { min: 800,  max: 2000, modal: 1200, market: 'Kolar'     },
  'cotton':     { min: 5500, max: 6500, modal: 6000, market: 'Raichur'   },
  'sugarcane':  { min: 280,  max: 320,  modal: 300,  market: 'Mandya'    },
  'soybean':    { min: 3800, max: 4400, modal: 4100, market: 'Gulbarga'  },
  'groundnut':  { min: 4500, max: 5500, modal: 5000, market: 'Chitradurga' },
  'onion':      { min: 600,  max: 1800, modal: 1200, market: 'Bangalore' },
  'potato':     { min: 700,  max: 1400, modal: 1000, market: 'Hassan'    },
  'vegetables': { min: 500,  max: 2000, modal: 1000, market: 'Bangalore' },
  'fruits':     { min: 1500, max: 4000, modal: 2500, market: 'Bangalore' },
};

app.get('/api/mandi', async (req, res) => {
  const crop  = req.query.crop  || 'Tomato';
  const state = req.query.state || 'Karnataka';
  const urls  = [
    `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=579b464db66ec23bdd000001cdd3946e44ce4aab825ef8fe01018ffd&format=json&filters[Commodity]=${encodeURIComponent(crop)}&filters[State]=${encodeURIComponent(state)}&limit=5`,
    `https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070?api-key=579b464db66ec23bdd000001cdd3946e44ce4aab825ef8fe01018ffd&format=json&filters[commodity]=${encodeURIComponent(crop)}&limit=10`,
  ];
  for (const url of urls) {
    try {
      const data = await httpGet(url);
      if (data.records && data.records.length > 0) {
        return res.json({ success: true, source: 'live', crop, state, records: data.records.map(r => ({
          market: r.Market || r.District || 'N/A',
          min:    r.Min_x0020_Price || r.Min_Price || '-',
          max:    r.Max_x0020_Price || r.Max_Price || '-',
          modal:  r.Modal_x0020_Price || r.Modal_Price || '-',
          date:   r.Arrival_Date || 'Recent',
        }))});
      }
    } catch (e) {}
  }
  const fb = FALLBACK_PRICES[crop.toLowerCase()] || FALLBACK_PRICES['vegetables'];
  res.json({ success: true, source: 'fallback', crop, state, records: [{ ...fb, date: 'Reference price' }] });
});

// ══════════════════════════════════════════════════════════════
//  SOIL ANALYSIS
// ══════════════════════════════════════════════════════════════
function buildPrompt(formData) {
  const lines = [];
  if (formData.N    !== null) lines.push(`Nitrogen (N): ${formData.N} kg/ha`);
  if (formData.P    !== null) lines.push(`Phosphorus (P): ${formData.P} kg/ha`);
  if (formData.K    !== null) lines.push(`Potassium (K): ${formData.K} kg/ha`);
  if (formData.organicCarbon !== null) lines.push(`Organic Carbon: ${formData.organicCarbon}%`);
  if (formData.moisture    !== null) lines.push(`Moisture: ${formData.moisture}%`);
  if (formData.temperature !== null) lines.push(`Temperature: ${formData.temperature}C`);
  if (formData.humidity    !== null) lines.push(`Humidity: ${formData.humidity}%`);
  if (formData.rainfall    !== null) lines.push(`Rainfall: ${formData.rainfall}mm`);
  if (formData.ph)       lines.push(`pH: ${formData.ph}`);
  if (formData.soilType) lines.push(`Soil Type: ${formData.soilType}`);
  if (formData.location) lines.push(`Location: ${formData.location}`);
  if (formData.crop)     lines.push(`Target crop: ${formData.crop}`);

  return `You are AgriPrice Portal, an expert agricultural AI for Indian farmers.
Soil data: ${lines.join(', ')}
Respond ONLY with valid JSON (no markdown):
{"no_data":false,"fertility_rating":"Poor"|"Moderate"|"Good"|"Excellent","score":<0-100>,"summary":"<2 sentences>","extracted":{"N":<n>,"P":<n>,"K":<n>,"pH":<n>,"moisture":<n>,"temperature":<n>,"organicCarbon":<n>},"nutrient_status":{"N":"Low"|"Optimal"|"High","P":"Low"|"Optimal"|"High","K":"Low"|"Optimal"|"High","pH":"Acidic"|"Optimal"|"Alkaline","moisture":"Low"|"Optimal"|"High","organicCarbon":"Low"|"Optimal"|"High"},"crop_recommendations":[{"name":"<crop>","emoji":"<emoji>","suitability":"High"|"Medium"|"Low","reason":"<sentence>"},{"name":"<crop>","emoji":"<emoji>","suitability":"High"|"Medium"|"Low","reason":"<sentence>"},{"name":"<crop>","emoji":"<emoji>","suitability":"High"|"Medium"|"Low","reason":"<sentence>"},{"name":"<crop>","emoji":"<emoji>","suitability":"High"|"Medium"|"Low","reason":"<sentence>"}],"fertilizer_suggestions":[{"name":"<name>","dosage":"<dosage>","reason":"<reason>"},{"name":"<name>","dosage":"<dosage>","reason":"<reason>"},{"name":"<name>","dosage":"<dosage>","reason":"<reason>"}],"soil_health_tips":["<tip1>","<tip2>","<tip3>","<tip4>"],"detailed_advice":"<4-5 sentences>"}`;
}

function callGemini(parts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ contents:[{parts}], generationConfig:{temperature:0.2,maxOutputTokens:1500} });
    const req  = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      method:   'POST',
      headers:  { 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message));
          resolve(p?.candidates?.[0]?.content?.parts?.[0]?.text || '');
        } catch(e) { reject(new Error('Failed to parse Gemini response')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(body); req.end();
  });
}

function generateFallback(f) {
  const sc = (v,lo,hi) => (!v||isNaN(v))?50:v<lo?Math.max(10,(v/lo)*75):v>hi?Math.max(20,100-((v-hi)/hi)*40):80+((v-lo)/(hi-lo))*20;
  const nS=sc(f.N,80,200),pS=sc(f.P,20,80),kS=sc(f.K,100,350),phS=sc(f.ph,5.5,7.0),mS=sc(f.moisture,20,60);
  const s=Math.round(nS*.25+pS*.2+kS*.2+phS*.2+mS*.15);
  const r=s>=80?'Excellent':s>=60?'Good':s>=40?'Moderate':'Poor';
  return { no_data:false, fertility_rating:r, score:s,
    summary:`Your soil scores ${s}/100 — rated ${r}. ${s>=60?'Good for farming!':'Improvements needed.'}`,
    extracted:{N:f.N,P:f.P,K:f.K,pH:f.ph,moisture:f.moisture,temperature:f.temperature,organicCarbon:f.organicCarbon},
    nutrient_status:{N:nS<50?'Low':nS>85?'High':'Optimal',P:pS<50?'Low':pS>85?'High':'Optimal',K:kS<50?'Low':kS>85?'High':'Optimal',pH:phS<50?(f.ph<5.5?'Acidic':'Alkaline'):'Optimal',moisture:mS<50?'Low':mS>85?'High':'Optimal',organicCarbon:'Optimal'},
    crop_recommendations:[{name:'Rice',emoji:'🌾',suitability:'High',reason:'Good NPK for paddy.'},{name:'Wheat',emoji:'🌿',suitability:'High',reason:'Suitable nutrient levels.'},{name:'Maize',emoji:'🌽',suitability:'Medium',reason:'Good with potassium.'},{name:'Vegetables',emoji:'🥬',suitability:'Medium',reason:'Fertile soil helps leafy crops.'}],
    fertilizer_suggestions:[{name:'Urea',dosage:'50 kg/acre',reason:'Boost nitrogen.'},{name:'DAP',dosage:'25 kg/acre',reason:'Improve phosphorus.'},{name:'MOP',dosage:'20 kg/acre',reason:'Potassium support.'}],
    soil_health_tips:['Add organic compost.','Practice crop rotation.','Test soil every 6 months.','Avoid over-irrigation.'],
    detailed_advice:'Focus on balanced NPK. Check pH and adjust. Maintain proper irrigation. Rotate crops each season.',
  };
}

app.post('/api/analyze', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API key not configured.' });
    if (!req.body.hasManualData) return res.status(400).json({ error: 'Please enter at least N, P, or K values.' });
    let result;
    try {
      const raw = await callGemini([{ text: buildPrompt(req.body) }]);
      result = JSON.parse(raw.replace(/```json/gi,'').replace(/```/g,'').trim());
      if (result.no_data) return res.status(400).json({ error: 'No soil data found.' });
    } catch (e) { result = generateFallback(req.body); }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve frontend
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Start
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('  AgriPrice Portal is running!');
    console.log(`  Open: http://localhost:${PORT}`);
    console.log('');
    console.log(GEMINI_API_KEY  ? '  Gemini API  : OK' : '  Gemini API  : MISSING');
    console.log(WEATHER_API_KEY ? '  Weather API : OK' : '  Weather API : MISSING');
    console.log('  Maps        : Leaflet + OpenStreetMap (free)');
    console.log('');
  });
});