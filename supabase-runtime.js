(() => {
  "use strict";
  const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.98.0/+esm";

  function unwrap(result) {
    if (result.error) throw result.error;
    return result.data;
  }

  function createDatabase(client) {
    const refreshers = new Map();
    const channel = client.channel("td-document-changes")
      .on("postgres_changes", { schema: "public", table: "td_changes", event: "UPDATE" },
        ({ new: row }) => refreshers.get(row.collection)?.())
      .subscribe(status => {
        if (status === "SUBSCRIBED") refreshers.forEach(refresh => refresh());
      });

    // A periodic reconciliation covers missed events and disconnected sockets.
    const poll = setInterval(() => refreshers.forEach(refresh => refresh()), 60000);
    window.addEventListener("pagehide", event => {
      if (event.persisted) return;
      clearInterval(poll);
      client.removeChannel(channel);
    });
    window.addEventListener("online", () => refreshers.forEach(refresh => refresh()));

    const rpc = async (name, args) => unwrap(await client.rpc(name, args));
    return {
      async patchWaybill(date, school, changes) {
        try {
          await rpc("td_patch_waybill", { day_id: date, school_id: school, changes });
        } finally {
          refreshers.get("waybills")?.();
        }
      },
      async patchHygiene(date, defaults, changes) {
        try {
          await rpc("td_patch_hygiene", { day_id: date, defaults, changes });
        } finally {
          refreshers.get("hygiene")?.();
        }
      },
      async saveQc(date, changes, expectedTarget, sourceId, expectedSource) {
        const payload = record => {
          if (!record) return null;
          const { _id, ...data } = record;
          return data;
        };
        try {
          await rpc("td_save_qc", {
            target_id: date, changes, expected_target: payload(expectedTarget),
            source_id: sourceId || null, expected_source: payload(expectedSource)
          });
        } finally {
          refreshers.get("qc")?.();
        }
      },
      collection(name) {
        const table = () => client.from(name);
        const write = async query => {
          try {
            return unwrap(await query);
          } finally {
            refreshers.get(name)?.();
          }
        };

        return {
          onSnapshot(callback, onError) {
            let active = true;
            let loading = false;
            let queued = false;
            let cursor;
            let initialized = false;
            const documents = new Map();
            let changed = false;
            async function refresh() {
              if (loading) {
                queued = true;
                return;
              }
              loading = true;
              try {
                while (active) {
                  const rows = await rpc("td_document_delta", {
                    collection_name: name, after_at: cursor?.changed_at ?? null, after_id: cursor?.id ?? ""
                  });
                  if (!active) return;
                  for (const row of rows) {
                    if (row.deleted) changed = documents.delete(row.id) || changed;
                    else {
                      documents.set(row.id, row.payload);
                      changed = true;
                    }
                    cursor = row;
                  }
                  if (rows.length < 200) break;
                }
                if (active && (changed || !initialized) && !queued) {
                  changed = false;
                  initialized = true;
                  const docs = [...documents].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                    .map(([id, payload]) => ({ id, data: () => structuredClone(payload) }));
                  callback({ docs });
                }
              } catch (error) {
                if (active) onError?.(error);
              } finally {
                loading = false;
                if (active && queued) {
                  queued = false;
                  refresh();
                }
              }
            }
            refreshers.set(name, refresh);
            refresh();
            return () => {
              active = false;
              if (refreshers.get(name) === refresh) refreshers.delete(name);
            };
          },
          async add(payload) {
            const id = crypto.randomUUID();
            await write(table().insert({ id, payload }));
            return { id };
          },
          doc(id) {
            return {
              set: payload => write(table().upsert({ id, payload })),
              async update(changes) {
                const current = unwrap(await table().select("payload").eq("id", id).single());
                // Compare the document used to build the update to avoid lost edits.
                const saved = await write(table().update({ payload: { ...current.payload, ...changes } })
                  .eq("id", id).eq("payload", JSON.stringify(current.payload)).select("id").maybeSingle());
                if (!saved) throw new Error("Record changed or access was denied. Try again.");
              },
              async delete() {
                const removed = await write(table().delete().eq("id", id).select("id").maybeSingle());
                if (!removed) throw new Error("Record already removed or access was denied.");
              }
            };
          }
        };
      }
    };
  }

  function requestLogin(client, view) {
    const form = document.createElement("form");
    form.className = "card";
    form.innerHTML = `
      <h2>Sign in to Taanayel Desk</h2>
      <label class="fl">Email<input name="email" type="email" autocomplete="username" required></label>
      <label class="fl">Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit" class="btn">Sign in</button>
      <p role="status"></p>
    `;
    view.replaceChildren(form);
    const button = form.querySelector("button");
    const status = form.querySelector("[role=status]");
    form.addEventListener("submit", async event => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      status.textContent = "";
      try {
        unwrap(await client.auth.signInWithPassword({
          email: form.elements.email.value.trim(), password: form.elements.password.value
        }));
        location.reload();
      } catch {
        form.elements.password.value = "";
        status.textContent = "Sign-in failed. Check your email and password and try again.";
        button.disabled = false;
      }
    });
  }

  const pagesSignature = pages => JSON.stringify(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));

  function watchRole(client, view, role, pages) {
    let pending = false;
    let retryOnReconnect = false;
    async function check() {
      if (pending || document.hidden) return;
      pending = true;
      let accessChanged = false;
      try {
        const result = await client.rpc("td_role");
        if (result.error) {
          // The RPC response carries HTTP status separately from the database error.
          accessChanged = result.status === 401 || result.status === 403 ||
            result.error.code === "42501";
        } else {
          accessChanged = result.data !== role;
          if (!accessChanged && pages) {
            const access = await client.rpc("td_my_pages");
            accessChanged = access.error
              ? access.status === 401 || access.status === 403 || access.error.code === "42501"
              : pagesSignature(access.data || {}) !== pagesSignature(pages);
          }
        }
      } catch {
        // Transport failures leave the current view and unsaved input intact.
      } finally {
        pending = false;
      }
      if (accessChanged) {
        view.closest("main").hidden = true;
        document.querySelector("header").hidden = true;
        forgetPrivateConfig();
        location.reload();
      } else if (retryOnReconnect) {
        retryOnReconnect = false;
        check();
      }
    }

    const timer = setInterval(check, 60000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("online", () => {
      if (pending) retryOnReconnect = true;
      else check();
    });
    window.addEventListener("pageshow", event => {
      if (event.persisted) check();
    });
    window.addEventListener("pagehide", event => {
      if (!event.persisted) clearInterval(timer);
    });
  }

  function saveDownload({ filename, data }) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const PRIVATE_KEY = "td_private_config_v1";
  function forgetPrivateConfig() {
    try { sessionStorage.removeItem(PRIVATE_KEY); } catch {}
  }

  // Returns true when the page must reload to start with this account's private settings.
  async function syncPrivateConfig(client) {
    const { data, error } = await client.rpc("td_private_config");
    if (error || !data || typeof data !== "object") return false;
    const next = JSON.stringify(data);
    try {
      if (sessionStorage.getItem(PRIVATE_KEY) === next) return false;
      sessionStorage.setItem(PRIVATE_KEY, next);
    } catch {
      return false; // Storage blocked: the page keeps the placeholders instead of reloading forever.
    }
    return true;
  }

  window.TDStandalone = async view => {
    const config = window.TD_SUPABASE || {};
    if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(config.url || "") ||
        !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey || "")) {
      view.textContent = "Set the Supabase project URL and publishable key.";
      return null;
    }

    const { createClient } = await import(SDK);
    const client = createClient(config.url, config.publishableKey, {
      auth: { detectSessionInUrl: false }
    });
    const { session } = unwrap(await client.auth.getSession());
    if (!session) {
      forgetPrivateConfig();
      requestLogin(client, view);
      return null;
    }

    const signOut = document.createElement("button");
    signOut.type = "button";
    signOut.className = "btn ghost";
    signOut.textContent = "Sign out";
    const account = document.createElement("footer");
    account.className = "wrap";
    account.append(signOut);
    view.closest("main").after(account);
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    account.append(status);
    signOut.addEventListener("click", async () => {
      signOut.disabled = true;
      try {
        unwrap(await client.auth.signOut({ scope: "local" }));
        forgetPrivateConfig();
        location.reload();
      } catch {
        status.textContent = " Sign-out failed. Try again.";
        signOut.disabled = false;
      }
    });

    // Hide cached application data when this browser session signs out.
    client.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") {
        forgetPrivateConfig();
        location.reload();
      }
    });

    const role = unwrap(await client.rpc("td_role"));
    if (!["full", "viewer", "waybill_writer"].includes(role)) {
      view.textContent = "This account has no desk role. Ask the project administrator for access.";
      forgetPrivateConfig();
      return null;
    }
    const pageResult = await client.rpc("td_my_pages");
    const pages = pageResult.error?.code === "PGRST202" ? null : unwrap(pageResult);
    if (await syncPrivateConfig(client)) {
      view.textContent = "Loading your settings…";
      location.reload();
      return null;
    }

    const { createPrivateAttachments } = await import("./private-attachments.js");
    const privateFiles = createPrivateAttachments(client, config, role, session.user?.id, pages);
    if (role === "full") {
      // Setup tools stay behind one Settings button; daily actions stay visible.
      const settings = document.createElement("button");
      settings.type = "button";
      settings.className = "btn ghost";
      settings.textContent = "Settings";
      settings.setAttribute("aria-expanded", "false");
      const panel = document.createElement("div");
      panel.style.cssText = "flex-basis:100%;display:none;flex-wrap:wrap;gap:inherit";
      settings.onclick = () => {
        const open = panel.style.display === "none";
        panel.style.display = open ? "flex" : "none";
        settings.setAttribute("aria-expanded", String(open));
      };
      const monitorLinks = document.createElement("button");
      monitorLinks.type = "button";
      monitorLinks.className = "btn ghost";
      monitorLinks.textContent = "Area Monitor links";
      panel.append(monitorLinks);
      monitorLinks.onclick = async () => {
        monitorLinks.disabled = true;
        try {
          const { openAreaMonitorLinks } = await import("./am-links-admin.js");
          await openAreaMonitorLinks(client);
        } catch {
          status.textContent = " Could not open Area Monitor links. Try again.";
        } finally {
          monitorLinks.disabled = false;
        }
      };
      if (pages) {
        const { mountStaffAccess } = await import("./staff-access.js");
        mountStaffAccess(panel, client);
      }
      if (pages && ["view","edit"].includes(pages.wb)) {
        const tracker = document.createElement("button");
        tracker.type = "button";
        tracker.className = "btn ghost";
        tracker.textContent = "Tracker sync";
        panel.append(tracker);
        tracker.onclick = async () => {
          const { openTrackerSync } = await import("./tracker-sync.js");
          await openTrackerSync(client, pages.wb === "edit");
        };
      }
      const smets = document.createElement("button");
      smets.type = "button";
      smets.className = "btn ghost";
      smets.textContent = "SMeTS button";
      panel.append(smets);
      smets.onclick = async () => {
        smets.disabled = true;
        try {
          const { openSmetsButton } = await import("./smets-admin.js");
          await openSmetsButton(client, config, !pages || pages.wb === "edit");
        } catch {
          status.textContent = " Could not open the SMeTS button settings.";
        } finally {
          smets.disabled = false;
        }
      };
      if (!pages || pages.wb === "edit") {
        const { mountOrderExcel } = await import("./order-excel.js");
        mountOrderExcel(account, client);
      }
      account.append(settings, panel);
    }
    const { createWaybillScanner } = await import("./waybill-scanner.js");
    watchRole(client, view, role, pages);
    return {
      db: createDatabase(client),
      privateFiles, pages,
      smartScanner: (pages ? pages.wb === "edit" : role !== "viewer") ? createWaybillScanner(client, privateFiles) : null,
      downloads: { save: saveDownload },
      full: role === "full",
      canWb: pages ? pages.wb === "edit" : role !== "viewer"
    };
  };
})();
