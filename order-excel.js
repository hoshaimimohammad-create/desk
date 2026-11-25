const sheetJsUrl = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const normalize = value => String(value ?? "").trim().toLowerCase().replace(/&/g, " and ")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const aliases = {
  AP: ["Apple", "Apples"], BA: ["Banana", "Bananas"], PE: ["Pear", "Pears"],
  CA: ["Carrot", "Carrots"], CU: ["Cucumber", "Cucumbers"], MI: ["Milk", "Milk UHT", "UHT Milk"],
  PN: ["Peanut", "Peanuts"], AC: ["Apple Chips"],
  MN: ["Mixed Nuts", "Mixed Nuts and Dried Fruits", "Mixed Nuts and Dried Fruit"],
  GP: ["Green Sour Plums", "Janerik"], NE: ["Nectarine", "Nectarines"], PL: ["Plum", "Plums"],
  AR: ["Apricot", "Apricots"], KK: ["Kaak bi Halib", "Kaak"],
  BC: ["Brioche Coco Raisin", "Brioche Coco Raisins"], BD: ["Brioche Date", "Brioche Dates", "Date Brioche"]
};
const codes = new Map(Object.entries(aliases).flatMap(([code, names]) =>
  [code, ...names].map(name => [normalize(name), code])));

function quantity(value, label) {
  const text = String(value ?? "").trim().replace(/[\s,]/g, "");
  if (!text) return 0;
  const number = Number(text);
  if (!/^\d+(?:\.0+)?$/.test(text) || !Number.isSafeInteger(number) || number > 10000000) {
    throw new Error(`${label} must be a nonnegative whole number.`);
  }
  return number;
}

function deliveryDate(title) {
  const match = /\b(\d{1,2})\s+([a-z]{3,9})\s+(20\d{2})\b/i.exec(title);
  if (!match) throw new Error("Row 2 must contain a date such as Saturday 21 Nov 2026.");
  const [, date, month, year] = match;
  const index = months.indexOf(month.slice(0, 3).toLowerCase());
  const value = new Date(Date.UTC(Number(year), index, Number(date)));
  if (index < 0 || value.getUTCDate() !== Number(date) || value.getUTCMonth() !== index) {
    throw new Error("Row 2 contains an invalid delivery date.");
  }
  return value.toISOString().slice(0, 10);
}

function addItems(target, source) {
  for (const [code, amount] of Object.entries(source)) target[code] = (target[code] || 0) + amount;
}

function packing(comment, parcels, items, rowNumber) {
  const mainItems = Object.keys(items).filter(code => items[code] === parcels);
  if (!/^\s*\d[\d,\s]*[×x]\s*/i.test(comment)) {
    if (Object.keys(items).some(code => items[code] !== parcels)) {
      throw new Error(`Row ${rowNumber}: the packing text must identify the allergy substitutions.`);
    }
    return { n: parcels, main: parcels, mi: mainItems, alg: [] };
  }
  const groups = comment.split(/[·•]/).map(text => {
    const match = /^\s*([\d,\s]+)[×x]\s*(.*?)\s*$/i.exec(text);
    if (!match) throw new Error(`Row ${rowNumber}: a packing group has no parcel count.`);
    const it = [...new Set(match[2].split(/\s*\+\s*/).map(name => codes.get(normalize(name))))];
    if (!it.length || it.some(code => !code)) throw new Error(`Row ${rowNumber}: unknown item in packing text.`);
    return { n: quantity(match[1], `Row ${rowNumber} packing group`), it };
  });
  const packedItems = {};
  for (const group of groups) for (const code of group.it) {
    if (group.n) packedItems[code] = (packedItems[code] || 0) + group.n;
  }
  if (groups.reduce((sum, group) => sum + group.n, 0) !== parcels ||
      [...new Set([...Object.keys(items), ...Object.keys(packedItems)])].some(code => items[code] !== packedItems[code])) {
    throw new Error(`Row ${rowNumber}: packing text does not match its parcel or item quantities.`);
  }
  const [main, ...allergy] = groups;
  return { n: parcels, main: main.n, mi: main.it, alg: allergy.filter(group => group.n > 0) };
}

