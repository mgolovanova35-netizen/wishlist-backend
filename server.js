const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

// --- Настройки (заменяются через переменные окружения) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️ Предупреждение: не заданы переменные окружения");
}

const app = express();
app.use(cors());
app.use(express.json());

// Универсальный запрос к Supabase REST API
async function supabaseQuery(table, method = 'GET', body = null, filters = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.append(key, value);
  }

  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': method === 'POST' ? 'return=representation' : ''
  };

  const config = { method, url: url.toString(), headers };
  if (body) config.data = body;

  try {
    const res = await axios(config);
    return res.data;
  } catch (err) {
    console.error('Supabase error:', err.response?.data || err.message);
    throw err;
  }
}

// Проверка подлинности Telegram init data
function verifyInitData(initDataStr) {
  if (!initDataStr) return null;
  const params = new URLSearchParams(initDataStr);
  const hash = params.get('hash');
  if (!hash) return null;

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(dataCheckString);
  const computedHash = hmac.digest('hex');

  if (computedHash !== hash) return null;

  try {
    const userStr = params.get('user');
    const user = userStr ? JSON.parse(decodeURIComponent(userStr)) : null;
    return user;
  } catch (e) {
    return null;
  }
}

// --- Эндпоинты ---

// Получение списка подарков
app.post('/api/items', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

  const owner_id = user.id;

  // Получаем или создаём вишлист
  let wishlists = await supabaseQuery('wishlists', 'GET', null, { owner_id: `eq.${owner_id}` });
  if (wishlists.length === 0) {
    wishlists = await supabaseQuery('wishlists', 'POST', { owner_id });
  }
  const wishlist = wishlists[0];

  // Получаем товары
  const items = await supabaseQuery('wishlist_items', 'GET', null, {
    wishlist_id: `eq.${wishlist.id}`,
    select: '*'
  });

  res.json({
    success: true,
    owner_id,
    owner_name: user.first_name,
    items
  });
});

// Добавление товара
app.post('/api/items/add', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

  const wishlists = await supabaseQuery('wishlists', 'GET', null, { owner_id: `eq.${user.id}` });
  if (wishlists.length === 0) {
    return res.status(400).json({ success: false, error: "Сначала открой свой вишлист" });
  }

  const newItem = {
    wishlist_id: wishlists[0].id,
    url: req.body.url,
    title: req.body.title || '',
    image: req.body.image || '',
    note: req.body.note || '',
    price: req.body.price || ''
  };

  await supabaseQuery('wishlist_items', 'POST', newItem);
  res.json({ success: true });
});

// Парсинг ссылки
app.post('/api/parse', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

  const { url } = req.body;
  if (!url) return res.json({ success: false, error: "URL не указан" });

  try {
    let parser;
    if (url.includes('wildberries.ru')) parser = parseWB;
    else if (url.includes('ozon.ru')) parser = parseOzon;
    else if (url.includes('market.yandex.ru') || url.includes('yandex.ru')) parser = parseYandex;
    else parser = parseGeneric;

    const result = await parser(url);
    res.json({ success: true, ...result, url });
  } catch (e) {
    res.json({ success: false, error: "Не удалось обработать ссылку" });
  }
});

// Резервация подарка
app.post('/api/reserve', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ success: false, error: "Unauthorized" });

  const { item_id } = req.body;
  if (!item_id) return res.json({ success: false, error: "item_id не указан" });

  // Проверяем, свободен ли подарок
  const items = await supabaseQuery('wishlist_items', 'GET', null, {
    id: `eq.${item_id}`,
    reserved_by: 'is.null'
  });

  if (items.length === 0) {
    return res.json({ success: false, error: "Подарок уже забронирован или не существует" });
  }

  // Бронируем
  await supabaseQuery('wishlist_items', 'PATCH', {
    reserved_by: user.id,
    reserved_name: user.first_name,
    reserved_at: new Date().toISOString()
  }, { id: `eq.${item_id}` });

  res.json({ success: true });
});

// --- Парсеры ---
async function parseWB(url) {
  const sku = url.match(/catalog\/(\d+)/)?.[1] || url.match(/product\/(\d+)/)?.[1];
  if (!sku) throw new Error("Не найден артикул");
  const apiRes = await axios.get(`https://card.wb.ru/cards/detail?nm=${sku}`);
  const product = apiRes.data.data.products[0];
  if (!product) throw new Error("Товар не найден");
  return {
    title: product.name,
    price: `${product.salePriceU / 100} ₽`,
    image: `https://basket-${String(product.nmId)[0]}.wbbasket.ru/vol${Math.floor(product.nmId / 100000)}/part${Math.floor(product.nmId / 1000)}/${product.nmId}/images/big/1.jpg`
  };
}

async function parseOzon(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content') || $('title').text().replace(' – Ozon', '');
  const image = $('meta[property="og:image"]').attr('content');
  let price = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const json = JSON.parse($(el).text());
      if (json?.offers?.price) price = `${json.offers.price} ₽`;
    } catch (e) {}
  });
  return { title, image, price };
}

async function parseYandex(url) {
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const title = $('meta[property="og:title"]').attr('content') || $('title').text();
  const image = $('meta[property="og:image"]').attr('content');
  let price = null;
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const data = JSON.parse($(el).text());
      if (data.offers?.price) price = `${data.offers.price} ₽`;
    } catch (e) {}
  });
  return { title, image, price };
}

async function fetchPage(url) {
  const response = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WishlistBot/1.0)' }
  });
  return response.data;
}

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
});