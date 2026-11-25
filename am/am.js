const element = id => document.getElementById(id);
const FIRST_MONTH = "2026-11";

function today() {
  const formatter = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const asDate = id => new Date(id + "T12:00:00Z");
const iso = date => date.toISOString().slice(0, 10);
const fmt = (id, options) => asDate(id).toLocaleDateString("en-GB", { timeZone: "UTC", ...options });
const dayLabel = id => fmt(id, { weekday: "long", day: "numeric", month: "long" });
const shortDay = id => fmt(id, { weekday: "short", day: "numeric", month: "short" });
function monthEnd(month) {
  const date = asDate(month + "-01");
  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return iso(date);
}
function weekStart(id) {
  const date = asDate(id);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return iso(date);
}

function scan(value, dayId, currentDay) {
  if (value === "done") return ["✓ Scanned", "ok"];
  if (value === "no" || dayId < currentDay) return ["✗ Missing", "bad"];
  return ["Pending", "wait"];
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.dir = "auto";
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

let data;
let month;
let week;
let request;

function fillMonths() {
  const select = element("month");
  const current = today().slice(0, 7);
  const date = asDate(current + "-01");
  for (let i = 0; i < 12; i++) {
    const value = iso(date).slice(0, 7);
    if (i && value < FIRST_MONTH) break;
    select.add(new Option(fmt(value + "-01", { month: "long", year: "numeric" }), value));
    date.setUTCMonth(date.getUTCMonth() - 1);
  }
  month = current;
  select.value = month;
}

function fillWeeks(days) {
  const select = element("week");
  const starts = [...new Set(days.map(day => weekStart(day.id)))].sort();
  const currentWeek = weekStart(today());
  if (starts.length && week !== "all" && !starts.includes(week)) week = starts.includes(currentWeek) ? currentWeek : starts.at(-1);
  select.replaceChildren(new Option("Whole month", "all"));
  starts.forEach((start, i) => {
    const inWeek = days.filter(day => weekStart(day.id) === start).map(day => day.id);
    select.add(new Option(`Week ${i + 1} (${fmt(inWeek[0], { day: "numeric" })}–${fmt(inWeek.at(-1), { day: "numeric", month: "short" })})`, start));
  });
  select.value = starts.includes(week) ? week : "all";
}

function render() {
  element("monitor").textContent = data?.am ? "Area Monitor: " + data.am : "";
  const schools = new Map((data?.schools || []).filter(school => school.type === "snack").map(school => [school.id, school]));
  const all = (data?.days || []).filter(day => day.rows.some(row => schools.has(row.id)));
  fillWeeks(all);
  const days = all.filter(day => !week || week === "all" || weekStart(day.id) === week);
  element("schedule").hidden = !days.length;
  const list = element("days");
  list.replaceChildren();
  const currentDay = today();
  let total = 0;

  for (const day of days) {
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const label of ["School", "Missing scan"]) head.append(text("th", label));
    const body = table.createTBody();
    for (const row of day.rows) {
      const school = schools.get(row.id);
      if (!school || row.cancel) continue;
      const parts = [];
      if (scan(row.qr, day.id, currentDay)[1] === "bad") parts.push("Main");
      if (row.alg > 0 && scan(row.aq, day.id, currentDay)[1] === "bad") parts.push("Allergy");
      if (!parts.length) continue;
      total += parts.length;
      const tr = body.insertRow();
      const name = text("td", school.en || school.name || school.id);
      if (school.en && school.name) name.append(text("span", school.name, "ar"));
      tr.append(name, text("td", parts.join(" + "), "s bad"));
    }
    if (!body.rows.length) continue;
    const section = document.createElement("section");
    section.className = "day";
    section.append(text("h2", dayLabel(day.id)), table);
    list.append(section);
  }
  element("total").textContent = total ? `${total} missing scan${total === 1 ? "" : "s"}` : "";
  element("complete").hidden = total !== 0;
}

function notice(message) {
  element("notice").textContent = message || "";
}

async function refresh() {
  const token = new URLSearchParams(location.hash.slice(1)).get("t");
  if (request) return;
  if (!/^[0-9a-f]{64}$/.test(token || "")) {
    notice("This link is invalid or no longer active.");
    return;
  }
  const { url, publishableKey } = window.TD_SUPABASE || {};
  if (!url || !publishableKey) {
    notice("The website is not configured.");
    return;
  }
  if (!data) notice("Loading scans…");
  const controller = new AbortController();
  request = controller;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL("/rest/v1/rpc/td_am_view", url), {
      method: "POST",
      headers: { apikey: publishableKey, "Content-Type": "application/json" },
      body: JSON.stringify({ token, from_day: month + "-01", to_day: monthEnd(month) }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    if (request !== controller) return;
    if (response.status === 401 || response.status === 403) {
      data = undefined;
      render();
      notice("This link is invalid or no longer active.");
      return;
    }
    if (!response.ok) throw new Error("Read failed");
    const result = await response.json();
    if (request !== controller) return;
    data = result;
    render();
    notice(element("schedule").hidden ? "No deliveries in this month." : null);
  } catch {
    if (request === controller) notice("Could not refresh. Check your connection. The page retries automatically.");
  } finally {
    clearTimeout(timeout);
    if (request === controller) request = undefined;
  }
}

function reload() {
  request?.abort();
  request = undefined;
  data = undefined;
  render();
  refresh();
}

fillMonths();
element("month").onchange = event => { month = event.target.value; week = undefined; reload(); };
element("week").onchange = event => { week = event.target.value; render(); };
window.addEventListener("online", refresh);
window.addEventListener("hashchange", reload);
setInterval(refresh, 5 * 60 * 1000);
refresh();