export function parseOrderWorkbook(xlsx, bytes) {
  const workbook = xlsx.read(bytes, { type: "array", sheetRows: 5001 });
  if (workbook.SheetNames.length !== 1) throw new Error("Choose an order workbook containing one sheet.");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet["!ref"] || xlsx.utils.decode_range(sheet["!ref"]).e.c >= 128) {
    throw new Error("The order sheet is empty or has too many columns.");
  }
  const grid = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: true, range: 0 });
  const day = deliveryDate((grid[1] || []).join(" "));
  const heading = (row, col) => normalize(grid[row]?.[col]);
  if (![3, 4].some(row => ["parcels", "required quantity"].includes(heading(row, 12)))) {
    throw new Error("Column M must be Required Quantity or Parcels.");
  }
  const last = Math.max(grid[3]?.length || 0, grid[4]?.length || 0) - 1;
  if (last < 14 || ![3, 4].some(row => heading(row, last).startsWith("parcels to pack"))) {
    throw new Error("The last column must be Parcels to pack.");
  }
  const columns = [];
  for (let column = 13; column < last; column++) {
    const headers = [heading(4, column), heading(3, column)];
    columns.push({ column, code: headers.map(name => codes.get(name)).find(Boolean), header: headers.find(Boolean) });
  }
  const entries = [];
  const totals = { AM: 0, PM: 0, items: {} };
  let totalRow;
  for (let index = 5; index < grid.length; index++) {
    const cells = grid[index];
    if (cells.slice(0, 13).some(value => normalize(value) === "total")) { totalRow = cells; break; }
    if (cells.every(value => !String(value).trim())) continue;
    const label = `Row ${index + 1}`;
    const cerd = String(cells[6]).trim();
    const shift = String(cells[8]).trim().toUpperCase();
    if (!cerd || !["AM", "PM"].includes(shift)) throw new Error(`${label} needs a CERD code and an AM or PM shift.`);
    const parcels = quantity(cells[12], `${label} parcels`);
    const items = {};
    for (const { column, code, header } of columns) {
      const amount = quantity(cells[column], `${label} ${header || "item"}`);
      if (!amount) continue;
      if (!code) throw new Error(`${label}: unsupported item column “${header || "(blank)"}”.`);
      items[code] = (items[code] || 0) + amount;
    }
    if (parcels && !Object.keys(items).length) throw new Error(`${label} has parcels but no item quantities.`);
    const comment = String(cells[last] || "").trim();
    entries.push({ cerd, shift, items, comment, packing: packing(comment, parcels, items, index + 1) });
    totals[shift] += parcels;
    addItems(totals.items, items);
  }
  if (!entries.length) throw new Error("No delivery rows found in the order sheet.");
  const warnings = [];
  if (!totalRow) {
    warnings.push("No TOTAL row found; workbook totals could not be verified.");
  } else {
    const compare = (name, actual, expected) => {
      if (actual !== expected) warnings.push(`${name}: data rows ${actual}, TOTAL row ${expected}.`);
    };
    compare("Parcels", totals.AM + totals.PM, quantity(totalRow[12], "TOTAL parcels"));
    const declared = {};
    for (const { column, code, header } of columns) {
      if (code) declared[code] = (declared[code] || 0) + quantity(totalRow[column], `TOTAL ${header}`);
    }
    for (const code of Object.keys(declared)) compare(aliases[code][0], totals.items[code] || 0, declared[code]);
  }
  return { day, entries, totals, warnings };
}

export function matchOrder(order, schools) {
  const byCerd = new Map();
  for (const { id, cerd } of schools) {
    const key = String(cerd ?? "").trim();
    if (!key) continue;
    byCerd.set(key, byCerd.has(key) ? null : id);
  }
  const matched = new Map();
  const unmatched = new Set();
  const comments = new Map();
  for (const entry of order.entries) {
    const school = byCerd.get(entry.cerd);
    if (!school) { unmatched.add(entry.cerd); continue; }
    const row = matched.get(school) || { id: school, am: 0, pm: 0, main: 0, alg: 0, ai: {}, it: {}, sh: {}, c: "" };
    const shift = row.sh[entry.shift] || { n: 0, main: 0, mi: [], alg: [] };
    const group = entry.packing;
    shift.n += group.n;
    shift.main += group.main;
    shift.mi = [...new Set([...shift.mi, ...group.mi])];
    shift.alg.push(...group.alg);
    row.sh[entry.shift] = shift;
    row[entry.shift.toLowerCase()] += group.n;
    row.main += group.main;
    row.alg += group.n - group.main;
    addItems(row.it, entry.items);
    for (const { n, it } of group.alg) for (const code of it) row.ai[code] = (row.ai[code] || 0) + n;
    if (entry.comment) {
      if (!comments.has(school)) comments.set(school, []);
      comments.get(school).push(entry);
    }
    matched.set(school, row);
  }
  for (const [id, notes] of comments) {
    matched.get(id).c = notes.length === 1 ? notes[0].comment :
      notes.map(note => `${note.shift}: ${note.comment}`).join("\n");
  }
  return { rows: [...matched.values()], unmatched: [...unmatched].sort() };
}

