'use strict';
// 24CARCARE - zero-dependency Node 22 app (node:sqlite). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const PORT = +process.env.PORT || 3000, DATA = path.join(__dirname, 'data'), SITE = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || 'https://24carcare.co.uk';
// PREVIEW_MODE=1: private test deployment. Site is behind HTTP Basic Auth (PREVIEW_USER / PREVIEW_PASSWORD), emails are never sent, search engines are told to stay away.
const PREVIEW = !!process.env.PREVIEW_MODE;
const PUB = fs.existsSync(path.join(__dirname, 'public', 'app.css')) ? path.join(__dirname, 'public') : __dirname;   // works from the folder layout or a flat upload
const ASSETS = new Set(['app.css', 'app.js', 'booking.js', 'pricing.js', 'contact.js']);
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA, 'app.db'));
db.exec(`CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT);
CREATE TABLE IF NOT EXISTS bookings(id INTEGER PRIMARY KEY,ref TEXT UNIQUE,status TEXT DEFAULT 'pending',size TEXT,service TEXT,price_pence INTEGER,pay TEXT,
 date TEXT,start_min INTEGER,block_min INTEGER,reg TEXT,vehicle TEXT,colour TEXT,name TEXT,phone TEXT,email TEXT,address TEXT,postcode TEXT,notes TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS b_date ON bookings(date);
CREATE TABLE IF NOT EXISTS blocks(id INTEGER PRIMARY KEY,date TEXT,start_min INTEGER,end_min INTEGER,reason TEXT);
CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY,title TEXT,before_file TEXT,after_file TEXT,sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY,to_addr TEXT,subject TEXT,body TEXT,status TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP);`);

// ---------- settings ----------
const DEF = {
  base: { quick: 34, valet: 79, full: 129 }, pct: { small: 0, medium: 12, large: 19 },
  packages: {
    quick: { name: 'Quick Wash', tag: 'Exterior only', desc: 'A fast, convenient exterior hand wash. Interior cleaning is not included.', duration: 'Approximately 30 minutes.', blockMin: 30, popular: false,
      includes: ['Exterior pre-rinse', 'Exterior hand wash', 'Exterior rinse', 'Exterior drying', 'Basic exterior finish'] },
    valet: { name: 'Full Valet', tag: 'Interior + exterior', desc: 'A comprehensive interior and exterior clean for a full professional refresh.', duration: '', blockMin: 120, popular: false,
      includes: ['Complete exterior wash', 'Interior vacuuming', 'Dashboard and interior surface cleaning', 'Interior detailing', 'Door shuts cleaning', 'Interior and exterior finishing'] },
    full: { name: 'Full Service', tag: 'Most comprehensive', desc: 'Everything in the Full Valet, plus polish and engine bay cleaning.', duration: '', blockMin: 210, popular: false,
      includes: ['Everything in the Full Valet package', 'Professional vehicle polishing', 'Engine bay cleaning'] } },
  hours: Object.fromEntries([0,1,2,3,4,5,6].map(d => [d, { open: '08:00', close: '20:00', closed: false }])),
  interval: 30, buffer: 30, capacity: 1,
  contact: { phone: '', email: 'salam.abubakr24@gmail.com', whatsapp: '', facebook: '', instagram: '', notifyEmail: 'salam.abubakr24@gmail.com' },
  areas: ['Gloucester', 'Cheltenham', 'Tewkesbury', 'Stroud', 'Bishops Cleeve'],
  about: '24CARCARE is a mobile car valeting and detailing service. We bring professional car care directly to your door across Gloucester and surrounding areas.',
  heroImage: ''
};
const getS = () => { const o = JSON.parse(JSON.stringify(DEF)); for (const r of db.prepare('SELECT * FROM settings').all()) o[r.k] = typeof o[r.k] === 'object' && !Array.isArray(o[r.k]) ? Object.assign(o[r.k], JSON.parse(r.v)) : JSON.parse(r.v); return o; };
const setS = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, JSON.stringify(v));

// ---------- pricing (single source of truth; integer pence, exact) ----------
const SIZES = ['small', 'medium', 'large'];
const pence = (S, size, svc) => Math.round(S.base[svc] * 100 * (100 + S.pct[size]) / 100);
const shown = p => Math.round(p / 100);               // customer-facing whole pounds
const exact = p => '£' + (p / 100).toFixed(2);
const priceTable = S => Object.fromEntries(SIZES.map(z => [z, Object.fromEntries(Object.keys(S.base).map(s => [s, pence(S, z, s)]))]));

// ---------- time (UK wall-clock, DST-safe) ----------
const ukNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
const toMin = t => { const [h, m] = t.split(':'); return +h * 60 + +m; };
const fmt = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const dow = d => new Date(d + 'T12:00:00Z').getUTCDay();
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T12:00:00Z'));

