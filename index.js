const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));
app.options('*', cors());

function saveRawBody(req, res, buf) {
  if (req.originalUrl === '/webhook/razorpay') {
    req.rawBody = buf;
  }
}

app.use(bodyParser.json({ verify: saveRawBody, limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ Upstash Redis
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisSet(key, value, exSeconds) {
  try {
    const cmd = ['SET', key, JSON.stringify(value)];
    if (exSeconds) { cmd.push('EX'); cmd.push(String(exSeconds)); }
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([cmd]),
    });
    return res.ok;
  } catch (err) {
    console.error('Redis SET error:', err?.message || err);
    return false;
  }
}

async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    if (data.result === null || data.result === undefined) return null;
    return JSON.parse(data.result);
  } catch (err) {
    console.error('Redis GET error:', err?.message || err);
    return null;
  }
}

// Razorpay
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error('❌ Missing Razorpay credentials.');
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID || '',
  key_secret: RAZORPAY_KEY_SECRET || '',
});

const SUPPORTED_CURRENCY = 'INR';
const FIXED_AMOUNT = Number(process.env.FIXED_AMOUNT || 2000);
const SHARE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 din

function createShareId() {
  return `s${crypto.randomBytes(3).toString('hex')}-${Date.now().toString(36)}`;
}

// ✅ Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    razorpay: RAZORPAY_KEY_ID ? 'connected' : 'missing keys',
    redis: UPSTASH_URL ? 'connected' : 'missing config',
  });
});

// ✅ Save share - 7 din TTL
app.post('/save-share', async (req, res) => {
  const { html, base, allPages } = req.body;

  if (!html && !allPages) {
    return res.status(400).json({ error: 'Missing shared HTML content.' });
  }

  const shareId = createShareId();
  const shareData = {
    html: html || null,
    allPages: allPages || null,
    base: base || '',
    createdAt: new Date().toISOString(),
    published: false,
    payment: null,
  };

  const saved = await redisSet(`share:${shareId}`, shareData, SHARE_TTL_SECONDS);

  if (!saved) {
    return res.status(500).json({ error: 'Failed to save share. Try again.' });
  }

  console.log(`✅ Share saved: ${shareId}`);
  res.json({ shareId });
});

// ✅ Get share
app.get('/share/:shareId', async (req, res) => {
  const shareId = req.params.shareId;
  const share = await redisGet(`share:${shareId}`);

  if (!share) {
    return res.status(404).json({ error: 'Share link not found or expired.' });
  }

  res.json(share);
});

// ✅ Create Razorpay order
app.post('/create-order', async (req, res) => {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    return res.status(500).json({ error: 'Razorpay keys not configured.' });
  }

  try {
    const amount = Number(req.body.amount || FIXED_AMOUNT);
    const currency = String(req.body.currency || SUPPORTED_CURRENCY).toUpperCase();

    if (currency !== SUPPORTED_CURRENCY) {
      return res.status(400).json({ error: 'Only INR supported.' });
    }

    if (amount !== FIXED_AMOUNT) {
      return res.status(400).json({ error: `Amount must be ${FIXED_AMOUNT} paise.` });
    }

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `receipt_${Date.now()}`,
      payment_capture: 1,
      notes: req.body.notes || {},
    });

    console.log(`✅ Order created: ${order.id}`);
    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('❌ Order failed:', error?.message || error);
    const message = error?.error_description || error?.description || error?.message || 'Unable to create order.';
    res.status(error?.statusCode || 500).json({ error: `Unable to create Razorpay order. ${message}` });
  }
});

// ✅ Verify payment
app.post('/verify-payment', async (req, res) => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields.' });
  }

  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (generatedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed.' });
  }

  try {
    const shareId = req.body.notes?.shareId;
    if (shareId) {
      const share = await redisGet(`share:${shareId}`);
      if (share) {
        share.published = true;
        share.payment = {
          payment_id: razorpay_payment_id,
          order_id: razorpay_order_id,
          verifiedAt: new Date().toISOString(),
        };
        await redisSet(`share:${shareId}`, share, SHARE_TTL_SECONDS);
        console.log(`✅ Share ${shareId} published`);
      }
    }
  } catch (e) {
    console.log('Share update error:', e?.message);
  }

  res.json({
    success: true,
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
  });
});

// ✅ Webhook
app.post('/webhook/razorpay', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const bodyBuffer = req.rawBody || Buffer.from(JSON.stringify(req.body), 'utf8');

  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  try {
    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(bodyBuffer)
      .digest('hex');

    if (expected !== signature) return res.status(400).json({ error: 'Invalid signature' });

    const payload = JSON.parse(bodyBuffer.toString('utf8'));
    let shareId = null;
    try {
      const p = payload?.payload;
      shareId = p?.payment?.entity?.notes?.shareId || p?.order?.entity?.notes?.shareId || null;
    } catch (e) {}

    if (shareId) {
      const share = await redisGet(`share:${shareId}`);
      if (share) {
        share.published = true;
        share.payment = { ...share.payment, webhook: { event: payload.event, receivedAt: new Date().toISOString() } };
        await redisSet(`share:${shareId}`, share, SHARE_TTL_SECONDS);
        console.log(`✅ Webhook: Share ${shareId} published`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Webhook failed:', err?.message || err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// Local only
if (process.env.NODE_ENV !== 'production') {
  function startServer(startPort, maxRetries = 5) {
    let port = Number(startPort) || 4000;
    let attempts = 0;
    function tryListen() {
      const server = app.listen(port, () => {
        console.log(`✅ Backend running on http://localhost:${port}`);
      });
      server.on('error', (err) => {
        if (err?.code === 'EADDRINUSE' && attempts++ < maxRetries) {
          port += 1;
          setTimeout(tryListen, 250);
        } else {
          console.error('Server error:', err);
          process.exit(1);
        }
      });
    }
    tryListen();
  }
  startServer(PORT);
}

module.exports = app;
