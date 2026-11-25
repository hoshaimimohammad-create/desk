// The worker and its two helpers are serialized into a self-contained bookmark URL.
export async function sendSmets(project, publishableKey, token, payload) {
  let response;
  try {
    response = await fetch(new URL("/rest/v1/rpc/td_import_smets", project), {
      method: "POST", headers: { apikey: publishableKey, "content-type": "application/json" },
      body: JSON.stringify({ token, payload }), credentials: "omit", redirect: "error",
      referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(20000)
    });
  } catch {
    return null; // The source site's CSP may block the connection.
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The SMeTS button token was rejected. Ask Full Access staff for a new bookmark.");
  }
  if (!response.ok) throw new Error("The desk could not confirm this scan check. Check the run history before retrying.");
  const result = await response.json().catch(() => null);
  if (!result || !Number.isInteger(result.updated) || !Number.isInteger(result.days) || !Array.isArray(result.unknown_cerd)) {
    throw new Error("The desk returned an unexpected response. Check the run history before retrying.");
  }
  return result;
}

export function smetsResultText(result) {
  return `Updated ${result.updated} schools · ${result.days} days · unknown CERD: ${result.unknown_cerd.join(", ") || "none"}`;
}

async function runBookmarklet(config, submit, format) {
  const { smets, site, project, publishableKey, token } = config;
  if (location.origin !== smets) {
    window.alert("Open your signed-in SMeTS tab before using this bookmark.");
    return;
  }
  // The only cross-origin write is to the separately configured Supabase host.
  if (![smets, site].every(origin => origin.startsWith("https://")) ||
    !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(project) || smets === project || smets === site) {
    window.alert("This bookmark is configured incorrectly. Ask Full Access staff to replace it.");
    return;
  }

  const popup = window.open("about:blank", "_blank", "popup,width=500,height=340");
  const recentDays = new Set();
  const beirutDate = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit"
  });
  function dateInBeirut(date) {
    const parts = Object.fromEntries(beirutDate.formatToParts(date).map(({ type, value }) => [type, value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  const midnight = Date.parse(dateInBeirut(new Date()) + "T00:00:00Z");
  for (let i = 0; i < 7; i++) recentDays.add(new Date(midnight - i * 86400000).toISOString().slice(0, 10));

  async function readPages(resource, pageSize, orderId, take) {
    for (let page = 1; page <= 100; page++) {
      const url = new URL("/api/v1/smt_core/" + resource + "/", smets);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(pageSize));
      if (orderId !== null) url.searchParams.set("order", orderId);
      const response = await fetch(url, {
        method: "GET", credentials: "same-origin", mode: "same-origin", redirect: "error",
        referrerPolicy: "no-referrer", cache: "no-store", signal: AbortSignal.timeout(15000)
      }).catch(() => null);
      const data = response?.ok ? await response.json().catch(() => null) : null;
      if (!data || !Array.isArray(data.results) || data.results.length > pageSize ||
        (data.next !== null && (typeof data.next !== "string" || !data.next))) {
        throw new Error("Could not read SMeTS. Check that you are signed in, then retry.");
      }
      for (const row of data.results) take(row);
      if (data.next === null) return;
    }
    throw new Error("SMeTS pagination exceeded the read limit. Use the paste backup.");
  }

  async function handoff(payload) {
    if (!popup || popup.closed) throw new Error("Allow pop-ups for SMeTS and retry, or use the paste backup.");
    const channel = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
    const landing = new URL("/smets/", site);
    landing.hash = new URLSearchParams({ source: smets, channel }).toString();
    await new Promise((resolve, reject) => {
      function finish(error) {
        clearTimeout(timer);
        window.removeEventListener("message", receive);
        if (error) reject(error);
        else resolve();
      }
      function receive(event) {
        if (event.origin !== site || event.source !== popup || event.data?.type !== "td-smets-ready" ||
          event.data.channel !== channel) return;
        popup.postMessage({ type: "td-smets-submit", channel, token, payload }, site);
        finish();
      }
      const timer = setTimeout(() => finish(new Error("The desk window could not receive the scan check. Use the paste backup.")), 15000);
      window.addEventListener("message", receive);
      try {
        popup.location.replace(landing.href);
      } catch {
        finish(new Error("Could not open the desk window. Use the paste backup."));
      }
    });
  }

  try {
    const orders = [];
    let itemCount = 0;
    await readPages("order", 100, null, order => {
      const raw = order?.deliveryDate;
      const timestamp = typeof raw === "string" ? Date.parse(raw) : NaN;
      if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}(?:$|T.*(?:Z|[+-]\d{2}:\d{2})$)/.test(raw)) {
        throw new Error("SMeTS returned an invalid delivery date.");
      }
      const day = raw.length === 10 ? raw : dateInBeirut(new Date(timestamp));
      if (!recentDays.has(day)) return;
      const id = String(order.id ?? "");
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("SMeTS returned an invalid order ID.");
      orders.push({ id, day, items: [] });
      if (orders.length > 50) throw new Error("More than 50 recent orders. Use the paste backup.");
    });
    for (const order of orders) {
      await readPages("order_item", 200, order.id, item => {
        const cerd = String(item?.schoolRef ?? "").trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(cerd) || typeof item?.state !== "string" ||
          !/^[A-Za-z0-9_ -]{1,64}$/.test(item.state)) throw new Error("SMeTS returned an invalid CERD or item state.");
        order.items.push({ cerd, state: item.state });
        if (++itemCount > 5000) throw new Error("More than 5000 recent items. Use the paste backup.");
      });
    }
    const payload = { orders };
    const result = await submit(project, publishableKey, token, payload);
    if (result === null) await handoff(payload);
    else {
      popup?.close();
      window.alert(format(result));
    }
  } catch (error) {
    popup?.close();
    window.alert(error.message || "The scan check could not finish.");
  }
}

export function makeSmetsBookmarklet({ smets, site, project, publishableKey, token }) {
  const config = JSON.stringify({ smets, site, project, publishableKey, token });
  return "javascript:" + encodeURIComponent(`void (${runBookmarklet})(${config}, ${sendSmets}, ${smetsResultText})`);
}
