// Read-only request policy for in-process connectors. Every outbound connector request passes through
// assertConnectorRequest before any credential is attached, so a connector bug cannot widen its own scope.

export type ConnectorScope =
  | { kind: "get"; origin: string }
  | { kind: "odoo-json2"; origin: string }
  | { kind: "odoo-jsonrpc"; origin: string };

export interface ConnectorRequest {
  method: string;
  url: string;
  body?: unknown;
}

const ODOO_MODEL = "project.task";
const ODOO_MESSAGE_MODEL = "mail.message";
const ODOO_ATTACHMENT_MODEL = "ir.attachment";
const ODOO_METHOD = "search_read";

/**
 * Chatter and attachment reads must start with the clauses that pin them to a single task, so no other record's
 * messages or files can be listed.
 */
function isPinnedToTask(domain: unknown, modelField: string, idField: string): boolean {
  if (!Array.isArray(domain)) return false;
  const [model, record] = domain as unknown[][];
  return (
    Array.isArray(model) &&
    model.length === 3 &&
    model[0] === modelField &&
    model[1] === "=" &&
    model[2] === ODOO_MODEL &&
    Array.isArray(record) &&
    record.length === 3 &&
    record[0] === idField &&
    record[1] === "=" &&
    Number.isSafeInteger(record[2]) &&
    (record[2] as number) > 0
  );
}
function isOdooRead(model: unknown, domain: unknown): boolean {
  return (
    model === ODOO_MODEL ||
    (model === ODOO_MESSAGE_MODEL && isPinnedToTask(domain, "model", "res_id")) ||
    (model === ODOO_ATTACHMENT_MODEL && isPinnedToTask(domain, "res_model", "res_id"))
  );
}

interface JsonRpcCall {
  jsonrpc?: unknown;
  method?: unknown;
  params?: { service?: unknown; method?: unknown; args?: unknown };
}

function isOdooLogin(params: JsonRpcCall["params"]): boolean {
  return params?.service === "common" && params.method === "login" && Array.isArray(params.args);
}
function isOdooReadCall(params: JsonRpcCall["params"]): boolean {
  return (
    params?.service === "object" &&
    params.method === "execute_kw" &&
    Array.isArray(params.args) &&
    params.args[4] === ODOO_METHOD &&
    isOdooRead(params.args[3], (params.args[5] as unknown[] | undefined)?.[0])
  );
}

export function assertConnectorRequest(scope: ConnectorScope, request: ConnectorRequest): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("CONNECTOR_SCOPE_DENIED");
  }
  if (url.origin !== scope.origin || url.username || url.password) throw new Error("CONNECTOR_SCOPE_DENIED");
  if (scope.kind === "get") {
    if (request.method !== "GET" || request.body !== undefined) throw new Error("CONNECTOR_SCOPE_DENIED");
    return;
  }
  if (request.method !== "POST" || url.search || url.hash) throw new Error("CONNECTOR_SCOPE_DENIED");
  if (scope.kind === "odoo-json2") {
    const match = /^\/json\/2\/([a-z_.]+)\/([a-z_]+)$/.exec(url.pathname);
    if (
      match?.[2] !== ODOO_METHOD ||
      !isOdooRead(match[1], (request.body as { domain?: unknown } | undefined)?.domain)
    )
      throw new Error("CONNECTOR_SCOPE_DENIED");
    return;
  }
  const call = request.body as JsonRpcCall | undefined;
  if (
    url.pathname !== "/jsonrpc" ||
    call?.method !== "call" ||
    !(isOdooLogin(call.params) || isOdooReadCall(call.params))
  )
    throw new Error("CONNECTOR_SCOPE_DENIED");
}

/** Writes the API key into the password position of an allowed Odoo JSON-RPC call. */
export function withOdooRpcCredential(body: unknown, key: string): unknown {
  const call = structuredClone(body) as JsonRpcCall & { params: { args: unknown[] } };
  if (!isOdooLogin(call.params) && !isOdooReadCall(call.params)) throw new Error("CONNECTOR_SCOPE_DENIED");
  call.params.args[2] = key;
  return call;
}
