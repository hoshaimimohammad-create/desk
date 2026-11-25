const targetBytes = 300000;
const longestSide = 1600;
const originalTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function preparePhotoForStorage(file) {
  if (!file.type.startsWith("image/")) return file;

  // The decoder applies EXIF before we measure or draw the image. Compressed
  // JPEGs contain the upright pixels, so they need no orientation metadata.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This photo format could not be opened. Use JPEG, PNG or WebP.");
  }
  const canvas = document.createElement("canvas");
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (file.size <= targetBytes && longest <= longestSide && originalTypes.has(file.type)) return file;

    const ctx = canvas.getContext("2d");
    let scale = Math.min(1, longestSide / longest);
    let smallest;
    for (let pass = 0; pass < 4; pass++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.75, 0.65, 0.55]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
        if (!blob || blob.type !== "image/jpeg") throw new Error("Could not compress the photo as JPEG.");
        if (!smallest || blob.size < smallest.size) smallest = blob;
        if (smallest.size <= targetBytes) break;
      }
      if (smallest.size <= targetBytes) break;
      scale *= Math.min(0.85, Math.sqrt(targetBytes / smallest.size) * 0.95);
    }
    const name = file.name.replace(/\.[^.]+$/, "").slice(0, 196) || "Photo";
    return new File([smallest], name + ".jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
    canvas.width = canvas.height = 0;
  }
}