function slotsFor(S, date, blockMin, ignoreId, noBookings) {
  const now = ukNow(), h = S.hours[dow(date)]; if (!h || h.closed || date < now.date) return [];
  const open = toMin(h.open), close = toMin(h.close), out = [];
  const bks = noBookings ? [] : db.prepare("SELECT start_min s, block_min b FROM bookings WHERE date=? AND status!='cancelled' AND id IS NOT ?").all(date, ignoreId ?? null);
  const blks = db.prepare('SELECT start_min s, end_min e FROM blocks WHERE date=?').all(date);
  if (blks.some(b => b.s == null)) return [];                         // whole day blocked
  if (noBookings === 2) blks.length = 0;                              // capacity probe: ignore part-day blocks too
  for (let s = open; s + blockMin <= close; s += S.interval) {
    if (date === now.date && s <= now.min) continue;
    const e = s + blockMin; // travel/prep buffer is applied around every existing job
    if (blks.some(b => s < b.e && e > b.s)) continue;
    const clashes = bks.filter(b => s < b.s + b.b + S.buffer && e + S.buffer > b.s).length;
    if (clashes >= S.capacity) continue;
    out.push(s);
  } return out;
}

// ---------- email (Resend HTTP API if configured; otherwise logged honestly as NOT sent) ----------
async function mail(to, subject, body) {
  let status = PREVIEW ? 'preview_not_sent' : to ? 'not_configured' : 'no_recipient';
  if (!PREVIEW && to && process.env.RESEND_API_KEY && process.env.MAIL_FROM) {
    try { const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], reply_to: getS().contact.email || undefined, subject, text: body }) }); status = r.ok ? 'sent' : 'failed:' + r.status; } catch (e) { status = 'failed:network'; }
  }
  try { db.prepare('INSERT INTO outbox(to_addr,subject,body,status) VALUES(?,?,?,?)').run(to || '', subject, body, status); } catch (e) { console.error('outbox', e.message); } return status;
}

// ---------- auth ----------
const SECRET = process.env.SESSION_SECRET || (() => { const f = path.join(DATA, '.secret'); if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 }); return fs.readFileSync(f, 'utf8'); })();
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, h) => { const [s, x] = h.split(':'); const y = hashPw(pw, s).split(':')[1]; return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y)); };
if (!db.prepare("SELECT 1 FROM settings WHERE k='admin'").get()) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  setS('admin', { email: process.env.ADMIN_EMAIL || 'admin@24carcare.co.uk', hash: hashPw(pw) });
  if (!process.env.ADMIN_PASSWORD) console.log(`\n*** First run: admin login ${process.env.ADMIN_EMAIL || 'admin@24carcare.co.uk'} / ${pw}  (change via ADMIN_PASSWORD env on a fresh DB) ***\n`);
}
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url'); };
const verify = t => { if (!t) return null; const [b, s] = t.split('.'); if (!s || crypto.createHmac('sha256', SECRET).update(b).digest('base64url') !== s) return null; const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : null; };
const isAdmin = req => !!verify((/(?:^|; )adm=([^;]+)/.exec(req.headers.cookie || '') || [])[1]);
const hits = new Map(); const limited = (ip, key, max, ms) => { const k = key + ip, n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < ms); a.push(n); hits.set(k, a); return a.length > max; };

// ---------- validation ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PC = /^(GIR ?0AA|[A-PR-UWYZ]([0-9]{1,2}|([A-HK-Y][0-9]([0-9ABEHMNPRV-Y])?)|[0-9][A-HJKPS-UW]) ?[0-9][ABD-HJLNP-UW-Z]{2})$/i;
const normPhone = p => { let d = String(p).replace(/[\s()-]/g, ''); if (d.startsWith('+44')) d = '0' + d.slice(3); else if (d.startsWith('0044')) d = '0' + d.slice(4); return /^07\d{9}$/.test(d) ? d : /^0[1-3]\d{8,9}$/.test(d) ? d : null; };
const normPC = p => { const s = String(p).toUpperCase().replace(/\s+/g, ''); return PC.test(s) ? s.slice(0, -3) + ' ' + s.slice(-3) : null; };
const REG = /^[A-Z0-9 ]{2,8}$/i;

