// Work environments: choose where an analysis runs, and manage local database copies.
import { node } from "./core.js";

const size = (bytes) =>
  bytes === null || bytes === undefined
    ? "—"
    : bytes > 1e9
      ? `${(bytes / 1e9).toFixed(1)} GB`
      : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
const option = (value, text, selected = false) => {
  const item = new Option(text, value);
  item.selected = selected;
  return item;
};
const labelled = (text, control) => {
  const label = node("label", text);
  label.append(control);
  return label;
};

/** Panel shown when "Analyse with agents" is clicked: environment, branch, database and data access. */
export async function renderAnalysePanel(host, task, { request, onStarted, idempotencyKey, errorLabel }) {
  host.replaceChildren(node("p", "Looking for work environments…", "muted"));
  let data;
  try {
    data = await request(`/api/v1/tasks/${task.taskId}/analyse-options`);
  } catch (error) {
    host.replaceChildren(node("p", `Could not list environments: ${errorLabel(error)}`, "muted"));
    return;
  }
  const panel = node("div", "", "settings-form analyse-panel");
  const environment = document.createElement("select");
  const branch = document.createElement("select");
  const database = document.createElement("select");
  const allowData = Object.assign(document.createElement("input"), { type: "checkbox" });
  const usable = data.environments.filter((env) => env.usable);
  const suggested = data.suggestion?.environmentId;
  environment.append(option("", "No environment (task text only)", !suggested));
  for (const env of usable)
    environment.append(
      option(env.id, `${env.id}${env.id === suggested ? " · suggested" : ""}`, env.id === suggested),
    );
  const sync = () => {
    const env = usable.find((e) => e.id === environment.value);
    branch.replaceChildren(...(env?.branches ?? []).map((b) => option(b, b, b === env.defaultBranch)));
    database.replaceChildren(
      ...(env
        ? [
            ...(env.database.exists
              ? [option(env.database.name, `${env.database.name} · ${size(env.database.sizeBytes)}`, true)]
              : []),
            ...env.scratch.map((d) => option(d.name, `${d.name} · ${size(d.sizeBytes)} · scratch`)),
          ]
        : []),
    );
    branch.disabled = !env;
    allowData.disabled = !env || database.options.length === 0;
    if (allowData.disabled) allowData.checked = false;
    database.disabled = allowData.disabled || !allowData.checked;
  };
  environment.onchange = sync;
  allowData.onchange = sync;
  sync();
  const reason = node(
    "p",
    suggested
      ? `Suggested because: ${data.suggestion.reason}.`
      : `No confident match (${data.suggestion?.reason ?? "no environments"}). Pick the environment you work in.`,
    "muted",
  );
  const status = node("p", "", "muted");
  const start = node("button", "Start analysis", "approve");
  start.type = "button";
  start.onclick = async () => {
    start.disabled = true;
    status.textContent = "Starting analysis…";
    try {
      const body = environment.value
        ? {
            environment: environment.value,
            branch: branch.value,
            allowDataQueries: allowData.checked,
            ...(allowData.checked ? { database: database.value } : {}),
          }
        : {};
      const result = await request(`/api/v1/tasks/${task.taskId}/analyse`, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey(body) },
        body: JSON.stringify(body),
      });
      status.textContent = result.repositoryMapped
        ? `Analysis started on ${environment.value || "the mapped repository"}${result.dataQueries ? " with read-only data access" : ""}.`
        : "Analysis started from the task text only.";
      await onStarted();
    } catch (error) {
      status.textContent = `Analysis did not start: ${errorLabel(error)}`;
      start.disabled = false;
    }
  };
  panel.append(
    labelled("Work environment", environment),
    reason,
    labelled("Branch", branch),
    labelled("Let agents query this database (read-only)", allowData),
    labelled("Database copy", database),
    node(
      "p",
      "Query results (customer data) are sent to Anthropic for this run only. Writes are impossible: queries run in read-only transactions.",
      "muted",
    ),
    start,
    status,
  );
  host.replaceChildren(panel);
}

