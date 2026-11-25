export function mountStaffAccess(account, client) {
  const pages = [
    ["td", "Today"], ["wb", "Waybills"], ["sc", "Missing scans"], ["drv", "Drivers"],
    ["iss", "Issues"], ["wt", "Weights & Waste"], ["po", "Snack PO"],
    ["tr", "Transportation PO"], ["pom", "PO Month"], ["qc", "QC Report"],
    ["hyg", "Hygiene Checklist"], ["rep", "Month Report"]
  ];
  const button = label => Object.assign(document.createElement("button"), {
    type: "button", className: "btn ghost", textContent: label
  });
  const open = button("Staff access");
  account.append(open);

  open.onclick = async () => {
    const dialog = document.createElement("dialog");
    dialog.className = "card";
    dialog.style.cssText = "width:min(94vw,82rem);max-height:85dvh;overflow:auto";
    const title = document.createElement("h2");
    title.textContent = "Staff access";
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    status.textContent = "Loading staff…";
    const close = button("Close");
    close.onclick = () => dialog.close();
    const container = document.createElement("div");
    container.className = "tbl";
    const table = document.createElement("table");
    const header = table.createTHead().insertRow();
    for (const label of ["Staff member", ...pages.map(([, label]) => label), "Save"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      header.append(cell);
    }
    const body = table.createTBody();
    container.append(table);
    dialog.append(title, status, container, close);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    try {
      const { data, error } = await client.rpc("td_staff_access");
      if (error) throw error;
      for (const member of data) {
        const row = body.insertRow();
        const label = member.email || member.id;
        row.insertCell().textContent = `${label} · ${member.role}${member.self ? " (you)" : ""}`;
        const controls = new Map();
        const save = button("Save");
        save.setAttribute("aria-label", "Save access for " + label);
        save.disabled = true;
        for (const [key, pageName] of pages) {
          const select = document.createElement("select");
          select.setAttribute("aria-label", label + " · " + pageName);
          for (const [level, label] of [["hidden","Hidden"],["view","View"],["edit","Edit"]]) {
            select.add(new Option(label, level));
          }
          select.value = member.pages[key];
          select.disabled = member.self;
          select.onchange = () => { save.disabled = false; };
          controls.set(key, select);
          row.insertCell().append(select);
        }
        if (!member.self) row.insertCell().append(save);
        else row.insertCell();
        save.onclick = async () => {
          save.disabled = true;
          controls.forEach(select => { select.disabled = true; });
          try {
            const { error } = await client.rpc("td_save_staff_pages", {
              member_id: member.id,
              pages: Object.fromEntries([...controls].map(([key, select]) => [key, select.value]))
            });
            if (error) throw error;
            status.textContent = `Saved access for ${label}.`;
          } catch (error) {
            save.disabled = false;
            status.textContent = error.message || "Staff permissions could not be saved.";
          } finally {
            controls.forEach(select => { select.disabled = false; });
          }
        };
      }
      status.textContent = "Changes take effect when the staff member’s desk refreshes.";
    } catch (error) {
      status.textContent = error.message || "Could not load staff access.";
    }
  };
}