async function createBooking(b, ip) {
  const S = getS(), e = {};
  if (!SIZES.includes(b.size)) e.size = 'Choose a vehicle size.';
  if (!S.packages[b.service]) e.service = 'Choose a service.';
  if (!validDate(b.date)) e.date = 'Choose a date.';
  if (!Number.isInteger(b.start_min)) e.time = 'Choose a time.';
  const reg = String(b.reg || '').trim().toUpperCase(), vehicle = String(b.vehicle || '').trim(), name = String(b.name || '').trim(), email = String(b.email || '').trim(), addr = String(b.address || '').trim();
  const phone = normPhone(b.phone || ''), pc = normPC(b.postcode || '');
  if (!REG.test(reg)) e.reg = 'Enter a valid registration.'; if (vehicle.length < 2 || vehicle.length > 80) e.vehicle = 'Enter make and model.';
  if (name.length < 2 || name.length > 80) e.name = 'Enter your full name.'; if (!phone) e.phone = 'Enter a valid UK telephone number.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 120) e.email = 'Enter a valid email address.';
  if (addr.length < 5 || addr.length > 200) e.address = 'Enter your full address.'; if (!pc) e.postcode = 'Enter a valid UK postcode.';
  if (!['cash', 'card'].includes(b.pay)) e.pay = 'Choose cash or card.';
  if (Object.keys(e).length) return { status: 400, errors: e };
  if (limited(ip, 'book', 20, 3600e3)) return { status: 429, errors: { _: 'Too many attempts. Please try again later.' } };
  const pkg = S.packages[b.service], price = pence(S, b.size, b.service);
  const ref = '24C-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  db.exec('BEGIN IMMEDIATE');                       // serialised: availability re-checked inside the write transaction
  try {
    if (!slotsFor(S, b.date, pkg.blockMin).includes(b.start_min)) { db.exec('ROLLBACK'); return { status: 409, errors: { time: 'Sorry, that time has just been taken. Please choose another.' } }; }
    db.prepare('INSERT INTO bookings(ref,size,service,price_pence,pay,date,start_min,block_min,reg,vehicle,colour,name,phone,email,address,postcode,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(ref, b.size, b.service, price, b.pay, b.date, b.start_min, pkg.blockMin, reg, vehicle, String(b.colour || '').slice(0, 40), name, phone, email, addr, pc, String(b.notes || '').slice(0, 1000));
    db.exec('COMMIT');
  } catch (x) { try { db.exec('ROLLBACK'); } catch {} console.error(x); return { status: 500, errors: { _: 'We could not save your booking. Please try again.' } }; }
  const summary = `Reference: ${ref}\nService: ${pkg.name} (${b.size} vehicle)\nPrice: ${exact(price)} (${b.pay}, paid in person on arrival)\nWhen: ${b.date} at ${fmt(b.start_min)}\nVehicle: ${reg} ${vehicle}\nAddress: ${addr}, ${pc}`;
  const m1 = await mail(email, 'Your 24CARCARE booking ' + ref, `Hi ${name},\n\nThank you for choosing 24CARCARE. We look forward to taking care of your vehicle.\n\n${summary}\n\nNo online payment has been taken. Payment is collected in person before work begins.`);
  const to = S.contact.notifyEmail || process.env.ADMIN_NOTIFY_EMAIL;
  const m2 = await mail(to, 'New booking ' + ref, `${summary}\nCustomer: ${name}, ${phone}, ${email}\nNotes: ${b.notes || '-'}`);
  return { status: 201, booking: { ref, service: pkg.name, reg, date: b.date, time: fmt(b.start_min), price: exact(price), shownPrice: '£' + shown(price), pay: b.pay }, email: { customer: m1, admin: m2 } };
}

// ---------- page rendering ----------
const logo = '<a class="logo" href="/" aria-label="24CARCARE home"><b>24</b>CARCARE</a>';
const NAV = [['/', 'Home'], ['/services', 'Our Services'], ['/pricing', 'Pricing'], ['/before-after', 'Before & After'], ['/about', 'About Us'], ['/contact', 'Contact']];
function layout(S, { title, desc, path: p, body, ld, scripts = [] }) {
  const c = S.contact;
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${SITE}${p}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta name="theme-color" content="#0e0f11"><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230e0f11'/%3E%3Ctext x='16' y='22' font-size='15' font-weight='800' text-anchor='middle' fill='%23c6ff3d' font-family='Arial'%3E24%3C/text%3E%3C/svg%3E"><link rel="stylesheet" href="/app.css">${ld ? `<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}</head><body>${PREVIEW ? '<div style="background:#ffd400;color:#000;text-align:center;font:700 13px system-ui;padding:6px">PREVIEW &mdash; test data only. No emails are sent.</div>' : ''}
<a class="skip" href="#main">Skip to content</a>
<header class="nav"><div class="wrap navin">${logo}<nav id="menu" aria-label="Main">${NAV.map(([h, t]) => `<a href="${h}"${h === p ? ' aria-current="page"' : ''}>${t}</a>`).join('')}<a class="btn sm mobonly" href="/book">BOOK NOW</a></nav><a class="btn sm deskonly" href="/book">BOOK NOW</a><button class="burger" aria-label="Menu" aria-expanded="false" aria-controls="menu"><i></i><i></i></button></div></header>
<main id="main">${body}</main>
<footer><div class="wrap fgrid"><div>${logo}<p>${esc(S.about)}</p></div><div><h4>Explore</h4><a href="/services">Our Services</a><a href="/pricing">Pricing</a><a href="/book">Booking</a><a href="/before-after">Before &amp; After</a></div>
<div><h4>Contact</h4>${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}<a href="/contact">Contact form</a><h4>Follow</h4>${c.facebook ? `<a href="${esc(c.facebook)}" rel="noopener">Facebook</a>` : ''}${c.instagram ? `<a href="${esc(c.instagram)}" rel="noopener">Instagram</a>` : ''}${!c.facebook && !c.instagram ? '<span class="mut">Social links coming soon</span>' : ''}</div>
<div><h4>Service areas</h4>${S.areas.map(a => `<span>${esc(a)}</span>`).join('')}<h4>Legal</h4><a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a></div></div><div class="wrap copy">© 2026 24CARCARE. All Rights Reserved.</div></footer>
<script src="/app.js" defer></script>${scripts.map(s => `<script src="${s}" defer></script>`).join('')}</body></html>`;
}
const car = '<svg viewBox="0 0 240 100" role="img" aria-label="Car illustration"><path d="M14 70c0-10 6-14 14-16l26-22c4-3 8-4 14-4h58c8 0 13 2 18 6l22 18c14 1 24 4 24 14v8c0 3-2 5-5 5h-14a20 20 0 0 0-40 0H86a20 20 0 0 0-40 0H19c-3 0-5-2-5-5z" fill="currentColor" opacity=".9"/><circle cx="66" cy="78" r="13" fill="#0e0f11" stroke="#c6ff3d" stroke-width="3"/><circle cx="174" cy="78" r="13" fill="#0e0f11" stroke="#c6ff3d" stroke-width="3"/></svg>';
const carL = car.replace('viewBox="0 0 240 100"', 'viewBox="0 0 240 100" style="transform:scale(1.12)"');
const carS = car.replace('viewBox="0 0 240 100"', 'viewBox="20 0 200 100" style="transform:scale(.88)"');
const sizeInfo = { small: ['Small vehicles', 'Compact cars and small hatchbacks.', ['Smart', 'Ford Fiesta', 'Toyota Yaris', 'Volkswagen Golf'], carS], medium: ['Medium vehicles', 'Medium-sized saloons and crossovers.', ['BMW 5 Series', 'Nissan Juke', 'Ford Mondeo', 'Audi A4'], car], large: ['Large vehicles', 'Large 4x4s, big SUVs and vans.', ['Range Rover', 'Large 4x4s and SUVs', 'Vans'], carL] };
const sizeCards = (S, link) => SIZES.map(z => `<button class="size" data-size="${z}" type="button"><div class="ill">${sizeInfo[z][3]}</div><h3>${sizeInfo[z][0]}</h3><p>${sizeInfo[z][1]}</p><ul>${sizeInfo[z][2].map(x => `<li>${x}</li>`).join('')}</ul><span class="pill">${S.pct[z] ? '+' + S.pct[z] + '% on base price' : 'Base price'}</span></button>`).join('');
const note = '<p class="mut small">Vehicle examples are indicative. Not sure which size you are? <a href="/contact">Ask us</a> or choose the nearest size &mdash; we will confirm before your appointment.</p>';

function page(route, S) {
  const P = S.packages, T = priceTable(S);
  const pkgCard = (k, link = true) => `<article class="card${P[k].popular ? ' pop' : ''}">${P[k].popular ? '<span class="badge">Most popular</span>' : ''}<div class="thumb">${car}</div><h3>${esc(P[k].name)}</h3><p class="mut">${esc(P[k].tag)}</p><p>${esc(P[k].desc)}</p><p class="from">Starting from <b>£${S.base[k]}</b></p>${link ? `<a class="btn ghost" href="/pricing#${k}">VIEW PRICING</a>` : ''}</article>`;
  const local = { '@context': 'https://schema.org', '@type': ['AutoWash', 'LocalBusiness'], name: '24CARCARE', url: SITE, description: 'Mobile car valeting and detailing in Gloucester and surrounding areas.', areaServed: S.areas.map(a => ({ '@type': 'City', name: a })), address: { '@type': 'PostalAddress', addressLocality: 'Gloucester', addressRegion: 'Gloucestershire', addressCountry: 'GB' }, openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'], opens: '08:00', closes: '20:00' }], ...(S.contact.phone ? { telephone: S.contact.phone } : {}) };
  const cta = `<section class="cta"><div class="wrap"><h2>Ready to Give Your Car the Care It Deserves?</h2><a class="btn big" href="/book">BOOK YOUR VALET TODAY</a></div></section>`;
  const head = (h, s) => `<section class="phead"><div class="wrap"><h1>${h}</h1><p>${s}</p></div></section>`;
  const pk = S.packages;
  switch (route) {
    case '/': return { title: 'Mobile Car Valeting Gloucester | 24CARCARE', desc: 'Premium mobile car valeting and car detailing in Gloucester and Gloucestershire. Mobile car wash at your door. Book online in minutes.', ld: local, body: `
<section class="hero"><div class="wrap"><p class="eyebrow">Mobile car valeting &amp; detailing · Gloucester</p><h1>Your Car Deserves Better.</h1><p class="lead">Premium mobile car valeting and detailing. We bring professional car care directly to your doorstep across Gloucester and surrounding areas.</p><div class="row"><a class="btn big" href="/book">BOOK YOUR VALET</a><a class="btn ghost big" href="/services">EXPLORE OUR SERVICES</a></div><p class="trust">Professional Care. Conveniently Delivered.</p></div><div class="herocar">${S.heroImage ? `<img src="${esc(S.heroImage)}" alt="Professionally detailed car in Gloucester" fetchpriority="high">` : car}</div></section>
<section class="sec"><div class="wrap"><h2>Our services</h2><div class="grid3">${['quick', 'valet', 'full'].map(k => pkgCard(k)).join('')}</div></div></section>
<section class="sec dark"><div class="wrap"><h2>Before &amp; After</h2><p class="mut">Drag the divider to see the transformation.</p><div id="ba-home" class="bagrid" data-limit="2"></div><p><a class="btn ghost" href="/before-after">SEE THE FULL GALLERY</a></p></div></section>
<section class="sec"><div class="wrap"><h2>Why choose 24CARCARE?</h2><div class="grid4">${[['Mobile Convenience', 'We come directly to your location.'], ['Professional Results', 'Attention to every detail.'], ['Flexible Booking', 'Choose a convenient day and time.'], ['Transparent Pricing', 'Clear prices with no hidden surprises.']].map(([a, b]) => `<div class="feat"><h3>${a}</h3><p>${b}</p></div>`).join('')}</div></div></section>
<section class="sec lt"><div class="wrap split"><div><h2>Serving Gloucester and surrounding areas.</h2><p>${S.areas.map(a => `<span class="tag">${esc(a)}</span>`).join('')}</p><p class="mut small">Not listed? <a href="/contact">Get in touch</a> and we will confirm whether we can visit.</p></div><iframe title="Map of Gloucester" loading="lazy" class="map" src="https://www.openstreetmap.org/export/embed.html?bbox=-2.40%2C51.75%2C-1.95%2C51.98&layer=mapnik"></iframe></div></section>${cta}` };
    case '/services': return { title: 'Car Valeting & Detailing Services Gloucester | 24CARCARE', desc: 'Quick Wash, Full Valet and Full Service mobile car valeting and detailing across Gloucester and Gloucestershire.', body: head('Our Services', 'Three packages, brought to your door.') + `<section class="sec"><div class="wrap stack">${['quick', 'valet', 'full'].map(k => `<article class="svc${pk[k].popular ? ' pop' : ''}" id="${k}"><div><h2>${esc(pk[k].name)} <small>from £${S.base[k]}</small></h2><p>${esc(pk[k].desc)}</p>${pk[k].duration ? `<p><b>${esc(pk[k].duration)}</b></p>` : ''}${k === 'quick' ? '<p class="warn">Exterior only &mdash; interior cleaning is not included.</p>' : ''}</div><ul class="ticks">${pk[k].includes.map(i => `<li>${esc(i)}</li>`).join('')}</ul><a class="btn" href="/pricing#${k}">VIEW PRICING</a></article>`).join('')}</div></section>` + cta };
    case '/pricing': return { title: 'Mobile Car Valeting Prices Gloucester | 24CARCARE', desc: 'Clear car valeting prices by vehicle size. Choose small, medium or large to see your price and book online.', body: head('Pricing', 'Choose your vehicle size to see exact prices.') + `<section class="sec"><div class="wrap"><h2 class="step"><span>1</span>Select your vehicle size</h2><div class="grid3" id="sizes">${sizeCards(S)}</div>${note}<div id="pkgs" hidden><h2 class="step"><span>2</span>Your packages <small id="sizelabel"></small></h2><div class="grid3" id="pkgcards"></div></div></div></section>${cta}<script>window.__PRICING=${JSON.stringify({ T, P: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { name: v.name, desc: v.desc, includes: v.includes, duration: v.duration, popular: v.popular, tag: v.tag }])), pct: S.pct }).replace(/</g, '\\u003c')}</script>`, scripts: ['/pricing.js'] };
    case '/book': return { title: 'Book Mobile Car Valeting Gloucester | 24CARCARE', desc: 'Book your mobile car valet online. Choose your vehicle, service and a time that suits you. Pay in person.', body: `<section class="sec"><div class="wrap narrow"><h1>Book your valet</h1><ol class="prog" id="prog"></ol><div id="bk" aria-live="polite"></div></div></section><script>window.__PRICING=${JSON.stringify({ T, P: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, { name: v.name, desc: v.desc, includes: v.includes, duration: v.duration, tag: v.tag }])), sizes: Object.fromEntries(SIZES.map(z => [z, [sizeInfo[z][0], sizeInfo[z][2].join(', ')]])) }).replace(/</g, '\\u003c')}</script>`, scripts: ['/booking.js'] };
    case '/before-after': return { title: 'Before & After Car Valeting Results | 24CARCARE', desc: 'Drag the slider to compare real before and after car valeting and detailing results from 24CARCARE in Gloucester.', body: head('Before &amp; After', 'Real vehicles, same angle. Drag the divider.') + `<section class="sec dark"><div class="wrap"><div id="ba-all" class="bagrid"></div></div></section>` + cta };
    case '/about': return { title: 'About 24CARCARE | Mobile Car Detailing Gloucestershire', desc: 'About 24CARCARE: mobile car valeting and detailing serving Gloucester and surrounding areas.', body: head('About Us', 'Professional car care, conveniently delivered.') + `<section class="sec"><div class="wrap narrow"><p class="lead dk">${esc(S.about)}</p><p>${S.areas.map(a => `<span class="tag">${esc(a)}</span>`).join('')}</p></div></section>` + cta };
    case '/contact': return { title: 'Contact 24CARCARE | Mobile Car Valeting Gloucester', desc: 'Get in touch with 24CARCARE for mobile car valeting enquiries in Gloucester and Gloucestershire.', ld: local, body: head('Contact', 'Questions about your vehicle or our service area? Send us a message.') + `<section class="sec"><div class="wrap split"><form id="cf" class="form" novalidate><label>Full name<input name="name" required maxlength="80"></label><label>Email<input name="email" type="email" required></label><label>Message<textarea name="message" rows="5" required maxlength="2000"></textarea></label><p class="err" id="cferr" role="alert"></p><button class="btn" type="submit">SEND MESSAGE</button><p class="ok" id="cfok" hidden>Thank you &mdash; your message has been received.</p></form><div>${S.contact.phone ? `<p><b>Phone</b><br><a href="tel:${esc(S.contact.phone)}">${esc(S.contact.phone)}</a></p>` : ''}${S.contact.email ? `<p><b>Email</b><br>${esc(S.contact.email)}</p>` : ''}<p><b>Hours</b><br>Every day, 08:00 – 20:00</p><p><b>Area</b><br>${S.areas.map(esc).join(', ')}</p></div></div></section>`, scripts: ['/contact.js'] };
    case '/privacy': return { title: 'Privacy Policy | 24CARCARE', desc: 'How 24CARCARE collects and uses your personal data.', body: head('Privacy Policy', 'Draft &mdash; have this reviewed before launch.') + `<section class="sec"><div class="wrap narrow legal"><p>We collect the details you give us when booking (name, telephone, email, address, postcode, vehicle details) solely to provide and manage your appointment and to contact you about it. We do not take card or bank details online. We do not sell your data. You may ask us to access, correct or delete your data by contacting us. Booking data is stored in our private database and is visible only to authorised staff.</p><p><b>Note for the owner:</b> this is placeholder wording, not legal advice. Add your trading name, address and ICO details.</p></div></section>` };
    case '/terms': return { title: 'Terms & Conditions | 24CARCARE', desc: 'Terms and conditions for booking 24CARCARE mobile valeting services.', body: head('Terms &amp; Conditions', 'Draft &mdash; have this reviewed before launch.') + `<section class="sec"><div class="wrap narrow legal"><p>Bookings reserve the date and time you select. Payment (cash or card) is taken in person before work begins; no online payment is taken. Prices depend on vehicle size, which we may confirm on arrival. Vehicle examples are indicative.</p><p><b>Note for the owner:</b> placeholder wording, not legal advice. Add cancellation, access, weather and liability terms.</p></div></section>` };
  }
}

// ---------- http ----------
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const body = req => new Promise((res, rej) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 14e6) { rej(new Error('big')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { res(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { rej(new Error('json')); } }); });
const send = (res, code, data, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type + (type.startsWith('text') || type.includes('json') ? '; charset=utf-8' : ''), 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN', ...(PREVIEW ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}), ...extra }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
const saveImg = (dataUrl) => { const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl || ''); if (!m) throw new Error('Images must be PNG, JPEG or WebP.'); const f = crypto.randomBytes(10).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]); fs.writeFileSync(path.join(DATA, 'uploads', f), Buffer.from(m[2], 'base64')); return f; };
const bookingRow = r => ({ ...r, price: exact(r.price_pence), time: fmt(r.start_min) });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, ip = (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (PREVIEW) {   // fail closed: no preview password configured = nothing is served
      const pw = process.env.PREVIEW_PASSWORD || '', want = Buffer.from((process.env.PREVIEW_USER || 'preview') + ':' + pw);
      const got = Buffer.from(Buffer.from((/^Basic (.+)$/.exec(req.headers.authorization || '') || [])[1] || '', 'base64').toString());
      const okAuth = pw.length >= 8 && got.length === want.length && crypto.timingSafeEqual(got, want);
      if (!okAuth) { if (limited(ip, 'pv', 30, 600e3)) return send(res, 429, 'Too many attempts', 'text/plain'); return send(res, pw.length >= 8 ? 401 : 503, pw.length >= 8 ? 'Login required' : 'Preview not configured: set PREVIEW_PASSWORD (8+ characters).', 'text/plain', { 'WWW-Authenticate': 'Basic realm="24CARCARE preview"' }); }
    }
    if (p.startsWith('/api/')) {
      const S = getS(), m = req.method;
      if (m === 'GET' && p === '/api/availability') {
        const svc = u.searchParams.get('service'), from = u.searchParams.get('from') || ukNow().date;
        if (!S.packages[svc] || !validDate(from)) return send(res, 400, { error: 'bad request' });
        const now = ukNow(), start = from < now.date ? now.date : from, days = [];
        for (let i = 0; i < 7; i++) { const d = addDays(start, i); days.push({ date: d, slots: slotsFor(S, d, S.packages[svc].blockMin).map(fmt) }); }
        return send(res, 200, { days, today: now.date, from: start });
      }
      if (m === 'GET' && p === '/api/month') {
        const svc = u.searchParams.get('service'), now = ukNow(); let mo = u.searchParams.get('month') || now.date.slice(0, 7);
        if (!S.packages[svc] || !/^\d{4}-\d{2}$/.test(mo)) return send(res, 400, { error: 'bad request' });
        const cur = now.date.slice(0, 7), max = (() => { const d = new Date(now.date + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 12); return d.toISOString().slice(0, 7); })();
        if (mo < cur) mo = cur; if (mo > max) mo = max;
        const bm = S.packages[svc].blockMin, days = []; let d = mo + '-01';
        while (d.slice(0, 7) === mo) {
          const total = slotsFor(S, d, bm, null, 2).length, open = total ? slotsFor(S, d, bm, null, 1).length : 0, free = total ? slotsFor(S, d, bm).length : 0;
          days.push({ date: d, total, free, status: !total || (!free && !open) ? 'unavailable' : !free ? 'full' : free < total ? 'partial' : 'available' }); d = addDays(d, 1);
        }
        return send(res, 200, { month: mo, today: now.date, min: cur, max, days });
      }
      if (m === 'GET' && p === '/api/photos') return send(res, 200, db.prepare('SELECT id,title,before_file b,after_file a FROM photos ORDER BY sort,id').all().map(r => ({ id: r.id, title: r.title, before: '/uploads/' + r.b, after: '/uploads/' + r.a })));
      if (m === 'POST' && p === '/api/bookings') { const r = await createBooking(await body(req), ip); return send(res, r.status, r); }
      if (m === 'POST' && p === '/api/contact') { const b = await body(req); if (limited(ip, 'ct', 5, 3600e3)) return send(res, 429, { error: 'Too many messages.' }); if (!b.name || !/^[^@\s]+@[^@\s]+\.\w+$/.test(b.email || '') || !b.message) return send(res, 400, { error: 'Please complete all fields.' }); const s = await mail(S.contact.notifyEmail || process.env.ADMIN_NOTIFY_EMAIL, 'Website enquiry from ' + String(b.name).slice(0, 80), `${b.name} <${b.email}>\n\n${String(b.message).slice(0, 2000)}`); return send(res, 200, { ok: true, delivery: s }); }
      if (m === 'POST' && p === '/api/admin/login') { const b = await body(req), a = S.admin; if (limited(ip, 'login', 8, 900e3)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' }); if (String(b.email).toLowerCase() === a.email.toLowerCase() && checkPw(String(b.password || ''), a.hash)) return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': `adm=${sign({ exp: Date.now() + 12 * 3600e3 })}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${SITE.startsWith('https') ? '; Secure' : ''}` }); return send(res, 401, { error: 'Invalid login.' }); }
      if (p.startsWith('/api/admin/')) {
        if (!isAdmin(req)) return send(res, 401, { error: 'Not signed in.' });
        if (m === 'POST' && p === '/api/admin/logout') return send(res, 200, { ok: true }, 'application/json', { 'Set-Cookie': 'adm=; Path=/; Max-Age=0' });
        if (m === 'GET' && p === '/api/admin/data') { const { admin, ...pub } = S; return send(res, 200, { settings: pub, bookings: db.prepare('SELECT * FROM bookings ORDER BY date,start_min').all().map(bookingRow), blocks: db.prepare('SELECT * FROM blocks ORDER BY date,start_min').all(), photos: db.prepare('SELECT id,title,before_file b,after_file a FROM photos ORDER BY sort,id').all(), outbox: db.prepare('SELECT id,to_addr,subject,status,created FROM outbox ORDER BY id DESC LIMIT 30').all(), prices: priceTable(S), today: ukNow().date, mailConfigured: !!process.env.RESEND_API_KEY }); }
        const b = await body(req);
        if (m === 'POST' && p === '/api/admin/settings') { const ok = ['base', 'pct', 'packages', 'hours', 'interval', 'buffer', 'capacity', 'contact', 'areas', 'about', 'heroImage']; for (const k of ok) if (k in b) setS(k, b[k]); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/status') { if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(b.status)) return send(res, 400, { error: 'bad status' }); db.prepare('UPDATE bookings SET status=? WHERE id=?').run(b.status, b.id); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/reschedule') { db.exec('BEGIN IMMEDIATE'); const r = db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id); if (!r || !validDate(b.date) || !slotsFor(S, b.date, r.block_min, r.id).includes(toMin(b.time))) { db.exec('ROLLBACK'); return send(res, 409, { error: 'That time is not available.' }); } db.prepare('UPDATE bookings SET date=?,start_min=? WHERE id=?').run(b.date, toMin(b.time), r.id); db.exec('COMMIT'); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/block') { if (!validDate(b.date)) return send(res, 400, { error: 'bad date' }); const days = Math.min(Math.max(+b.days || 1, 1), 60); for (let i = 0; i < days; i++) db.prepare('INSERT INTO blocks(date,start_min,end_min,reason) VALUES(?,?,?,?)').run(addDays(b.date, i), b.from ? toMin(b.from) : null, b.to ? toMin(b.to) : null, String(b.reason || '').slice(0, 100)); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/unblock') { db.prepare('DELETE FROM blocks WHERE id=?').run(b.id); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/photo') { const row = db.prepare('INSERT INTO photos(title,before_file,after_file) VALUES(?,?,?)').run(String(b.title || '').slice(0, 100), saveImg(b.before), saveImg(b.after)); return send(res, 200, { ok: true, id: Number(row.lastInsertRowid) }); }
        if (m === 'POST' && p === '/api/admin/photo-delete') { const r = db.prepare('SELECT * FROM photos WHERE id=?').get(b.id); if (r) { for (const f of [r.before_file, r.after_file]) fs.rm(path.join(DATA, 'uploads', path.basename(f)), () => {}); db.prepare('DELETE FROM photos WHERE id=?').run(b.id); } return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/hero') { setS('heroImage', '/uploads/' + saveImg(b.image)); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p === '/api/admin/password') { if (String(b.password || '').length < 10) return send(res, 400, { error: 'Use at least 10 characters.' }); const a = S.admin; setS('admin', { ...a, hash: hashPw(b.password) }); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'not found' });
    }
    if (p === '/admin') return send(res, 200, fs.readFileSync(path.join(PUB, 'admin.html')), 'text/html', { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
    if (p.startsWith('/uploads/')) { const f = path.join(DATA, 'uploads', path.basename(p)); return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=86400' }) : send(res, 404, 'Not found', 'text/plain'); }
    if (p === '/robots.txt') return send(res, 200, PREVIEW ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`, 'text/plain');
    if (p === '/sitemap.xml') return send(res, 200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/services', '/pricing', '/book', '/before-after', '/about', '/contact', '/privacy', '/terms'].map(x => `<url><loc>${SITE}${x}</loc></url>`).join('')}</urlset>`, 'application/xml');
    const bn = path.basename(p), f = path.join(PUB, bn);
    if (ASSETS.has(bn) && fs.existsSync(f)) return send(res, 200, fs.readFileSync(f), MIME[path.extname(p)], { 'Cache-Control': 'public, max-age=300' });
    const r = page(p === '/' ? '/' : p.replace(/\/$/, ''), getS());
    if (!r) return send(res, 404, layout(getS(), { title: 'Page not found | 24CARCARE', desc: 'Page not found', path: p, body: '<section class="sec"><div class="wrap narrow"><h1>Page not found</h1><p><a class="btn" href="/">Back home</a></p></div></section>' }), 'text/html');
    return send(res, 200, layout(getS(), { ...r, path: p }), 'text/html');
  } catch (e) { console.error(e); try { send(res, e.message === 'big' ? 413 : 500, { error: e.message === 'json' ? 'Bad request' : 'Server error' }); } catch {} }
}).listen(PORT, () => console.log('24CARCARE running on http://localhost:' + PORT));
module.exports = { slotsFor, pence, getS };
