import { makeSmetsBookmarklet } from "./smets-bookmarklet.js";

export async function openSmetsButton(client, config, canCreate) {
  const dialog = document.createElement("dialog");
  dialog.className = "card";
  dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
  dialog.innerHTML = `
    <h2>SMeTS button</h2>
    <p>Enter the origin from your SMeTS address bar. Create the bookmark, drag it to your bookmarks bar, then click it while signed in to SMeTS.</p>
    <label class="fl">SMeTS origin <input type="url" autocomplete="off" spellcheck="false"></label>
    <button type="button" class="btn" data-create>Create bookmark</button>
    <button type="button" class="btn ghost" data-revoke>Revoke bookmark</button>
    <p><a hidden draggable="true">Check SMeTS scans</a></p>
    <p role="status"></p>
    <h3>Last 10 runs</h3>
    <ol></ol>
    <button type="button" class="btn ghost" data-close>Close</button>
  `;
  const input = dialog.querySelector("input");
  const create = dialog.querySelector("[data-create]");
  const revoke = dialog.querySelector("[data-revoke]");
  const link = dialog.querySelector("a");
  const status = dialog.querySelector("[role=status]");
  const runs = dialog.querySelector("ol");
  create.disabled = !canCreate;
  input.disabled = !canCreate;
  dialog.querySelector("[data-close]").onclick = () => dialog.close();
  link.onclick = event => event.preventDefault();
  dialog.addEventListener("close", () => {
    link.removeAttribute("href");
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();

  function forgetLink() {
    link.hidden = true;
    link.removeAttribute("href");
  }

  async function change(action) {
    create.disabled = revoke.disabled = true;
    status.textContent = "Saving…";
    try {
      status.textContent = await action();
    } catch {
      status.textContent = "Could not update the bookmark. Check that migration 0013 has been applied.";
    } finally {
      create.disabled = !canCreate;
      revoke.disabled = false;
    }
  }

  create.onclick = () => {
    let origin;
    try {
      const url = new URL(input.value.trim());
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
        url.search || url.hash || url.origin === location.origin || url.origin === new URL(config.url).origin ||
        location.protocol !== "https:") throw new Error("Invalid SMeTS origin");
      origin = url.origin;
    } catch {
      status.textContent = "Enter just the HTTPS origin shown in the SMeTS address bar.";
      return;
    }
    if (!window.confirm("Create a new bookmark? This revokes any previous SMeTS bookmark.")) return;
    return change(async () => {
      const { data: token, error } = await client.rpc("td_new_smets_token");
      if (error || !/^[0-9a-f]{64}$/.test(token || "")) throw new Error("Could not create token");
      if (!dialog.open) return "";
      link.href = makeSmetsBookmarklet({
        smets: origin, site: location.origin, project: new URL(config.url).origin,
        publishableKey: config.publishableKey, token
      });
      link.hidden = false;
      return "Drag the link to your bookmarks bar now. Anyone with the bookmark can submit scan results until you revoke it.";
    });
  };

  revoke.onclick = () => {
    if (!window.confirm("Revoke the SMeTS bookmark? It will stop working immediately.")) return;
    return change(async () => {
      const { error } = await client.rpc("td_revoke_smets_token");
      if (error) throw error;
      forgetLink();
      return "Bookmark revoked.";
    });
  };

  try {
    const { data, error } = await client.rpc("td_scan_sync_log");
    if (error) throw error;
    for (const run of data) {
      const item = document.createElement("li");
      const time = new Date(run.ran_at).toLocaleString(undefined, { timeZone: "Asia/Beirut" });
      item.textContent = run.days.map(day => {
        const summary = `${day.day || "No orders"} · ${day.applied} updated`;
        return day.unknown_cerd.length ? summary + " · unknown CERD: " + day.unknown_cerd.join(", ") : summary;
      }).join(" | ");
      item.prepend(time + " · ");
      runs.append(item);
    }
    if (!runs.childElementCount) status.textContent = "No scans imported yet.";
  } catch {
    status.textContent = "Could not load run history. Check that migration 0013 has been applied.";
  }
}
