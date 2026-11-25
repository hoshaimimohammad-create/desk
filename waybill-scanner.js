const jsQrUrl = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
let jsQrLoading;

function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQrLoading ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = jsQrUrl;
    script.onload = () => window.jsQR ? resolve(window.jsQR) : reject(new Error("QR reader missing"));
    script.onerror = () => { jsQrLoading = undefined; reject(new Error("QR reader did not load")); };
    document.head.append(script);
  });
  return jsQrLoading;
}

// The SMeTS scan paper is the only form with a QR code. Decide that on the phone with a real
// QR decoder ("found" / "none"), never from the AI's opinion. "unknown" if no decoder could run.
export async function detectQr(canvas) {
  try {
    if ("BarcodeDetector" in window) {
      const formats = await window.BarcodeDetector.getSupportedFormats?.();
      if (!formats || formats.includes("qr_code")) {
        const found = await new window.BarcodeDetector({ formats: ["qr_code"] }).detect(canvas);
        if (found.length) return "found";
      }
    }
  } catch {}
  try {
    const jsQR = await loadJsQr();
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(pixels.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" }) ? "found" : "none";
  } catch {
    return "unknown";
  }
}

async function prepareImage(file) {
  if (!file.type.startsWith("image/") || file.size > 25 * 1024 * 1024) {
    throw new Error("Choose an image up to 25 MiB.");
  }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This photo format could not be opened. Use JPEG or PNG.");
  }
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob || blob.size > 2 * 1024 * 1024) throw new Error("The prepared photo exceeds 2 MiB.");
    let qr = await detectQr(canvas);
    if (qr === "none" && scale < 1) {
      // Retry cropped original pixels at full resolution; keep memory bounded
      // on phones rather than handing a full camera frame to the JS detector.
      const tile = document.createElement("canvas");
      const tileSize = 1600;
      const stride = 1200;
      try {
        for (let y = 0; y < bitmap.height && qr !== "found"; y += stride) {
          for (let x = 0; x < bitmap.width && qr !== "found"; x += stride) {
            tile.width = Math.min(tileSize, bitmap.width - x);
            tile.height = Math.min(tileSize, bitmap.height - y);
            tile.getContext("2d").drawImage(bitmap, x, y, tile.width, tile.height, 0, 0, tile.width, tile.height);
            const tileQr = await detectQr(tile);
            if (tileQr === "found") qr = tileQr;
          }
        }
      } finally {
        tile.width = tile.height = 0;
      }
    }
    return { image: new File([blob], "Waybill scan.jpg", { type: "image/jpeg" }), qr };
  } finally {
    bitmap.close();
  }
}

