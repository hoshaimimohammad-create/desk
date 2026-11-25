// Taanayel Desk - configuration (EXAMPLE, safe to commit).
// Copy this file to src/config.js and put the real values there.
// src/config.js is in .gitignore and must NEVER be committed.
// Every value below is a placeholder.
window.TD_CONFIG = {
  // Emails that get the full (owner-like) view. Real list kept private.
  FULL_EMAILS: [],
  // "Owner" choices in the Issues form.
  OWNERS: ["Warehouse", "Supplier", "Driver", "Area Monitor", "Packing House", "WFP", "Office (Officers)", "Other"],
  // School id -> WFP CERD code. Real mapping kept private.
  CERD: { "S901": "9001", "S902": "9002", "S903": "9003", "K94": "9004", "K95": "9005", "S906": "9006" },
  // Contract unit prices in USD per PO line code. Demo numbers only.
  PRICES: { AP: 1, BA: 1, PE: 1, GP: 1, PL: 1, NE: 1, CA: 1, CU: 1, MI: 0.1, PN: 0.1, MN: 0.1, KK: 0.1, BC: 0.1, BD: 0.1,
            CLEAN: 0.01, SAN: 0.01, WRAP: 0.01, PRINT: 0.01, BAG: 0.01, PACK: 0.01 },
  TRANS_PRICE: 0.05,   // USD per snack (transportation PO)
  DISC: 0.01,          // invoice discount as a fraction (0.01 = 1%)
  // PO form texts (20 entries each for desc/unit/price, same order as PO_LINES in index.html).
  POF: {
    desc: [], unit: [], price: [],
    pay: "Payment terms text",
    trDesc: "Transportation and delivery of school snacks (demo text)",
    trAddr: "Demo delivery area"
  },
  PO_NO_TR: "PO-DEMO-00", PR_NO_TR: "PR-DEMO-00", PR_NO_SNACK: "PR-DEMO-01",
  PROJECT_NO: "DEMO/PROJECT/000",
  DELIVERY_ADDR: "Demo warehouse address",
  SUPPLIER_NAME: "Demo Supplier SAL", SUPPLIER_SHORT: "Demo Supplier",
  SUPPLIER_CONTACT: "Supplier Contact", SUPPLIER_POS: "Owner",
  HAND_SIGNATORY: "Signatory Name", HAND_SIGNATORY_POS: "Executive Director",
  WAREHOUSE_NAME: "Warehouse Monitor", LPH_MANAGER: "Packing House Manager"
};

// Website only (appended to config.js by scripts/build-pages.js). After sign-in,
// supabase-runtime.js stores this account's private settings for this browser tab and
// reloads once, so the page starts with the real prices, CERD map and PO template.
// Nothing private is in this file or in Git.
(() => {
  let data;
  try {
    data = JSON.parse(sessionStorage.getItem("td_private_config_v1") || "null");
  } catch {
    return;
  }
  if (!data || typeof data !== "object") return;
  if (data.config && typeof data.config === "object" && !Array.isArray(data.config)) {
    Object.assign(window.TD_CONFIG, data.config);
  }
  if (typeof data.po_tpl === "string" && data.po_tpl) window.PO_TPL = data.po_tpl;
})();
