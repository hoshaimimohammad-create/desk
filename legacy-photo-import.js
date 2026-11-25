const mimeTypes = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  webp: "image/webp", pdf: "application/pdf"
};
const maxBytes = 10 * 1024 * 1024;

export function mountLegacyPhotoImport(account, client, privateFiles) {
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  const launch = document.createElement("button");
  launch.type = "button";
  launch.className = "btn ghost";
  launch.textContent = "Import backup photos";
  account.append(launch);

  launch.onclick = () => {
    const dialog = document.createElement("dialog");
    dialog.className = "card";
    dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
    dialog.innerHTML = `
      <h2>Import backup photos</h2>
      <label class="fl">Choose the backup Photos folder<input type="file" webkitdirectory multiple></label>
      <button type="button" class="btn" data-import disabled>Import photos</button>
      <button type="button" class="btn ghost" data-close>Close</button>
      <p role="status"></p>
      <ul aria-label="Import results"></ul>
    `;
    const picker = dialog.querySelector("input");
    const start = dialog.querySelector("[data-import]");
    const close = dialog.querySelector("[data-close]");
    const status = dialog.querySelector("[role=status]");
    const results = dialog.querySelector("ul");
    let busy = false;
    picker.onchange = () => { start.disabled = !picker.files.length; };
    close.onclick = () => dialog.close();
    dialog.addEventListener("cancel", event => {
      if (busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => dialog.remove());

    function report(label, outcome, detail) {
      const row = document.createElement("li");
      row.textContent = `${label} — ${outcome}${detail ? ": " + detail : ""}`;
      results.append(row);
    }

    start.onclick = async () => {
      if (busy || !picker.files.length) return;
      busy = true;
      picker.disabled = start.disabled = close.disabled = true;
      results.replaceChildren();
      status.textContent = "Checking Issue and QC references…";
      try {
        const references = await rpc("td_legacy_photo_refs");
        const names = new Map();
        const files = [...picker.files];
        for (const file of files) {
          const id = /^([A-Za-z0-9_-]{1,128})\.[^.]+$/.exec(file.name)?.[1];
          if (!id) continue;
          if (!names.has(id)) names.set(id, []);
          names.get(id).push(file);
        }
        const used = new Set();
        for (const reference of references) {
          const { kind, parent_id, source_asset_id } = reference;
          const matches = names.get(source_asset_id) || [];
          matches.forEach(file => used.add(file));
          const label = `${matches.length === 1 ? matches[0].name : source_asset_id} (${kind} ${parent_id})`;
          if (reference.imported) {
            report(label, "Skipped", "Already imported");
            continue;
          }
          if (!matches.length) {
            report(label, "Missing", "No matching file");
            continue;
          }
          if (matches.length > 1) {
            report(label, "Skipped", "Multiple files use this asset ID");
            continue;
          }
          const file = matches[0];
          const extension = file.name.split(".").at(-1).toLowerCase();
          const mime = Object.hasOwn(mimeTypes, extension) ? mimeTypes[extension] : null;
          if (!mime || (mime === "application/pdf" && kind !== "qc") ||
              (file.type && file.type !== mime) || !file.size) {
            report(label, "Skipped", "Unsupported file type or size");
            continue;
          }
          try {
            status.textContent = `Importing ${file.name}…`;
            const original = file.type ? file : new File([file], file.name, { type: mime });
            const upload = await privateFiles.prepareUpload(original);
            if (upload.size > maxBytes) {
              report(label, "Skipped", "File exceeds the Storage size limit");
              continue;
            }
            const reservation = await rpc("td_reserve_legacy_attachment", {
              kind, parent_id, asset_id: source_asset_id, name: upload.name.slice(0, 200),
              content_type: upload.type, byte_count: upload.size
            });
            if (reservation.state === "skipped") {
              report(label, "Skipped", reservation.reason);
              continue;
            }
            await privateFiles.uploadReserved(reservation.id, upload, fraction => {
              status.textContent = `Importing ${file.name}: ${Math.round(fraction * 100)}%`;
            });
            report(label, "Imported");
          } catch (error) {
            report(label, "Failed", error.message || "Import failed");
          }
        }
        for (const file of files) {
          if (!used.has(file)) report(file.name, "Skipped", "No matching Issue or QC reference");
        }
        status.textContent = "Import finished.";
      } catch (error) {
        status.textContent = error.message || "Could not read backup references.";
      } finally {
        busy = false;
        picker.disabled = start.disabled = close.disabled = false;
      }
    };
    document.body.append(dialog);
    dialog.showModal();
  };
}
