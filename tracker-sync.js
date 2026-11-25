export async function openTrackerSync(client, canRotate) {
  const button = text => Object.assign(document.createElement("button"), {
    type: "button", className: "btn ghost", textContent: text
  });
  const dialog = document.createElement("dialog");
  dialog.className = "card";
  dialog.style.cssText = "width:min(94vw,45rem);max-height:85dvh;overflow:auto";
  const title = document.createElement("h2");
  title.textContent = "Tracker sync";
  const result = document.createElement("div");
  const status = document.createElement("p");
  status.setAttribute("role","status");
  const close = button("Close");
  close.onclick = () => dialog.close();
  dialog.append(title, result, status);
  if (canRotate) {
    const rotate = button("New sync token");
    rotate.onclick = async () => {
      if (!confirm("Generate a new sync token? The previous token will stop working.")) return;
      dialog.querySelector("[data-sync-token]")?.remove();
      rotate.disabled = true;
      try {
        const { data, error } = await client.rpc("td_new_tracker_token");
        if (error) throw error;
        const label = document.createElement("label");
        label.dataset.syncToken = "";
        label.textContent = "Copy this token to Apps Script. It is shown only now.";
        const field = document.createElement("input");
        field.type = "text";
        field.readOnly = true;
        field.autocomplete = "off";
        field.spellcheck = false;
        field.value = data;
        label.append(field);
        dialog.insertBefore(label, close);
        field.select();
      } catch (error) {
        status.textContent = error.message || "Could not create a sync token.";
      } finally { rotate.disabled = false; }
    };
    dialog.append(rotate);
  }
  dialog.append(close);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  status.textContent = "Loading tracker runs…";
  try {
    const { data, error } = await client.rpc("td_tracker_sync_log");
    if (error) throw error;
    status.textContent = data.length ? "" : "No tracker run has been recorded.";
    for (const [index, run] of data.entries()) {
      const details = document.createElement("details");
      details.open = index === 0;
      const summary = document.createElement("summary");
      const time = new Date(run.ran_at).toLocaleString("en-GB", { timeZone: "Asia/Beirut" });
      summary.textContent = `${run.day} · ${run.schools} schools · ${time} (Beirut)`;
      details.append(summary);
      if (run.unknown_cerd.length) {
        const p = document.createElement("p");
        p.textContent = "Unknown or ambiguous CERD: " + run.unknown_cerd.join(", ");
        details.append(p);
      }
      const list = document.createElement("ul");
      for (const difference of run.differences) {
        const item = document.createElement("li");
        item.textContent = `${difference.school} · ${difference.item}: ${difference.old} → ${difference.new}`;
        list.append(item);
      }
      if (!run.differences.length) {
        const item = document.createElement("li");
        item.textContent = "No quantity changes.";
        list.append(item);
      }
      details.append(list);
      result.append(details);
    }
  } catch (error) {
    status.textContent = error.message || "Could not read tracker runs.";
  }
}
