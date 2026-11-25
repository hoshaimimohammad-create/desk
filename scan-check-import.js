export function mountScanCheckImport(account, client) {
  const launch = document.createElement("button");
  launch.type = "button";
  launch.className = "btn ghost";
  launch.textContent = "Paste scan-check result";
  account.append(launch);

  launch.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "card";
    dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
    dialog.innerHTML = `
      <h2>Paste scan-check result</h2>
      <label class="fl">Scan-check JSON<textarea rows="8" spellcheck="false"
        placeholder='{"day":"YYYY-MM-DD","results":[{"id":"S901","qr":"done"}]}'></textarea></label>
      <button type="button" class="btn" data-apply>Apply result</button>
      <button type="button" class="btn ghost" data-close>Close</button>
      <p role="status"></p>
    `;
    const input = dialog.querySelector("textarea");
    const apply = dialog.querySelector("[data-apply]");
    const close = dialog.querySelector("[data-close]");
    const status = dialog.querySelector("[role=status]");
    close.onclick = () => dialog.close();
    dialog.addEventListener("close", () => dialog.remove());
    dialog.addEventListener("cancel", event => {
      if (apply.disabled) event.preventDefault();
    });

    apply.onclick = async () => {
      let request;
      try {
        request = JSON.parse(input.value);
        if (!request || typeof request.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(request.day) || !Array.isArray(request.results)) {
          throw new Error("Wrong envelope");
        }
      } catch {
        status.textContent = "Paste valid JSON containing a day and a results array.";
        return;
      }

      apply.disabled = input.disabled = close.disabled = true;
      status.textContent = `Applying results for ${request.day}…`;
      try {
        const { data, error } = await client.rpc("td_apply_scan_check", {
          day: request.day, results: request.results
        });
        if (error) throw error;
        status.textContent = `Applied ${request.day}. Waybills changed: ${data.waybills_changed}. Tracker rows changed: ${data.tracker_rows_changed}. Cancelled scan statuses skipped: ${data.cancelled_skipped}.`;
      } catch (error) {
        status.textContent = error.message || "Could not apply the scan-check result.";
      } finally {
        apply.disabled = input.disabled = close.disabled = false;
      }
    };
    document.body.append(dialog);
    dialog.showModal();
  };
}