export function mountOrderExcel(account, client) {
  const open = document.createElement("button");
  open.type = "button";
  open.className = "btn ghost";
  open.textContent = "Upload order Excel";
  account.append(open);

  open.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "card";
    dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
    dialog.innerHTML = `
      <h2>Upload order Excel</h2>
      <label class="fl">Order workbook<input type="file" accept=".xlsx"></label>
      <div data-preview></div>
      <button type="button" class="btn" data-save disabled>Save delivery day</button>
      <button type="button" class="btn ghost" data-close>Close</button>
      <p role="status"></p>
    `;
    const input = dialog.querySelector("input");
    const preview = dialog.querySelector("[data-preview]");
    const save = dialog.querySelector("[data-save]");
    const close = dialog.querySelector("[data-close]");
    const status = dialog.querySelector("[role=status]");
    let pending;
    let busy = false;
    const display = (text, warning = false) => {
      const element = document.createElement("p");
      element.textContent = text;
      if (warning) element.className = "flag";
      preview.append(element);
    };
    close.onclick = () => dialog.close();
    dialog.addEventListener("close", () => dialog.remove());
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });

    input.onchange = async () => {
      pending = undefined;
      preview.replaceChildren();
      status.textContent = "";
      const file = input.files[0];
      if (!file) return;
      busy = input.disabled = close.disabled = true;
      save.disabled = true;
      try {
        if (!/\.xlsx$/i.test(file.name) || file.size > 5 * 1024 * 1024) {
          throw new Error("Choose an .xlsx file up to 5 MiB.");
        }
        status.textContent = "Reading order workbook…";
        const xlsx = await import(sheetJsUrl);
        const order = parseOrderWorkbook(xlsx, await file.arrayBuffer());
        const { data: context, error } = await client.rpc("td_order_import_context", { day: order.day });
        if (error) throw error;
        const { rows, unmatched } = matchOrder(order, context.schools);
        const am = rows.reduce((sum, row) => sum + row.am, 0);
        const pm = rows.reduce((sum, row) => sum + row.pm, 0);
        display(`${order.day} · ${rows.length} matched schools · AM ${am} · PM ${pm}`);
        display(`Workbook totals including unmatched rows: AM ${order.totals.AM} · PM ${order.totals.PM}`);
        display("Workbook item totals: " + Object.entries(order.totals.items)
          .map(([code, total]) => `${aliases[code][0]} ${total}`).join(" · "));
        if (unmatched.length) display(`Unmatched CERD codes (excluded from save): ${unmatched.join(", ")}`, true);
        if (order.warnings.length) display("TOTAL warning: " + order.warnings.join(" "), true);
        if (context.revision) display("A delivery day already exists. Saving will replace its order rows.");
        if (!rows.length) display("No matched schools to save.", true);
        else pending = { day: order.day, rows, expected_revision: context.revision };
        status.textContent = "Review the preview before saving.";
      } catch (error) {
        status.textContent = error.message || "Unable to open the order workbook.";
      } finally {
        busy = input.disabled = close.disabled = false;
        save.disabled = !pending;
      }
    };

    save.onclick = async () => {
      if (busy || !pending) return;
      if (pending.expected_revision && !confirm(`Replace the delivery day for ${pending.day}?`)) return;
      busy = input.disabled = save.disabled = close.disabled = true;
      status.textContent = "Saving delivery day…";
      try {
        const { error } = await client.rpc("td_save_order_day", pending);
        if (error) throw error;
        status.textContent = `Saved delivery day ${pending.day}.`;
        pending = undefined;
      } catch (error) {
        status.textContent = error.message || "Unable to save the delivery day.";
      } finally {
        busy = input.disabled = close.disabled = false;
        save.disabled = !pending;
      }
    };
    document.body.append(dialog);
    dialog.showModal();
  };
}