/** Settings section: environments root, database copies, restores and scratch cleanup. */
export function mountEnvironmentSettings(settingsRoot, { request, errorLabel }) {
  if (document.getElementById("environment-section")) return;
  const section = document.createElement("details");
  section.id = "environment-section";
  section.append(node("summary", "Work environments"));
  const form = node("form", "", "settings-form");
  const root = Object.assign(document.createElement("input"), { required: true });
  const backups = Object.assign(document.createElement("input"), { required: true });
  const script = Object.assign(document.createElement("input"), { required: true });
  const save = node("button", "Save locations", "settings-primary-action");
  save.type = "submit";
  const formStatus = node("p", "", "settings-status");
  form.append(
    labelled("Environments folder", root),
    labelled("Backup downloads folder", backups),
    labelled("Restore script", script),
    save,
    formStatus,
  );
  const list = node("div", "", "environment-list");
  const refresh = node("button", "Rescan environments");
  refresh.type = "button";
  section.append(
    node(
      "p",
      "Environments are discovered as <folder>/odoo-<version>-<customer> with addons/ (git) and odoo/.odoorc. Nothing needs registering.",
      "muted",
    ),
    form,
    refresh,
    list,
  );
  settingsRoot.append(section);

  const load = async (force = false) => {
    list.replaceChildren(node("p", "Scanning…", "muted"));
    try {
      const data = await request(`/api/v1/environments${force ? "?refresh=1" : ""}`);
      root.value = data.settings.root;
      backups.value = data.settings.backupDir;
      script.value = data.settings.restoreScript;
      list.replaceChildren(...data.environments.map(renderEnvironment));
      if (!data.environments.length) list.append(node("p", "No environments found in this folder.", "muted"));
    } catch (error) {
      list.replaceChildren(node("p", errorLabel(error), "muted"));
    }
  };
  const renderEnvironment = (env) => {
    const item = document.createElement("details");
    item.className = "environment-item";
    item.append(
      node(
        "summary",
        `${env.id} · ${env.defaultBranch ?? "no branch"} · ${env.database.exists ? `${env.database.name} (${size(env.database.sizeBytes)})` : "no database copy"}${env.scratch.length ? ` · ${env.scratch.length} scratch` : ""}${env.issues.length ? ` · ⚠ ${env.issues.join(", ")}` : ""}`,
      ),
    );
    item.ontoggle = () => {
      if (item.open && item.children.length === 1) renderDetail(item, env);
    };
    return item;
  };
  const renderDetail = async (item, env) => {
    const body = node("div", "", "environment-detail");
    const loading = node("p", "Loading backups…", "muted");
    body.append(loading);
    item.append(body);
    // Restore from a backup zip.
    const zip = document.createElement("select");
    const target = Object.assign(document.createElement("input"), { value: env.database.name });
    const confirm = Object.assign(document.createElement("input"), {
      placeholder: "Type the database name to confirm",
    });
    const restore = node("button", "Restore backup (drops and recreates the database)", "reject");
    restore.type = "button";
    const log = node("pre", "", "environment-log");
    log.hidden = true;
    try {
      const files = (await request(`/api/v1/environments/${env.id}/backups`)).items;
      zip.replaceChildren(
        ...files.map((f) =>
          option(f.path, `${f.name} · ${size(f.sizeBytes)} · ${f.modifiedAt.slice(0, 10)}`),
        ),
      );
      if (!files.length) zip.append(option("", "No .zip backups in the downloads folder"));
    } catch (error) {
      zip.replaceChildren(option("", errorLabel(error)));
    }
    const syncRestore = () => {
      restore.disabled = !zip.value || !target.value || confirm.value !== target.value || !env.odoo;
    };
    for (const input of [zip, target, confirm]) input.oninput = input.onchange = syncRestore;
    syncRestore();
    restore.onclick = async () => {
      restore.disabled = true;
      log.hidden = false;
      log.textContent = "Starting restore…";
      try {
        let job = await request(`/api/v1/environments/${env.id}/restore`, {
          method: "POST",
          body: JSON.stringify({ zipPath: zip.value, database: target.value, confirm: confirm.value }),
        });
        while (job.state === "RUNNING") {
          log.textContent = job.log.join("\n") || "Restoring…";
          await new Promise((resolve) => setTimeout(resolve, 2000));
          job = await request(`/api/v1/jobs/${job.id}`);
        }
        log.textContent = `${job.log.join("\n")}\n\n${job.state === "SUCCEEDED" ? "Restore finished." : `Restore failed (exit ${job.exitCode}).`}`;
        await load(true);
      } catch (error) {
        log.textContent = `Restore did not start: ${errorLabel(error)}`;
        syncRestore();
      }
    };
    loading.remove();
    body.append(
      node("strong", "Restore a local copy from an odoo.sh backup"),
      labelled("Backup .zip", zip),
      labelled("Database name (main copy, or a codex_/claude_/oda_ scratch name)", target),
      labelled("Confirm", confirm),
      restore,
      log,
    );
    // Scratch databases.
    if (env.scratch.length) {
      body.append(node("strong", "Scratch copies"));
      for (const db of env.scratch) {
        const row = node("div", "", "environment-scratch");
        const typed = Object.assign(document.createElement("input"), {
          placeholder: `Type ${db.name} to delete`,
        });
        const drop = node("button", "Delete", "reject");
        drop.type = "button";
        drop.disabled = true;
        typed.oninput = () => (drop.disabled = typed.value !== db.name);
        drop.onclick = async () => {
          drop.disabled = true;
          try {
            await request(`/api/v1/environments/${env.id}/databases/${encodeURIComponent(db.name)}/drop`, {
              method: "POST",
              body: JSON.stringify({ confirm: typed.value }),
            });
            row.replaceChildren(node("span", `${db.name} deleted.`, "muted"));
          } catch (error) {
            row.append(node("span", errorLabel(error), "muted"));
          }
        };
        row.append(node("span", `${db.name} · ${size(db.sizeBytes)}`), typed, drop);
        body.append(row);
      }
    }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    formStatus.textContent = "Saving…";
    try {
      await request("/api/v1/environments/settings", {
        method: "POST",
        body: JSON.stringify({
          root: root.value.trim(),
          backupDir: backups.value.trim(),
          restoreScript: script.value.trim(),
        }),
      });
      formStatus.textContent = "Saved.";
      await load(true);
    } catch (error) {
      formStatus.textContent = errorLabel(error);
    }
  };
  refresh.onclick = () => load(true);
  section.ontoggle = () => {
    if (section.open && !list.childElementCount) void load();
  };
}
