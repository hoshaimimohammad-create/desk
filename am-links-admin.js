function button(label, action) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "btn ghost";
  control.textContent = label;
  control.onclick = action;
  return control;
}

export async function openAreaMonitorLinks(client) {
  const dialog = document.createElement("dialog");
  dialog.className = "card";
  dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
  const heading = document.createElement("h2");
  heading.id = "area-monitor-links-title";
  heading.textContent = "Area Monitor links";
  dialog.setAttribute("aria-labelledby", heading.id);
  const help = document.createElement("p");
  help.textContent = "Anyone with a link can view that monitor’s schools and waybill notes. Creating a new link replaces the previous one.";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const list = document.createElement("ul");

  const share = document.createElement("div");
  share.hidden = true;
  const input = document.createElement("input");
  input.readOnly = true;
  input.setAttribute("aria-label", "New Area Monitor link");
  input.style.width = "100%";
  const shareStatus = document.createElement("p");
  shareStatus.setAttribute("role", "status");
  share.append(input, button("Copy", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      shareStatus.textContent = "Copied.";
    } catch {
      input.focus();
      input.select();
      shareStatus.textContent = "Copy the selected link.";
    }
  }), shareStatus);

  dialog.append(heading, help, share, status, list, button("Close", () => dialog.close()));
  dialog.addEventListener("close", () => {
    input.value = "";
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  status.textContent = "Loading Area Monitor links…";

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  async function perform(action) {
    list.inert = true;
    share.hidden = true;
    input.value = "";
    shareStatus.textContent = "";
    status.textContent = "Saving…";
    try {
      status.textContent = await action();
    } catch {
      status.textContent = "Could not save. Reopen Area Monitor links before trying again.";
    }
    try {
      await load();
    } catch {
      list.replaceChildren();
      status.textContent += " Could not refresh the list.";
    } finally {
      list.inert = false;
    }
  }

  async function load() {
    const [names, links] = await Promise.all([
      rpc("td_am_names"),
      rpc("td_am_link_list")
    ]);
    const monitors = new Set(names);
    const active = new Map(links.filter(link => !link.revoked_at).map(link => [link.am, link]));
    list.replaceChildren();
    for (const name of [...new Set([...monitors, ...active.keys()])].sort((a, b) => a.localeCompare(b))) {
      const row = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = name;
      const link = active.get(name);
      row.append(label, link ? " · Active " : " · No active link ");
      if (monitors.has(name)) row.append(button("Create link", () => {
        if (link && !window.confirm("Replace the active link for " + name + "?")) return;
        return perform(async () => {
          const token = await rpc("td_am_link_create", { am: name });
          if (!dialog.open) return "";
          const url = new URL("am/", new URL(".", location.href));
          url.hash = "t=" + token;
          input.value = url.href;
          share.hidden = false;
          return "New link for " + name + ". Copy it before closing this window.";
        });
      }));
      if (link) row.append(button("Revoke", () => {
        if (!window.confirm("Revoke the link for " + name + "?")) return;
        return perform(async () => {
          await rpc("td_am_link_revoke", { link_id: link.id });
          return "Link revoked for " + name + ".";
        });
      }));
      list.append(row);
    }
  }

  try {
    await load();
    status.textContent = list.childElementCount ? "" : "No Area Monitors are assigned to schools.";
  } catch {
    status.textContent = "Could not load Area Monitor links. Close and try again.";
  }
}
