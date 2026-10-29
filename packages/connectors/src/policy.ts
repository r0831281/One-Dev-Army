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
const ODOO_METHOD = "search_read";

interface JsonRpcCall {
  jsonrpc?: unknown;
  method?: unknown;
  params?: { service?: unknown; method?: unknown; args?: unknown };
}

function isOdooLogin(params: JsonRpcCall["params"]): boolean {
  return params?.service === "common" && params.method === "login" && Array.isArray(params.args);
}
function isOdooTaskRead(params: JsonRpcCall["params"]): boolean {
  return (
    params?.service === "object" &&
    params.method === "execute_kw" &&
    Array.isArray(params.args) &&
    params.args[3] === ODOO_MODEL &&
    params.args[4] === ODOO_METHOD
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
    if (url.pathname !== `/json/2/${ODOO_MODEL}/${ODOO_METHOD}`) throw new Error("CONNECTOR_SCOPE_DENIED");
    return;
  }
  const call = request.body as JsonRpcCall | undefined;
  if (
    url.pathname !== "/jsonrpc" ||
    call?.method !== "call" ||
    !(isOdooLogin(call.params) || isOdooTaskRead(call.params))
  )
    throw new Error("CONNECTOR_SCOPE_DENIED");
}

/** Writes the API key into the password position of an allowed Odoo JSON-RPC call. */
export function withOdooRpcCredential(body: unknown, key: string): unknown {
  const call = structuredClone(body) as JsonRpcCall & { params: { args: unknown[] } };
  if (!isOdooLogin(call.params) && !isOdooTaskRead(call.params)) throw new Error("CONNECTOR_SCOPE_DENIED");
  call.params.args[2] = key;
  return call;
}
