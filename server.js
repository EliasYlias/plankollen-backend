// server.js
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const DATA_FILE = './fields.json';

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}

// ─── Kända planer med deras Interbook GO resource-ID ─────────────────────
const PLANS = [
  { id: 33, name: 'Skytteholms IP - 11-plan A', surface: 'Konstgräs', area: 'Solna' },
  { id: 34, name: 'Skytteholms IP - 11-plan B', surface: 'Konstgräs', area: 'Solna' },
  { id: 31, name: 'Skytteholms IP - 11-plan C', surface: 'Konstgräs', area: 'Solna' },
];

const SPONTAN_FIELDS = [
  {
    id: 'spontan-nackros',
    name: 'Näckrosparken',
    area: 'Råsunda',
    surface: 'Grus',
    openingHours: { open: '07:00', close: '22:00' },
    bookings: [],
    isSpontan: true,
  },
  {
    id: 'spontan-lunden',
    name: 'Lundens IP',
    area: 'Solna',
    surface: 'Gräs',
    openingHours: { open: '00:00', close: '23:59' },
    bookings: [],
    isSpontan: true,
  },
];

// ─── API endpoint ─────────────────────────────────────────────────────────
app.get('/api/fields', (req, res) => {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    res.json(JSON.parse(data));
  } catch (e) {
    res.json([]);
  }
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', lastUpdated: new Date().toISOString() });
});

// ─── Hjälpfunktioner ──────────────────────────────────────────────────────
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-');
}

function toHHMM(val) {
  if (!val) return null;
  if (typeof val === 'string' && /^\d{2}:\d{2}/.test(val)) return val.slice(0, 5);
  const d = new Date(val);
  if (isNaN(d)) return null;
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// Hämta dagens datum i formatet YYYY-MM-DD
function getDateRange() {
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);
  const end = new Date(today);
  end.setHours(23, 59, 59, 0);

  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  return { startDate: fmt(start), endDate: fmt(end) };
}

// ─── Hämta bokningar för en plan direkt via GetBookings API ───────────────
async function fetchBookingsForPlan(resourceId) {
  const { startDate, endDate } = getDateRange();
  const timestamp = Date.now();

  const url =
    `https://solna.ibgo.se/BookingApi/GetBookings` +
    `?start=${encodeURIComponent(startDate + ' 00:00')}` +
    `&end=${encodeURIComponent(endDate + ' 23:59')}` +
    `&timestamp=${timestamp}` +
    `&isPublic=true` +
    `&resources%5B0%5D=${resourceId}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'sv-SE,sv;q=0.9',
      'Referer': 'https://solna.ibgo.se/Booking/Search',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': 'IBGO_Release=4q0aavwvg5vcqo0sybplsj3v; _culture=SV-SE; _dateFormat=Y-m-d; _dateFormatCSharp=yyyy-MM-dd; _dateFormatMoment=YYYY-MM-DD; _firstDayOfWeek=1; _cartTimeoutValue=; _timeoutValue=; _showCookieWarningIBGO=ShowCookieWarning=false; _clientTimeOffset=986; _serverTimeValue=2026-05-16 23:22:34',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();

  if (resourceId === 33) {
    fs.writeFileSync('./debug-getbookings.json', JSON.stringify(data, null, 2));
  }

  return parseBookings(data);
}

// ─── Parsa bokningar från API-svaret ─────────────────────────────────────
function parseBookings(data) {
  const candidates = [
    data,
    data?.bookings,
    data?.events,
    data?.items,
    data?.result,
    data?.data,
  ];

  const arr = candidates.find((c) => Array.isArray(c) && c.length > 0);
  if (!arr) return [];

  return arr
    .filter((b) => b.status === 'booked' && b.type !== 'closed')
    .map((b) => {
      const start = toHHMM(b.start);
      const end = toHHMM(b.end);
      const title = String(
        b.description
          ? b.description.replace(/<br><br>/g, ' — ').replace(/<[^>]+>/g, '')
          : b.title || 'Bokning'
      );
      return start && end ? { start, end, title } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// ─── Huvudskraparen ───────────────────────────────────────────────────────
async function scrapeFields() {
  console.log('🔍 Hämtar bokningar...');

  const scrapedFields = [];

  for (const plan of PLANS) {
    try {
      const bookings = await fetchBookingsForPlan(plan.id);
      console.log(`  ✅ ${plan.name}: ${bookings.length} bokningar`);
      scrapedFields.push({
        id: slugify(plan.name),
        name: plan.name,
        area: plan.area,
        surface: plan.surface,
        openingHours: { open: '08:00', close: '23:00' },
        bookings,
        isSpontan: false,
      });
    } catch (err) {
      console.error(`  ❌ Fel för ${plan.name}:`, err.message);
      scrapedFields.push({
        id: slugify(plan.name),
        name: plan.name,
        area: plan.area,
        surface: plan.surface,
        openingHours: { open: '08:00', close: '23:00' },
        bookings: [],
        isSpontan: false,
      });
    }
  }

  const allFields = [...scrapedFields, ...SPONTAN_FIELDS];
  fs.writeFileSync(DATA_FILE, JSON.stringify(allFields, null, 2));
  console.log(`✅ ${allFields.length} planer sparade`);
}

// ─── Kör vid start + var 15:e minut ──────────────────────────────────────
scrapeFields();
cron.schedule('*/15 * * * *', scrapeFields);

// ─── Starta servern ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Plankollen-backend kör på port ${PORT}`);
});