export function createWaybillScanner(client, attachments) {
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }

  async function read(day, image, qr) {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session) throw new Error("Sign in again to scan waybills.");
    const response = await fetch("/api/scan-waybill", {
      method: "POST", headers: {
        "Content-Type": "image/jpeg", "X-Waybill-Day": day, "X-Waybill-QR": qr,
        Authorization: `Bearer ${data.session.access_token}`
      }, body: image, signal: AbortSignal.timeout(120000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.state) {
      throw new Error(result.error || "Smart Scanner is unavailable. Use the per-school Scans control or try again.");
    }
    return result;
  }

  function open(day) {
    const dialog = document.createElement("dialog");
    dialog.className = "card";
    dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
    const title = document.createElement("h2");
    title.textContent = "Photo a waybill";
    const date = document.createElement("p");
    date.textContent = `Delivery day: ${day}`;
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const decisions = document.createElement("div");
    const results = document.createElement("ol");
    const preview = document.createElement("img");
    preview.style.cssText = "max-width:100%;max-height:32vh;object-fit:contain";
    preview.alt = "Photo awaiting school confirmation";
    preview.hidden = true;
    let pickSchool;
    let previewUrl;
    let busy = false;
    function clearPreview() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = undefined;
      preview.removeAttribute("src");
      preview.hidden = true;
    }
    function button(text, handler) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "btn ghost";
      element.textContent = text;
      element.onclick = handler;
      return element;
    }
    const close = button("Close", () => dialog.close());
    function picker(text, multiple) {
      const label = document.createElement("label");
      label.className = "fl";
      label.textContent = text;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = multiple;
      if (!multiple) input.setAttribute("capture", "environment");
      input.onchange = () => run([...input.files]);
      label.append(input);
      dialog.append(label);
      return input;
    }

    async function confirm(reading, image) {
      const eligible = reading.eligibleSchools || reading.suggestions;
      if (!eligible.length) return null;
      previewUrl = URL.createObjectURL(image);
      preview.src = previewUrl;
      preview.hidden = false;
      status.textContent = reading.rejection || "Confirm the school shown on this photo.";
      return new Promise(resolve => {
        pickSchool = resolve;
        for (const school of reading.suggestions) {
          decisions.append(button(school.label, () => resolve(school.id)));
        }
        const label = document.createElement("label");
        label.className = "fl";
        label.textContent = "Scheduled school";
        const select = document.createElement("select");
        select.add(new Option("Choose a school", ""));
        for (const school of eligible) select.add(new Option(school.label, school.id));
        label.append(select);
        const useSchool = button("Confirm selected school", () => resolve(select.value));
        useSchool.disabled = true;
        select.onchange = () => { useSchool.disabled = !select.value; };
        decisions.append(label, useSchool, button("Skip photo", () => resolve(null)));
        decisions.querySelector("button")?.focus();
      }).finally(() => {
        pickSchool = undefined;
        decisions.replaceChildren();
        clearPreview();
      });
    }

    async function selectType(image) {
      previewUrl = URL.createObjectURL(image);
      preview.src = previewUrl;
      preview.hidden = false;
      status.textContent = "Document type is uncertain. Select the type shown in this photo.";
      return new Promise(resolve => {
        pickSchool = resolve;
        for (const [label, type] of [
          ["Handwritten paper", "paper"], ["SMeTS with QR", "qp"], ["Allergy form", "ap"]
        ]) decisions.append(button(label, () => resolve(type)));
        decisions.append(button("Skip photo", () => resolve(null)));
        decisions.querySelector("button")?.focus();
      }).finally(() => {
        pickSchool = undefined;
        decisions.replaceChildren();
        clearPreview();
      });
    }

    async function run(files) {
      if (busy || !files.length) return;
      busy = true;
      camera.disabled = gallery.disabled = close.disabled = true;
      results.replaceChildren();
      try {
        for (const [index, file] of files.entries()) {
          const result = document.createElement("li");
          results.append(result);
          const step = `${index + 1}/${files.length}`;
          status.textContent = `Reading photo ${step}…`;
          try {
            const { image, qr } = await prepareImage(file);
            const reading = await read(day, image, qr);
            if (reading.state === "duplicate" || reading.state === "processing") {
              result.textContent = `Photo ${step}: already submitted or in progress.`;
              continue;
            }
            if (reading.state === "rejected") {
              result.textContent = `Photo ${step}: ${reading.reason}`;
              continue;
            }
            const school = reading.reservedSchool
              ? await confirm({
                suggestions: reading.eligibleSchools.filter(s => s.id === reading.reservedSchool)
              }, image)
              : reading.automatic || await confirm(reading, image);
            if (!school) {
              result.textContent = `Photo ${step}: ${reading.rejection || "no change."} Use the Scans control on the correct school row if needed.`;
              continue;
            }
            const chosenType = reading.needsType ? reading.reservedType || await selectType(image) : null;
            if (reading.needsType && !chosenType) {
              result.textContent = `Photo ${step}: skipped without selecting a document type.`;
              continue;
            }
            const stored = await attachments.prepareUpload(file);
            const fileId = await rpc("td_reserve_waybill_scan_photo", {
              scan_id: reading.id, school, byte_count: stored.size, chosen_type: chosenType,
              name: stored.name.slice(0, 200), content_type: stored.type
            });
            status.textContent = `Saving photo ${step}…`;
            await attachments.uploadReserved(fileId, stored, fraction => {
              status.textContent = `Saving photo ${step}: ${Math.round(fraction * 100)}%`;
            });
            const confirmed = await rpc("td_confirm_waybill_scan", { scan_id: reading.id });
            const field = confirmed.status;
            const label = (reading.eligibleSchools || reading.suggestions).find(candidate => candidate.id === school)?.label || school;
            const document = { paper: "Paper Waybill", qp: "SMeTS scan paper", ap: "Allergy paper" }[field] || "Waybill";
            const dateWarning = reading.documentDate && reading.documentDate !== day
              ? ` Photo date ${reading.documentDate} differs from selected day ${day}.` : "";
            const check = confirmed.check === "?" ? " Quantities not readable on the photo, check by hand."
              : confirmed.check && confirmed.check !== "ok" ? ` Quantity discrepancy: ${confirmed.check}.` : "";
            result.textContent = `Photo ${step}: ${label} · ${document} marked Received.${check}${dateWarning} `;
            const undo = button("Undo", async () => {
              undo.disabled = true;
              try {
                const attachmentId = await rpc("td_undo_waybill_scan", { scan_id: reading.id });
                result.textContent = `Photo ${step}: previous status, attachments and quantity check restored.`;
                try {
                  await attachments.remove({ id: attachmentId });
                } catch {
                  result.append(" Remove the incomplete file from Scans if cleanup is needed.");
                }
              } catch (error) {
                undo.disabled = false;
                status.textContent = error.message || "Undo failed.";
              }
            });
            result.append(undo);
          } catch (error) {
            result.textContent = `Photo ${step}: ${error.message || "Scan failed."}`;
          }
        }
        status.textContent = "Batch finished.";
      } finally {
        busy = false;
        camera.disabled = gallery.disabled = close.disabled = false;
        camera.value = gallery.value = "";
      }
    }

    dialog.append(title, date);
    const camera = picker("Take a photo", false);
    const gallery = picker("Choose photos", true);
    dialog.append(status, preview, decisions, results, close);
    dialog.addEventListener("cancel", event => {
      if (busy) {
        event.preventDefault();
        pickSchool?.(null);
      }
    });
    dialog.addEventListener("close", () => {
      clearPreview();
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  }
  return { open };
}
