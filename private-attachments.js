import { preparePhotoForStorage } from "./photo-compression.js";

const bucketName = "td-private-files";
const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const maxBytes = 10 * 1024 * 1024;
const titles = { waybill: "Waybill scans", qc: "QC attachments", issue: "Issue photos" };

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

function sendFile(config, token, id, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const origin = new URL(config.url).origin;
    xhr.open("POST", `${origin}/storage/v1/object/${bucketName}/${encodeURIComponent(id)}`);
    xhr.setRequestHeader("apikey", config.publishableKey);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.timeout = 120000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Storage rejected the upload (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Connection lost during upload."));
    xhr.ontimeout = () => reject(new Error("Upload timed out."));
    xhr.onabort = () => reject(new Error("Upload was cancelled."));
    const body = new FormData();
    body.append("cacheControl", "0");
    body.append("", file);
    xhr.send(body);
  });
}

export function createPrivateAttachments(client, config, role, userId, pages) {
  const bucket = client.storage?.from(bucketName);
  const rpc = async (name, args) => unwrap(await client.rpc(name, args));
  const attachmentPage = { waybill: "wb", issue: "iss", qc: "qc" };
  const canUpload = kind => pages ? pages[attachmentPage[kind]] === "edit" :
    role === "full" || (role === "waybill_writer" && kind === "waybill");
  const canDelete = file => canUpload(file.record_type) &&
    (role === "full" || file.uploaded_by === userId);
  const types = kind => kind === "qc" ? [...imageTypes, "application/pdf"] : imageTypes;

  async function list(kind, parentId) {
    return unwrap(await client.from("td_attachments").select(
      "id,record_type,filename,mime_type,uploaded_by,ready,created_at"
    ).eq("record_type", kind).eq("record_id", parentId).order("created_at"));
  }

  async function upload(kind, parentId, file, onProgress) {
    if (!types(kind).includes(file.type)) throw new Error("Choose a JPEG, PNG, WebP, or an allowed QC PDF.");
    const prepared = await preparePhotoForStorage(file);
    if (!prepared.size || prepared.size > maxBytes) throw new Error("Choose a file between 1 byte and 10 MB.");
    const { session } = unwrap(await client.auth.getSession());
    if (!session) throw new Error("Sign in again to upload files.");
    const id = await rpc("td_reserve_attachment", {
      kind, parent_id: parentId, name: prepared.name.slice(0, 200),
      content_type: prepared.type, byte_count: prepared.size
    });
    await sendFile(config, session.access_token, id, prepared, onProgress);
    await rpc("td_finish_attachment", { file_id: id });
  }

  async function uploadReserved(id, file, onProgress) {
    const { session } = unwrap(await client.auth.getSession());
    if (!session) throw new Error("Sign in again to upload files.");
    try {
      await sendFile(config, session.access_token, id, file, onProgress);
    } catch (uploadError) {
      // A retry can see an object saved before a previous response was lost.
      try {
        await rpc("td_finish_attachment", { file_id: id });
        return;
      } catch {
        throw uploadError;
      }
    }
    await rpc("td_finish_attachment", { file_id: id });
  }

  async function remove(file) {
    unwrap(await bucket.remove([file.id]));
    await rpc("td_forget_attachment", { file_id: file.id });
  }

  async function download(file) {
    return unwrap(await bucket.download(file.id));
  }

  async function open(kind, parentId) {
    const dialog = document.createElement("dialog");
    dialog.className = "card";
    dialog.style.cssText = "width:min(92vw,38rem);max-height:85dvh;overflow:auto";
    const title = document.createElement("h2");
    title.textContent = titles[kind];
    const files = document.createElement("ul");
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const progress = document.createElement("progress");
    progress.max = 1;
    progress.hidden = true;
    progress.setAttribute("aria-label", "Upload progress");
    const photo = document.createElement("img");
    photo.style.cssText = "display:block;max-width:100%;max-height:50vh;object-fit:contain";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn ghost";
    close.textContent = "Close";
    close.onclick = () => dialog.close();
    let previewUrl;
    let busy = false;
    function clearPreview() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = undefined;
      photo.removeAttribute("src");
      photo.removeAttribute("alt");
    }
    dialog.addEventListener("cancel", event => {
      if (busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      clearPreview();
      dialog.remove();
    });
    dialog.append(title, files, photo, status, progress, close);

    async function action(work) {
      if (busy) return;
      busy = true;
      close.disabled = true;
      dialog.setAttribute("aria-busy", "true");
      status.textContent = "";
      try {
        await work();
      } catch (error) {
        status.textContent = error.message || "Attachment action failed.";
      } finally {
        busy = false;
        close.disabled = false;
        progress.hidden = true;
        dialog.removeAttribute("aria-busy");
      }
    }

    function button(label, handler) {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "chip";
      element.textContent = label;
      element.onclick = () => action(handler);
      return element;
    }

    async function refresh() {
      const rows = await list(kind, parentId);
      files.replaceChildren();
      for (const file of rows) {
        const item = document.createElement("li");
        item.textContent = file.filename + (file.ready ? " " : " (Incomplete upload) ");
        if (file.ready) item.append(button(file.mime_type === "application/pdf" ? "Download" : "View", async () => {
          const blob = await download(file);
          clearPreview();
          if (file.mime_type === "application/pdf") {
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = file.filename;
            dialog.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } else {
            previewUrl = URL.createObjectURL(blob);
            photo.alt = file.filename;
            photo.src = previewUrl;
          }
        }));
        if (canDelete(file)) item.append(button("Delete", async () => {
          if (!confirm(`Delete ${file.filename}?`)) return;
          await remove(file);
          clearPreview();
          await refresh();
          status.textContent = "Attachment deleted.";
        }));
        files.append(item);
      }
      if (!rows.length) {
        const empty = document.createElement("li");
        empty.textContent = "No attachments yet.";
        files.append(empty);
      }
    }

    if (canUpload(kind)) {
      const label = document.createElement("label");
      label.className = "fl";
      label.textContent = kind === "qc" ? "Add photos or PDFs" : "Add photos";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = types(kind).join(",");
      input.multiple = true;
      label.append(input);
      async function uploadSelection(picker) {
        const selected = [...picker.files];
        picker.value = "";
        if (!selected.length) return;
        await action(async () => {
          input.disabled = true;
          camera.disabled = true;
          const errors = [];
          try {
            for (const [i, file] of selected.entries()) {
              progress.hidden = false;
              progress.removeAttribute("value");
              status.textContent = `Uploading ${i + 1} of ${selected.length}: ${file.name}`;
              try {
                await upload(kind, parentId, file, value => { progress.value = value; });
              } catch (error) {
                errors.push(`${file.name}: ${error.message || "Upload failed."}`);
              }
            }
            await refresh();
            status.textContent = errors.length ? errors.join(" ") : "Attachments uploaded.";
          } finally {
            input.disabled = false;
            camera.disabled = false;
          }
        });
      }
      const cameraLabel = document.createElement("label");
      cameraLabel.className = "fl";
      cameraLabel.textContent = "Take a photo";
      const camera = document.createElement("input");
      camera.type = "file";
      camera.accept = imageTypes.join(",");
      camera.setAttribute("capture", "environment");
      cameraLabel.append(camera);
      input.onchange = () => uploadSelection(input);
      camera.onchange = () => uploadSelection(camera);
      dialog.insertBefore(label, files);
      dialog.insertBefore(cameraLabel, files);
    }
    document.body.append(dialog);
    dialog.showModal();
    await action(refresh);
  }

  return { open, list, download, remove, prepareUpload: preparePhotoForStorage, uploadReserved };
}
