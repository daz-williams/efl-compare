/* Plain-language guided view over the plan data.
 *
 * Reads the JSON that efl_compare.py already produces (via this server's
 * /api/plans) and prices every plan client-side. Nothing here needs the parent
 * CLI to know the wizard exists: the pricing below mirrors the CLI's own
 * effective_cents_per_kwh() using the raw rate components the CLI already
 * exports (energy_charge_cents, base_charge_dollars, tdu_bundled,
 * energy_threshold_kwh, tier_boundary_kwh, ec_cents_above_tier, bill_credits).
 */
'use strict';

var DATA = null;
var app = document.getElementById('app');
var state = {step: 0, usage: null, entry: null,
             manualBill: null, manualEtf: null, manualMonths: null};

function money(cents, kwh){ return Math.round(cents / 100 * kwh); }
function fmtMonths(n){ return (Math.round(n * 10) / 10).toString().replace(/\.0$/, ''); }
function esc(s){ return ('' + s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function setDots(){ for (var i = 0; i < 3; i++){ document.getElementById('d' + i).className = 'dot' + (i <= state.step ? ' on' : ''); } }

// ---------------------------------------------------------------------------
// Data: /api/plans (the CLI's --json payload) -> the shape this page renders
// ---------------------------------------------------------------------------

var _MONTHS = ['January','February','March','April','May','June','July',
               'August','September','October','November','December'];

function fmtGenerated(iso){
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return ('' + iso).slice(0, 10);
  return _MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function toPlan(p){
  return {
    provider:   p.provider || '',
    plan:       p.plan || '',
    term:       p.term_months,
    etf:        p.cancellation_fee,
    rnw:        p.renewable_pct,
    tiers:      p.rates_cents_per_kwh || {},
    enroll_url: p.enroll_url || '',
    facts_url:  p.facts_url || '',
    manual:     !!p.manual,
    // The CLI exports cents; every calculation below is in dollars.
    ec:         (p.energy_charge_cents || 0) / 100,   // $/kWh
    bc:         p.base_charge_dollars || 0,           // $/mo
    tduBundled: !!p.tdu_bundled,
    ecThresh:   p.energy_threshold_kwh || 0,
    tierKwh:    p.tier_boundary_kwh || 0,
    ecAbove:    (p.ec_cents_above_tier || 0) / 100,   // $/kWh
    credits:    (p.bill_credits || []).map(function(c){
      return {amount:              +c.amount || 0,
              threshold_kwh:       +c.threshold_kwh || 0,
              requires_enrollment: !!c.requires_enrollment};
    })
  };
}

function buildData(raw){
  var plans = raw.plans || [];
  var t     = raw.tdu || {};
  var picks = plans.filter(function(p){ return !p.current; }).map(toPlan);
  var curRaw = plans.filter(function(p){ return p.current; })[0] || null;

  // Friendly home-size presets, kept only for usage tiers actually priced.
  var avail = {};
  plans.forEach(function(p){
    Object.keys(p.rates_cents_per_kwh || {}).forEach(function(k){ avail[parseInt(k, 10)] = true; });
  });
  var presets = [
    {kwh: 500,  label: 'Smaller home', sub: 'Apartment or condo'},
    {kwh: 1000, label: 'Average home', sub: '2–3 bedroom house'},
    {kwh: 2000, label: 'Larger home',  sub: 'Big house, pool, or electric heat'}
  ].filter(function(p){ return avail[p.kwh]; });
  if (!presets.length){
    var keys = Object.keys(avail).map(Number).sort(function(a, b){ return a - b; });
    if (keys.length){
      var mid = keys[Math.floor(keys.length / 2)];
      presets = [{kwh: mid, label: 'Your usage', sub: mid.toLocaleString() + ' kWh/mo'}];
    }
  }

  return {
    zip:       raw.zip || '',
    generated: fmtGenerated(raw.generated),
    planCount: picks.length,
    picks:     picks,
    current:   curRaw ? toPlan(curRaw) : null,
    presets:   presets,
    // The CLI's tdu block is {fixed_mo_dollars, per_kwh_cents}; the maths below
    // is all in dollars, so per-kWh is converted once here.
    tdu: {fixed_mo: t.fixed_mo_dollars || 0,
          per_kwh:  (t.per_kwh_cents || 0) / 100}
  };
}

// ---------------------------------------------------------------------------
// Pricing — mirrors the CLI's effective_cents_per_kwh()
// ---------------------------------------------------------------------------

function planMonthlyExact(p, kwh){
  if (!kwh || kwh <= 0 || p.ec == null) return null;
  var credit = 0;
  (p.credits || []).forEach(function(c){ if (c.threshold_kwh <= kwh) credit += c.amount; });
  var energyCost;
  if (p.tierKwh > 0 && kwh > p.tierKwh){
    energyCost = p.ec * p.tierKwh + p.ecAbove * (kwh - p.tierKwh);
  } else {
    var billable = p.ecThresh > 0 ? Math.max(0, kwh - p.ecThresh) : kwh;
    energyCost = p.ec * billable;
  }
  var total;
  if (p.tduBundled){
    total = energyCost + (p.bc || 0) - credit;
  } else {
    var tdu = DATA.tdu || {fixed_mo: 0, per_kwh: 0};
    total = energyCost + (p.bc || 0) + tdu.fixed_mo + tdu.per_kwh * kwh - credit;
  }
  return Math.round(total);
}

// Fallback for plans with no usable rate components: piecewise-linear on the
// tier bill totals the CLI publishes.
function interpMonthly(p, kwh){
  var pts = Object.keys(p.tiers).map(function(k){ var kk = parseInt(k, 10); return {k: kk, $: money(p.tiers[k], kk)}; })
    .filter(function(x){ return x.$ != null; }).sort(function(a, b){ return a.k - b.k; });
  if (!pts.length) return null;
  if (pts.length === 1) return Math.round(pts[0].$ * kwh / pts[0].k);
  for (var i = 0; i < pts.length - 1; i++){
    if (kwh >= pts[i].k && kwh <= pts[i + 1].k){
      var t = (kwh - pts[i].k) / (pts[i + 1].k - pts[i].k);
      return Math.round(pts[i].$ + t * (pts[i + 1].$ - pts[i].$));
    }
  }
  var a = kwh < pts[0].k ? pts[0] : pts[pts.length - 2];
  var b = kwh < pts[0].k ? pts[1] : pts[pts.length - 1];
  var slope = (b.$ - a.$) / (b.k - a.k);
  var base = kwh < pts[0].k ? pts[0] : pts[pts.length - 1];
  return Math.max(0, Math.round(base.$ + slope * (kwh - base.k)));
}

function planMonthly(p, kwh){
  var c = p.tiers[String(kwh)];
  if (c != null) return money(c, kwh);        // exact tier value straight from the CLI
  var exact = planMonthlyExact(p, kwh);
  if (exact != null && p.ec > 0) return exact; // exact formula at arbitrary usage
  return interpMonthly(p, kwh);                // last-resort estimate
}

// ---------------------------------------------------------------------------
// Break-even: the one-time exit fee to leave early vs. the recurring saving
// ---------------------------------------------------------------------------

function parseEtf(s){
  if (s == null) return 0;
  s = ('' + s).trim();
  if (!s || /^unknown/i.test(s) || s === '?') return null;
  var m = s.replace(/,/g, '').match(/[\d]+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function breakevenNote(saveMo, etfStr, monthsRemaining){
  if (saveMo <= 0) return '';
  var etf = parseEtf(etfStr);
  if (etf === null) return "&#9888;&#65039; We couldn't read your current plan's exit fee &mdash; check your bill before switching, as it eats into the saving.";
  if (etf <= 0) return '&#10003; Your current plan has no exit fee, so you can switch now and keep the whole saving.';
  var be = etf / saveMo;
  if (monthsRemaining == null)
    return 'Leaving early costs a $' + Math.round(etf) + ' exit fee, earned back in about ' + be.toFixed(1) + ' months of savings. Worth it if you\'ve more than ~' + be.toFixed(1) + ' months left.';
  if (be <= monthsRemaining){
    var net = saveMo * monthsRemaining - etf;
    return '&#128077; <b>Worth switching now.</b> You earn back the $' + Math.round(etf) + ' exit fee in about ' + be.toFixed(1) + ' months, and come out ~$' + Math.round(net) + ' ahead over your remaining ' + fmtMonths(monthsRemaining) + ' months.';
  }
  var lost = etf - saveMo * monthsRemaining;
  return '&#9995; <b>Better to wait.</b> With only ' + fmtMonths(monthsRemaining) + ' months left, switching now costs ~$' + Math.round(lost) + ' after the $' + Math.round(etf) + ' exit fee. Switch for free when your contract ends.';
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function renderIntro(){
  state.step = 0; setDots();
  document.getElementById('subline').textContent =
    DATA.planCount + ' plans compared' + (DATA.zip ? ' near ' + DATA.zip : '') + ' · ' + DATA.generated;
  app.innerHTML =
    '<div class="card">' +
      '<h2 class="q">Let\'s find you a better deal.</h2>' +
      '<p class="lead">We\'ll show you the three cheapest electricity plans &mdash; in plain dollars per month, no fine print. Pick how you\'d like to start:</p>' +
      '<div class="choices">' +
        '<button class="choice" id="goEnter">' +
          '<span class="emoji">&#128221;</span>' +
          '<span><span class="t">Enter your info</span><br><span class="d">Type your real monthly usage (and current bill) for exact pricing</span></span>' +
        '</button>' +
        '<button class="choice" id="goEstimate">' +
          '<span class="emoji">&#10024;</span>' +
          '<span><span class="t">Estimate</span><br><span class="d">Not sure? Pick your home size and we\'ll estimate it for you</span></span>' +
        '</button>' +
      '</div>' +
    '</div>';
  document.getElementById('goEnter').onclick = renderManualEntry;
  document.getElementById('goEstimate').onclick = renderUsage;
}

function renderUsage(){
  state.step = 1; state.entry = 'estimate'; state.manualBill = null; setDots();
  var emojis = ['🏢', '🏡', '🏠'];
  var rows = '';
  DATA.presets.forEach(function(p, i){
    var lo = null;
    DATA.picks.forEach(function(pl){ var m = planMonthly(pl, p.kwh); if (m != null && (lo == null || m < lo)) lo = m; });
    rows +=
      '<button class="choice" data-kwh="' + p.kwh + '">' +
        '<span class="emoji">' + emojis[i % 3] + '</span>' +
        '<span><span class="t">' + esc(p.label) + '</span><br><span class="d">' + esc(p.sub) + ' · about ' + p.kwh.toLocaleString() + ' kWh/mo</span></span>' +
        (lo != null ? '<span class="from"><b>from $' + lo + '</b><span>per month</span></span>' : '') +
      '</button>';
  });
  app.innerHTML =
    '<div class="card">' +
      '<h2 class="q">How big is your home?</h2>' +
      '<p class="lead">A rough idea is fine &mdash; it sets the usage we price every plan at. Not sure? Most homes are Average.</p>' +
      '<div class="choices">' + rows + '</div>' +
      '<div class="navrow"><button class="link" id="back">&larr; Back</button><span></span></div>' +
    '</div>';
  document.getElementById('back').onclick = renderIntro;
  Array.prototype.forEach.call(document.querySelectorAll('.choice'), function(b){
    b.onclick = function(){ state.usage = parseInt(b.dataset.kwh, 10); renderResults(); };
  });
}

function renderManualEntry(){
  state.step = 1; state.entry = 'manual'; setDots();
  var uVal = state.usage != null ? state.usage : '';
  var bVal = state.manualBill != null ? state.manualBill : '';
  var eVal = state.manualEtf != null ? state.manualEtf : '';
  var mVal = state.manualMonths != null ? state.manualMonths : '';
  app.innerHTML =
    '<div class="card">' +
      '<h2 class="q">Enter your info</h2>' +
      '<p class="lead">Grab your latest electricity bill. Only the first box is required &mdash; add your total to see what you\'d save.</p>' +
      '<div class="field">' +
        '<label>How many kWh did you use last month? <span class="hint">shown on your bill</span></label>' +
        '<div class="inrow"><input id="mUsage" type="number" inputmode="numeric" min="1" step="50" placeholder="e.g. 1200" value="' + uVal + '"><span class="unit">kWh</span></div>' +
      '</div>' +
      '<div class="field">' +
        '<label>What was your total bill? <span class="hint">optional &mdash; the whole amount you paid</span></label>' +
        '<div class="inrow"><span class="unit">$</span><input id="mBill" type="number" inputmode="decimal" min="0" step="1" placeholder="e.g. 180" value="' + bVal + '"></div>' +
      '</div>' +
      '<div class="optional">' +
        '<p class="why">Still under contract? Tell us these two and we\'ll work out whether leaving early is worth the exit fee.</p>' +
        '<div class="field">' +
          '<label>Your plan\'s exit fee <span class="hint">optional &mdash; on your contract as an early-termination fee</span></label>' +
          '<div class="inrow"><span class="unit">$</span><input id="mEtf" type="number" inputmode="decimal" min="0" step="10" placeholder="e.g. 150" value="' + eVal + '"></div>' +
        '</div>' +
        '<div class="field">' +
          '<label>Months left on your contract <span class="hint">optional &mdash; roughly is fine</span></label>' +
          '<div class="inrow"><input id="mMonths" type="number" inputmode="numeric" min="0" step="1" placeholder="e.g. 8" value="' + mVal + '"><span class="unit">months</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="err" id="mErr"></div>' +
      '<button class="big" id="mGo">See my 3 best plans &nbsp;&rarr;</button>' +
      '<div class="navrow"><button class="link" id="back">&larr; Back</button><span></span></div>' +
    '</div>';
  document.getElementById('back').onclick = renderIntro;
  var go = function(){
    var err = document.getElementById('mErr');
    var u = parseInt(document.getElementById('mUsage').value, 10);
    if (!u || u <= 0){ err.textContent = 'Please enter how many kWh you used last month.'; return; }
    if (u > 100000){ err.textContent = 'That looks too high — enter monthly kWh (most homes are 500–3,000).'; return; }
    var bRaw = document.getElementById('mBill').value.trim();
    var b = bRaw === '' ? null : parseFloat(bRaw);
    if (b != null && (isNaN(b) || b < 0)){ err.textContent = 'Please enter your total bill as a dollar amount, or leave it blank.'; return; }
    var eRaw = document.getElementById('mEtf').value.trim();
    var e = eRaw === '' ? null : parseFloat(eRaw);
    if (e != null && (isNaN(e) || e < 0)){ err.textContent = 'Please enter your exit fee as a dollar amount, or leave it blank.'; return; }
    var mRaw = document.getElementById('mMonths').value.trim();
    var mo = mRaw === '' ? null : parseFloat(mRaw);
    if (mo != null && (isNaN(mo) || mo < 0)){ err.textContent = 'Please enter the months left on your contract, or leave it blank.'; return; }
    state.usage = u;
    state.manualBill = (b != null && !isNaN(b) && b > 0) ? b : null;
    state.manualEtf = (e != null && !isNaN(e)) ? e : null;
    state.manualMonths = (mo != null && !isNaN(mo)) ? mo : null;
    renderResults();
  };
  document.getElementById('mGo').onclick = go;
  ['mUsage', 'mBill', 'mEtf', 'mMonths'].forEach(function(id){
    document.getElementById(id).addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.preventDefault(); go(); }
    });
  });
  document.getElementById('mUsage').focus();
}

function renderResults(){
  state.step = 2; setDots();
  var kwh = state.usage;
  var ranked = DATA.picks
    .map(function(p){ return {p: p, m: planMonthly(p, kwh)}; })
    .filter(function(x){ return x.m != null; })
    .sort(function(a, b){ return a.m - b.m; })
    .slice(0, 3);

  // Current-plan comparison: a typed bill (from "Enter your info") takes
  // priority; otherwise use the plan the CLI marked as current (--current-efl).
  var cur = DATA.current;
  var curM = null, curEtf = null, months = state.manualMonths, banner = '';
  if (state.manualBill != null){
    curM = Math.round(state.manualBill);
    // Exit fee is only known if the user typed it.
    curEtf = state.manualEtf != null ? String(state.manualEtf) : '?';
    var allIn = (state.manualBill / kwh * 100);
    banner = '<div class="curbanner">Your last bill was about <b>$' + curM + '</b> for ' + kwh.toLocaleString() + ' kWh ' +
      '&mdash; roughly <b>' + allIn.toFixed(1) + '&cent;/kWh</b> all-in. Here’s how the best plans compare:' +
      '<br><span style="color:var(--mid);font-size:.85em">Your bill can include taxes and city fees these estimates leave out, so real savings may be a little smaller.</span></div>';
  } else if (cur){
    curM = planMonthly(cur, kwh);
    curEtf = cur.etf;
    if (curM != null){
      banner = '<div class="curbanner">You’re on <b>' + esc(cur.provider) + ' &mdash; ' + esc(cur.plan) + '</b>, ' +
        'about <b>$' + curM + '/mo</b> at this usage. Here’s how the best plans compare:</div>';
    }
  }

  var labels = ['Best deal', '2nd best', '3rd best'];
  var cards = '';
  ranked.forEach(function(x, i){
    var p = x.p, m = x.m;
    var green = (parseFloat(p.rnw) >= 99) ? '<span class="leaf">🌱 100% green</span>' : (p.rnw && p.rnw !== '?' ? esc(p.rnw) + '% renewable' : '');
    var saveHtml = '', beHtml = '';
    if (curM != null){
      var save = curM - m;
      if (save > 0){
        saveHtml = '<div class="save">Save about $' + save + '/mo vs your plan</div>';
        var note = breakevenNote(save, curEtf, months);
        if (note) beHtml = '<div class="be">' + note + '</div>';
      } else {
        saveHtml = '<div class="save" style="background:transparent;color:var(--mid)">About the same as your current plan</div>';
      }
    }
    var link = p.enroll_url || p.facts_url || '';
    var act = link ? '<div class="act"><a href="' + esc(link) + '" target="_blank" rel="noopener">Choose this plan &nbsp;&rarr;</a></div>' : '';
    cards +=
      '<div class="plan n' + (i + 1) + (i === 0 ? ' best' : '') + '">' +
        '<span class="badge">' + labels[i] + '</span>' +
        '<div class="prov">' + esc(p.provider) + '</div>' +
        '<div class="name">' + esc(p.plan) + '</div>' +
        '<div class="price"><span class="amt">$' + m + '</span><span class="per">/ month at ' + kwh.toLocaleString() + ' kWh</span></div>' +
        saveHtml +
        '<div class="meta"><span>&#128274; Locked in for ' + (p.term || '?') + ' months</span>' + (green ? '<span>' + green + '</span>' : '') + '<span>Exit fee: ' + esc(p.etf || '$0') + '</span></div>' +
        beHtml +
        act +
      '</div>';
  });
  if (!cards) cards = '<div class="card"><p class="lead">No plans could be priced at this usage. Try another home size.</p></div>';

  app.innerHTML =
    '<div class="card" style="background:transparent;border:0;box-shadow:none;padding:0">' +
      '<h2 class="q">Your 3 best plans</h2>' +
      '<p class="lead">Cheapest first, priced for a ' + kwh.toLocaleString() + ' kWh month. Tap a plan to sign up on the provider’s site.</p>' +
      banner +
      '<div class="rank">' + cards + '</div>' +
      '<div class="navrow"><button class="link" id="back">' + (state.entry === 'manual' ? '&larr; Edit my info' : '&larr; Change home size') + '</button><button class="link" id="restart">Start over</button></div>' +
    '</div>';
  document.getElementById('back').onclick = (state.entry === 'manual' ? renderManualEntry : renderUsage);
  document.getElementById('restart').onclick = renderIntro;
}

function renderMessage(title, body){
  document.getElementById('subline').textContent = '';
  app.innerHTML = '<div class="card"><h2 class="q">' + title + '</h2><p class="lead">' + body + '</p></div>';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

fetch('/api/plans')
  .then(function(r){ return r.json(); })
  .then(function(raw){
    if (!raw || (raw._source && raw._source.ok === false)){
      var msg = (raw && raw._source && raw._source.message) || 'No plan data is available yet.';
      renderMessage('No plan data yet', esc(msg) +
        '<br><br>Generate it from the repo root with:<br><code>python3 efl_compare.py --zip YOUR_ZIP --json plans_latest.json</code>');
      return;
    }
    DATA = buildData(raw);
    if (!DATA.picks.length){
      renderMessage('No plans to compare', 'The data file loaded, but it contains no plans to rank.');
      return;
    }
    document.getElementById('foot').innerHTML =
      'Prices are estimated monthly bills including delivery charges, at the usage you pick. Taxes excluded. ' +
      'Always confirm on the provider’s official Electricity Facts Label before enrolling.' +
      '<br><a href="/full">See the full technical comparison &rarr;</a>';
    renderIntro();
  })
  .catch(function(err){
    renderMessage('Couldn’t load the plan data', 'The server didn’t return usable data (' + esc(err && err.message ? err.message : err) + '). Is serve.py still running?');
  });
