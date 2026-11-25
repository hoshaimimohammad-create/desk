import { sendSmets, smetsResultText } from "../smets-bookmarklet.js";

const status = document.getElementById("status");
const params = new URLSearchParams(location.hash.slice(1));
const source = params.get("source");
const channel = params.get("channel");
const opener = window.opener;
const { url, publishableKey } = window.TD_SUPABASE || {};

function isHttpsOrigin(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.origin === value;
  } catch {
    return false;
  }
}

if (!opener || !isHttpsOrigin(source) || source === location.origin ||
  !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url || "") || source === url ||
  !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey || "") ||
  !/^[0-9a-f]{32}$/.test(channel || "")) {
  status.textContent = "Start the scan check from the SMeTS bookmark.";
} else {
  const timer = setTimeout(() => {
    window.removeEventListener("message", receive);
    status.textContent = "No scan check arrived. Open it again from the SMeTS bookmark.";
  }, 15000);
  window.addEventListener("message", receive);
  opener.postMessage({ type: "td-smets-ready", channel }, source);

  async function receive(event) {
    if (event.source !== opener || event.origin !== source || event.data?.type !== "td-smets-submit" ||
      event.data.channel !== channel || !/^[0-9a-f]{64}$/.test(event.data.token || "") ||
      !Array.isArray(event.data.payload?.orders)) return;
    window.removeEventListener("message", receive);
    clearTimeout(timer);
    window.opener = null;
    history.replaceState(null, "", location.pathname);
    status.textContent = "Applying scan check…";
    try {
      const result = await sendSmets(url, publishableKey, event.data.token, event.data.payload);
      status.textContent = result ? smetsResultText(result) : "Could not connect to the desk database. Try again.";
    } catch (error) {
      status.textContent = error.message || "The scan check could not finish.";
    }
  }
}
