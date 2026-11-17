import type { Db } from "@paperclipai/db";
import { eq, or } from "drizzle-orm";
import { agents, approvals, heartbeatRuns, issueComments, issues, projects } from "@paperclipai/db";
import type { ToolAccessDecision, ToolAccessDecisionInput } from "@paperclipai/shared";

declare const autoReviewedBrand: unique symbol;
export type ReviewedToolAccessDecision = ToolAccessDecision & {
  [autoReviewedBrand]: true;
};

export function asReviewedDecision(decision: ToolAccessDecision): ReviewedToolAccessDecision {
  return decision as unknown as ReviewedToolAccessDecision;
}

export type FloorClass =
  | "delete_agent"
  | "approval_rules"
  | "access_secrets"
  | "spend"
  | "publishing"
  | "unguarded_sql"
  | "cross_company"
  | "unknown";

export type FloorMatch = {
  floorClass: FloorClass;
  detail: string;
};

export type FloorTargetResolution =
  | { kind: "same_company"; companyId: string }
  | { kind: "other_company"; companyId: string }
  | { kind: "unresolved" }
  | { kind: "not_applicable" };

export type FloorProbe = {
  toolName: string;
  upstreamToolName: string | null;
  providerType: string | null;
  riskLevel: string | null;
  args: unknown;
  sessionCompanyId: string;
  target: FloorTargetResolution;
};

export type BoardApiRequest = {
  method: string;
  path: string;
  raw: string;
  body: unknown;
};

export type SqlStatement = {
  text: string;
  verb: string | null;
};

export type SqlProbe = {
  statements: SqlStatement[];
  expectedRowCount: number | null;
  writeTool: boolean;
};

const BOARD_API_TOOL_RE = /^board_api_(read|write)$/;
const DB_WRITE_TOOL_RE = /(^|_)db_write$/;
const DB_TOOL_RE = /(^|_)db_(query|write)$/;
const AGENT_CONFIG_TOOLS = new Set([
  "update_agent_config",
  "get_agent_config",
  "pause_agent",
  "resume_agent",
  "delete_agent",
  "clear_agent_error",
]);
const BOARD_API_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);
const SQL_MODIFYING_CTE_RE = /\bas\s*\(\s*(insert|update|delete)\b/i;
const SQL_TRAILING_WRITE_RE = /\)\s*(insert|update|delete)\b/i;
const SQL_READ_VERBS = new Set(["select", "explain", "show", "table", "values"]);
const SQL_FIRST_VERB_RE =
  /^\s*\(?\s*(with|select|insert|update|delete|truncate|drop|alter|create|grant|revoke|comment|vacuum|reindex|call|do|begin|commit|explain|show|table|values|set|reset|listen|notify|unlisten|declare|fetch|move|copy|import|analyze|cluster|lock|checkpoint|discard|refresh|prepare|execute|deallocate)/i;
const FLOOR_TABLE_CLASSES: Record<string, FloorClass> = {
  approvals: "approval_rules",
  issue_approvals: "approval_rules",
  tool_policies: "approval_rules",
  tool_trust_rules: "approval_rules",
  tool_policy_revisions: "approval_rules",
  secrets: "access_secrets",
  permissions: "access_secrets",
  company_memberships: "access_secrets",
  memberships: "access_secrets",
  budgets: "spend",
  billing: "spend",
  api_keys: "spend",
  subscriptions: "spend",
  payments: "spend",
};
const SQL_SECRET_RE =
  /adapter_config|->>?\s*'?"?\s*env\b|\b(secrets?|credentials?|passwords?|api_?keys?|tokens?|auth_?tokens?|private_?keys?)\b/i;
const TIER_MODEL_RE = /^(modelgate\/)?(light|fast|fast-instruct|heavy|heavy-alt)$/i;
const DELETE_AGENT_TOOL_RE = /(^|_)(delete|remove|destroy)_agent(s)?($|_)/;
const OWNER_OVERRIDE_TOOLS = new Set(["owner_override_write", "owner_override"]);
const PUBLISHING_ANY_PROVIDER_TOKEN_RE = /(^|_)(merge_pull_request|merge_pr|create_release|publish_package|deploy_|send_email|send_mail|mail|email|post_tweet|tweet|announce|post)($|_)/;
const INTERNAL_PROVIDER_RE = /^paperclip_(self|plugin|virtual|gateway|board)/;
const PUBLISHING_INTERNAL_TOKEN_RE = /(^|_)(merge_pull_request|merge_pr|publish|release|deploy)($|_)/;
const PUBLISHING_PROVIDER_RE = /(npm|app_?store|github|gitlab|bitbucket|registry|vercel|netlify|fly_?io|render|heroku)/i;
const PUBLISHING_PROVIDER_TOKEN_RE = /(^|_)(merge|merge_pull_request|merge_pr|create_release|publish|publish_package|release|deploy)($|_)/;
const COMMUNICATION_PROVIDER_RE = /(^|[-_.])(gmail|smtp|mail|slack|twitter|sms|twilio|messenger|telegram|discord)/i;
const APPROVAL_RULES_SEGMENTS = new Set(["approvals", "trust-rules", "trust_rules", "owner-override", "owner_override"]);
const ACCESS_SEGMENT_RE = /^\/(permissions|members|memberships|grants|connections|secrets|env)$/;
const SPEND_SEGMENT_RE = /^\/(budgets?|billing|subscriptions|api-keys|apikeys|keys|credentials|payments?|invoices|spend)$/;
const STRING_ADAPTER_ENV_RE = /adapter[_-]?config[^,;}]*(\benv\b|->>?\s*'?"?env)/i;
const STRING_ADAPTER_MODEL_RE = /adapter[_-]?config[^}]*?model\s*[:=]\s*['"]([^'"]+)['"]/i;
const EXPECTED_ROW_COUNT_RE = /expected[_ ]?row[_ ]?count\s*[:=]?\s*(\d+)/i;

export function normalizeFloorPath(rawPath: string): { segments: string[]; companyIdInPath: string | null } {
  let path = rawPath.trim();
  const queryIndex = path.search(/[?#]/);
  if (queryIndex >= 0) path = path.slice(0, queryIndex);
  let decoded = path;
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  const collapsed = decoded.replace(/\\+/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  const parts = collapsed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const resolved: string[] = [];
  for (const segment of parts) {
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  if (resolved.length > 0 && /^[a-z][a-z0-9+.-]*:$/.test(resolved[0])) resolved.splice(0, 2);
  while (resolved.length > 0 && resolved[0] === "api") resolved.shift();
  let companyIdInPath: string | null = null;
  if (resolved[0] === "companies" && resolved.length > 1) {
    companyIdInPath = resolved[1];
    resolved.splice(0, 2);
  }
  return { segments: resolved, companyIdInPath };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function parseBoardApiRequest(args: unknown): BoardApiRequest | null {
  if (typeof args === "string") {
    const trimmed = args.trim();
    const match = /^([a-zA-Z]+)\s+(\S+)/.exec(trimmed);
    if (match && BOARD_API_METHODS.has(match[1].toLowerCase())) {
      return { method: match[1].toLowerCase(), path: match[2], raw: trimmed, body: trimmed };
    }
    return null;
  }
  if (isRecord(args)) {
    const methodValue = [args.method, args.httpMethod, args.verb].find((value) => typeof value === "string");
    const pathValue = [args.path, args.url, args.endpoint, args.route, args.uri].find((value) => typeof value === "string");
    if (typeof methodValue === "string" && typeof pathValue === "string" && BOARD_API_METHODS.has(methodValue.toLowerCase())) {
      return {
        method: methodValue.toLowerCase(),
        path: pathValue,
        raw: `${methodValue.toUpperCase()} ${pathValue}`,
        body: args.body ?? args.data ?? args.payload ?? args,
      };
    }
    const nested = [args.request, args.call, args.command].find((value) => typeof value === "string");
    if (typeof nested === "string") return parseBoardApiRequest(nested);
    return null;
  }
  return null;
}

export function parseSqlProbe(args: unknown, writeTool: boolean): SqlProbe | null {
  let sqlText: string | null = null;
  let expectedRowCount: number | null = null;
  if (typeof args === "string") {
    sqlText = args;
  } else if (isRecord(args)) {
    const value = [args.sql, args.query, args.statement, args.statements, args.text].find(
      (candidate) => typeof candidate === "string",
    );
    if (typeof value === "string") sqlText = value;
    const count = args.expectedRowCount ?? args.expected_row_count ?? args.rowCount;
    if (typeof count === "number" && Number.isFinite(count)) expectedRowCount = count;
    if (sqlText === null && Array.isArray(args.statements) && args.statements.every((entry) => typeof entry === "string")) {
      sqlText = (args.statements as string[]).join(";\n");
    }
  }
  if (sqlText === null) return null;
  const directive = EXPECTED_ROW_COUNT_RE.exec(sqlText);
  if (directive) expectedRowCount = expectedRowCount ?? Number(directive[1]);
  const cleaned = sqlText.replace(/[,;\s]*expected[_ ]?row[_ ]?count\s*[:=]?\s*\d+\s*$/i, "").trim();
  return { statements: splitSqlStatements(cleaned), expectedRowCount, writeTool };
}

function splitSqlStatements(sqlText: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  const push = () => {
    const text = current.trim();
    if (text.length > 0) statements.push({ text, verb: statementVerb(text) });
    current = "";
  };
  for (let i = 0; i < sqlText.length; i += 1) {
    const char = sqlText[i];
    const next = sqlText[i + 1];
    if (dollarTag !== null) {
      current += char;
      if (sqlText.startsWith(dollarTag, i)) {
        current += dollarTag.slice(1);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingleQuote) {
      current += char;
      if (char === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else inSingleQuote = false;
      }
      continue;
    }
    if (inDoubleQuote) {
      current += char;
      if (char === '"') inDoubleQuote = false;
      continue;
    }
    if (char === "-" && next === "-") {
      current += char + next;
      i += 1;
      inLineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += char + next;
      i += 1;
      inBlockComment = true;
      continue;
    }
    if (char === "'") {
      current += char;
      inSingleQuote = true;
      continue;
    }
    if (char === '"') {
      current += char;
      inDoubleQuote = true;
      continue;
    }
    if (char === "$") {
      const tag = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sqlText.slice(i));
      if (tag) {
        current += tag[0];
        i += tag[0].length - 1;
        dollarTag = tag[0];
        continue;
      }
    }
    if (char === ";") {
      push();
      continue;
    }
    current += char;
  }
  push();
  return statements;
}

function statementVerb(statement: string): string | null {
  const match = SQL_FIRST_VERB_RE.exec(statement);
  return match ? match[1].toLowerCase() : null;
}

function statementIsRead(statement: SqlStatement): boolean {
  if (statement.verb === "with") {
    if (SQL_MODIFYING_CTE_RE.test(statement.text)) return false;
    return /\)\s*select\b/i.test(statement.text) && !SQL_TRAILING_WRITE_RE.test(statement.text);
  }
  return statement.verb !== null && SQL_READ_VERBS.has(statement.verb);
}

export function sqlTableNames(statement: string): string[] {
  const tables = new Set<string>();
  const pattern =
    /\b(?:from|join|into|update|truncate(?:\s+table)?|table|alter\s+table)\s+(?:only\s+)?([a-zA-Z_"'][a-zA-Z0-9_."']*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(statement)) !== null) {
    const identifier = match[1].replace(/["']/g, "");
    const parts = identifier.split(".");
    tables.add(parts[parts.length - 1].toLowerCase());
  }
  return [...tables];
}

function whereClauseOf(statement: string): string | null {
  const match = /\bwhere\b([\s\S]*)$/i.exec(statement);
  return match ? match[1] : null;
}

function statementHasRowGuard(statement: string, expectedRowCount: number | null): boolean {
  if (expectedRowCount !== null) return true;
  const where = whereClauseOf(statement);
  if (!where) return false;
  if (/\bid\b\s*(?:=|in\s*\()/i.test(where)) return true;
  if (/\breturning\b/i.test(statement) && /\bid\b/i.test(statement)) return true;
  return false;
}

function isExternalProvider(providerType: string | null): boolean {
  if (!providerType) return true;
  return !INTERNAL_PROVIDER_RE.test(providerType);
}

function hasPathSequence(segments: string[], first: string, second: string): boolean {
  return segments.some((segment, index) => segment === first && segments[index + 1] === second);
}

function hasSegment(segments: string[], test: (segment: string) => boolean): boolean {
  return segments.some((segment) => test(`/${segment}`));
}

function agentConfigDelta(args: unknown): { model?: unknown; env?: unknown } | null {
  if (!isRecord(args)) return null;
  const adapterConfig = isRecord(args.adapterConfig)
    ? args.adapterConfig
    : isRecord(args.config)
      ? args.config
      : null;
  if (!adapterConfig) return null;
  const delta: { model?: unknown; env?: unknown } = {};
  if ("model" in adapterConfig) delta.model = adapterConfig.model;
  if ("env" in adapterConfig) delta.env = adapterConfig.env;
  return Object.keys(delta).length > 0 ? delta : null;
}

function stringFormAdapterFindings(raw: string): { env: boolean; model: string | null } {
  return {
    env: STRING_ADAPTER_ENV_RE.test(raw),
    model: STRING_ADAPTER_MODEL_RE.exec(raw)?.[1] ?? null,
  };
}

export function matchFloor(probe: FloorProbe): FloorMatch[] {
  const matches: FloorMatch[] = [];
  const nameCandidates = [probe.toolName, probe.upstreamToolName].filter((value): value is string => Boolean(value));
  const lowerNames = nameCandidates.map((value) => value.toLowerCase());
  const tokenNames = nameCandidates.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
  const args = probe.args;
  const writeRisk = probe.riskLevel === "write" || probe.riskLevel === "destructive";
  const boardApi = BOARD_API_TOOL_RE.test(probe.toolName) || BOARD_API_TOOL_RE.test(probe.upstreamToolName ?? "");
  const dbTool = DB_TOOL_RE.test(probe.toolName) || DB_TOOL_RE.test(probe.upstreamToolName ?? "");
  const dbWriteTool = DB_WRITE_TOOL_RE.test(probe.toolName) || DB_WRITE_TOOL_RE.test(probe.upstreamToolName ?? "");
  const agentConfigTool = AGENT_CONFIG_TOOLS.has(probe.toolName) || AGENT_CONFIG_TOOLS.has(probe.upstreamToolName ?? "");
  const agentConfigWriteTool = agentConfigTool && probe.toolName !== "get_agent_config" && (probe.upstreamToolName ?? "") !== "get_agent_config";

  if (tokenNames.some((name) => DELETE_AGENT_TOOL_RE.test(name))) {
    matches.push({ floorClass: "delete_agent", detail: `tool ${probe.toolName} deletes an agent` });
  }

  const boardRequest = boardApi ? parseBoardApiRequest(args) : null;
  if (boardApi && boardRequest === null) {
    matches.push({
      floorClass: "unknown",
      detail: "board API tool arguments are not a recognizable METHOD + path request",
    });
  }
  const normalized = boardRequest ? normalizeFloorPath(boardRequest.path) : null;
  const segments = normalized?.segments ?? [];
  const writeMethod = boardRequest ? WRITE_METHODS.has(boardRequest.method) : writeRisk;
  const methodLabel = boardRequest ? boardRequest.method.toUpperCase() : "WRITE";

  if (boardRequest && writeMethod && boardRequest.method === "delete" &&
    (segments[0] === "agents" || segments[0] === "companies" || (normalized?.companyIdInPath !== null && segments.length === 0))) {
    matches.push({ floorClass: "delete_agent", detail: `DELETE /api/${segments.join("/")}` });
  }

  if (nameCandidates.some((name) => OWNER_OVERRIDE_TOOLS.has(name))) {
    matches.push({ floorClass: "approval_rules", detail: `tool ${probe.toolName} edits approval rules` });
  }
  if (boardRequest && writeMethod) {
    const approvalPath =
      hasSegment(segments, (token) => APPROVAL_RULES_SEGMENTS.has(token.replace(/^\//, ""))) ||
      hasPathSequence(segments, "tools", "policies");
    if (approvalPath) {
      matches.push({
        floorClass: "approval_rules",
        detail: `${methodLabel} /api/${segments.join("/")} edits approval rules`,
      });
    }
  }

  if (boardRequest && writeMethod) {
    const accessPath = hasSegment(segments, (token) => ACCESS_SEGMENT_RE.test(token));
    if (accessPath) {
      matches.push({
        floorClass: "access_secrets",
        detail: `${methodLabel} /api/${segments.join("/")} changes access or secrets`,
      });
    }
  }

  if (boardRequest && writeMethod) {
    const spendPath = hasSegment(segments, (token) => SPEND_SEGMENT_RE.test(token));
    if (spendPath || /api[_-]?keys?|paid/i.test(boardRequest.raw)) {
      matches.push({
        floorClass: "spend",
        detail: `${methodLabel} /api/${segments.join("/")} changes spend settings or paid keys`,
      });
    }
  }

  const configDelta = agentConfigDelta(args);
  if (configDelta?.env !== undefined && agentConfigWriteTool) {
    matches.push({ floorClass: "access_secrets", detail: "agent config change touches adapter env/secrets" });
  }
  if (configDelta?.model !== undefined && !TIER_MODEL_RE.test(String(configDelta.model))) {
    matches.push({
      floorClass: "spend",
      detail: `model change to non-tier model ${JSON.stringify(String(configDelta.model))}`,
    });
  }
  if (!configDelta && agentConfigWriteTool && typeof args === "string") {
    const stringFindings = stringFormAdapterFindings(args);
    if (stringFindings.env) {
      matches.push({ floorClass: "access_secrets", detail: "agent config change touches adapter env/secrets" });
    }
    if (stringFindings.model !== null && !TIER_MODEL_RE.test(stringFindings.model)) {
      matches.push({
        floorClass: "spend",
        detail: `model change to non-tier model ${JSON.stringify(stringFindings.model)}`,
      });
    }
  }
  if (boardRequest && writeMethod && typeof boardRequest.body === "string") {
    const stringFindings = stringFormAdapterFindings(boardRequest.raw);
    if (stringFindings.env) {
      matches.push({ floorClass: "access_secrets", detail: `${methodLabel} /api/${segments.join("/")} changes agent env/secrets` });
    }
    if (stringFindings.model !== null && !TIER_MODEL_RE.test(stringFindings.model)) {
      matches.push({
        floorClass: "spend",
        detail: `model change to non-tier model ${JSON.stringify(stringFindings.model)}`,
      });
    }
  }

  const external = isExternalProvider(probe.providerType);
  if (tokenNames.some((name) => PUBLISHING_ANY_PROVIDER_TOKEN_RE.test(name))) {
    matches.push({ floorClass: "publishing", detail: `tool ${probe.toolName} publishes or posts externally` });
  }
  if (external) {
    if (probe.providerType && PUBLISHING_PROVIDER_RE.test(probe.providerType) && (writeRisk || writeMethod) &&
        tokenNames.some((name) => PUBLISHING_PROVIDER_TOKEN_RE.test(name))) {
      matches.push({ floorClass: "publishing", detail: `provider ${probe.providerType} publishes externally` });
    }
    if (probe.providerType && COMMUNICATION_PROVIDER_RE.test(probe.providerType) && (writeRisk || writeMethod)) {
      matches.push({ floorClass: "publishing", detail: `provider ${probe.providerType} sends messages or posts externally` });
    }
  }

  if (dbTool) {
    const sqlProbe = parseSqlProbe(args, dbWriteTool);
    if (sqlProbe === null) {
      matches.push({ floorClass: "unguarded_sql", detail: "SQL tool arguments are not recognizable SQL" });
    } else {
      for (const statement of sqlProbe.statements) {
        const isRead = statementIsRead(statement);
        if (SQL_SECRET_RE.test(statement.text)) {
          matches.push({
            floorClass: "access_secrets",
            detail: `SQL touches secrets or adapter env (${sqlTableNames(statement.text).join(", ") || "expression"})`,
          });
          continue;
        }
        if (isRead) continue;
        if (!sqlProbe.writeTool) {
          matches.push({ floorClass: "unguarded_sql", detail: "read tool carries a non-read or unclassifiable statement" });
          continue;
        }
        const tables = sqlTableNames(statement.text);
        const floorTable = tables.find((table) => FLOOR_TABLE_CLASSES[table] !== undefined);
        const writeVerb =
          statement.verb === "with"
            ? SQL_MODIFYING_CTE_RE.exec(statement.text)?.[1]?.toLowerCase()
              ?? SQL_TRAILING_WRITE_RE.exec(statement.text)?.[1]?.toLowerCase()
              ?? null
            : statement.verb;
        if (statement.verb === "do") {
          matches.push({ floorClass: "unguarded_sql", detail: "DO block cannot be classified" });
          continue;
        }
        if (writeVerb === "grant" || writeVerb === "revoke") {
          matches.push({ floorClass: "access_secrets", detail: `SQL ${writeVerb.toUpperCase()} changes privileges` });
          continue;
        }
        if (floorTable) {
          matches.push({ floorClass: FLOOR_TABLE_CLASSES[floorTable], detail: `SQL writes floor table ${floorTable}` });
          continue;
        }
        if (writeVerb === "truncate" || writeVerb === "drop" || writeVerb === "alter") {
          matches.push({ floorClass: "unguarded_sql", detail: `${writeVerb.toUpperCase()} is unguarded destruction` });
          continue;
        }
        if (
          (writeVerb === "delete" || writeVerb === "update") &&
          !statementHasRowGuard(statement.text, sqlProbe.expectedRowCount)
        ) {
          matches.push({ floorClass: "unguarded_sql", detail: `${writeVerb.toUpperCase()} without a row guard` });
          continue;
        }
        if (writeVerb === null) {
          matches.push({ floorClass: "unguarded_sql", detail: "statement cannot be classified" });
        }
      }
    }
  }

  if (boardRequest && writeMethod) {
    if (normalized?.companyIdInPath) {
      if (normalized.companyIdInPath !== probe.sessionCompanyId) {
        matches.push({
          floorClass: "cross_company",
          detail: `write targets company ${normalized.companyIdInPath} from session company ${probe.sessionCompanyId}`,
        });
      }
    } else if (probe.target.kind === "other_company") {
      matches.push({
        floorClass: "cross_company",
        detail: `write targets company ${probe.target.companyId} from session company ${probe.sessionCompanyId}`,
      });
    } else if (probe.target.kind === "unresolved") {
      matches.push({ floorClass: "cross_company", detail: "write target company could not be resolved" });
    }
  }
  if (!boardRequest && agentConfigWriteTool && writeRisk) {
    if (probe.target.kind === "other_company") {
      matches.push({
        floorClass: "cross_company",
        detail: `write targets company ${probe.target.companyId} from session company ${probe.sessionCompanyId}`,
      });
    } else if (probe.target.kind === "unresolved") {
      matches.push({ floorClass: "cross_company", detail: "write target company could not be resolved" });
    }
  }

  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.floorClass}:${match.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type FloorTargetResource = "issues" | "agents" | "approvals" | "projects" | "heartbeat_runs" | "issue_comments";

export async function resolveFloorTarget(
  db: Db,
  probeInput: {
    boardRequest: BoardApiRequest | null;
    toolName: string;
    upstreamToolName: string | null;
    sessionCompanyId: string;
    args: unknown;
  },
): Promise<FloorTargetResolution> {
  const boardApi = BOARD_API_TOOL_RE.test(probeInput.toolName) || BOARD_API_TOOL_RE.test(probeInput.upstreamToolName ?? "");
  const agentConfigTool = AGENT_CONFIG_TOOLS.has(probeInput.toolName) || AGENT_CONFIG_TOOLS.has(probeInput.upstreamToolName ?? "");
  if (boardApi) {
    const request = probeInput.boardRequest ?? parseBoardApiRequest(probeInput.args);
    if (!request || !WRITE_METHODS.has(request.method)) return { kind: "not_applicable" };
    const normalized = normalizeFloorPath(request.path);
    if (normalized.companyIdInPath) {
      return normalized.companyIdInPath === probeInput.sessionCompanyId
        ? { kind: "same_company", companyId: normalized.companyIdInPath }
        : { kind: "other_company", companyId: normalized.companyIdInPath };
    }
    const resource = segmentsToResource(normalized.segments);
    if (!resource) return { kind: "unresolved" };
    const lookupId = resource.parentResourceId ?? resource.resourceId;
    if (!lookupId) return { kind: "unresolved" };
    const companyId = await lookupResourceCompany(db, resource.table, lookupId);
    return resolvedFromRow(companyId, probeInput.sessionCompanyId);
  }
  if (agentConfigTool && probeInput.toolName !== "get_agent_config" && (probeInput.upstreamToolName ?? "") !== "get_agent_config") {
    const agentRef = agentReference(probeInput.args);
    if (!agentRef) return { kind: "unresolved" };
    const byId = UUID_RE.test(agentRef);
    const rows = byId
      ? await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(or(eq(agents.id, agentRef), eq(agents.name, agentRef)))
          .limit(1)
      : await db
          .select({ companyId: agents.companyId })
          .from(agents)
          .where(eq(agents.name, agentRef))
          .limit(1);
    return resolvedFromRow(rows[0]?.companyId ?? null, probeInput.sessionCompanyId);
  }
  return { kind: "not_applicable" };
}

function segmentsToResource(segments: string[]): { table: FloorTargetResource; resourceId: string | null; parentResourceId: string | null } | null {
  if (segments.length === 0) return null;
  const alias: Record<string, FloorTargetResource> = {
    issues: "issues",
    agents: "agents",
    approvals: "approvals",
    projects: "projects",
    runs: "heartbeat_runs",
    "heartbeat-runs": "heartbeat_runs",
    comments: "issue_comments",
    "issue-comments": "issue_comments",
  };
  const table = alias[segments[0]];
  if (!table) return null;
  if (segments.length >= 3 && segments[0] !== "comments" && segments[0] !== "issue-comments") {
    return { table, resourceId: null, parentResourceId: segments[1] ?? null };
  }
  return { table, resourceId: segments[1] ?? null, parentResourceId: null };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function lookupResourceCompany(db: Db, table: FloorTargetResource, id: string): Promise<string | null> {
  if (!UUID_RE.test(id)) return null;
  switch (table) {
    case "issues": {
      const rows = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, id)).limit(1);
      return rows[0]?.companyId ?? null;
    }
    case "agents": {
      const rows = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, id)).limit(1);
      return rows[0]?.companyId ?? null;
    }
    case "approvals": {
      const rows = await db.select({ companyId: approvals.companyId }).from(approvals).where(eq(approvals.id, id)).limit(1);
      return rows[0]?.companyId ?? null;
    }
    case "projects": {
      const rows = await db.select({ companyId: projects.companyId }).from(projects).where(eq(projects.id, id)).limit(1);
      return rows[0]?.companyId ?? null;
    }
    case "heartbeat_runs": {
      const rows = await db.select({ companyId: heartbeatRuns.companyId }).from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).limit(1);
      return rows[0]?.companyId ?? null;
    }
    case "issue_comments": {
      const rows = await db.select({ companyId: issueComments.companyId }).from(issueComments).where(eq(issueComments.id, id)).limit(1);
      return rows[0]?.companyId ?? null;
    }
  }
}

function resolvedFromRow(companyId: string | null, sessionCompanyId: string): FloorTargetResolution {
  if (!companyId) return { kind: "unresolved" };
  return companyId === sessionCompanyId
    ? { kind: "same_company", companyId }
    : { kind: "other_company", companyId };
}

function agentReference(args: unknown): string | null {
  if (typeof args === "string") {
    const match = /\bagent(?:[_-]?id)?\s*[:=]\s*['"]([^'"]+)['"]/i.exec(args);
    return match?.[1]?.trim() || null;
  }
  if (!isRecord(args)) return null;
  const value = [args.agent, args.agentId, args.agent_id, args.id].find((candidate) => typeof candidate === "string");
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function floorProbeFromDecisionInput(input: ToolAccessDecisionInput, target: FloorTargetResolution): FloorProbe {
  return {
    toolName: input.request.toolName,
    upstreamToolName: input.request.upstreamToolName ?? null,
    providerType: input.request.providerType ?? null,
    riskLevel: (input.request.riskLevel as string | null) ?? null,
    args: input.request.arguments ?? null,
    sessionCompanyId: input.companyId,
    target,
  };
}

export async function toolFloorMatches(
  db: Db,
  input: {
    toolName: string;
    upstreamToolName?: string | null;
    providerType?: string | null;
    riskLevel?: string | null;
    parameters: unknown;
    sessionCompanyId: string;
  },
): Promise<FloorMatch[]> {
  const boardRequest = parseBoardApiRequest(input.parameters);
  const target = await resolveFloorTarget(db, {
    boardRequest,
    toolName: input.toolName,
    upstreamToolName: input.upstreamToolName ?? null,
    sessionCompanyId: input.sessionCompanyId,
    args: input.parameters,
  });
  return matchFloor({
    toolName: input.toolName,
    upstreamToolName: input.upstreamToolName ?? null,
    providerType: input.providerType ?? null,
    riskLevel: input.riskLevel ?? null,
    args: input.parameters,
    sessionCompanyId: input.sessionCompanyId,
    target,
  });
}

export async function reviewAutoApproval(
  db: Db,
  input: ToolAccessDecisionInput,
  decision: ToolAccessDecision,
): Promise<ReviewedToolAccessDecision> {
  if (decision.decision === "deny") return asReviewedDecision(decision);
  const boardRequest = parseBoardApiRequest(input.request.arguments ?? null);
  const target = await resolveFloorTarget(db, {
    boardRequest,
    toolName: input.request.toolName,
    upstreamToolName: input.request.upstreamToolName ?? null,
    sessionCompanyId: input.companyId,
    args: input.request.arguments ?? null,
  });
  const probe = floorProbeFromDecisionInput(input, target);
  const matches = matchFloor(probe);
  if (matches.length === 0) return asReviewedDecision(decision);
  const classes = matches.map((match) => match.floorClass);
  const explanation = matches.map((match) => `${match.floorClass}: ${match.detail}`).join("; ");
  const floorExplanation = `Hard floor requires owner approval (${explanation}).`;
  const floorDecision: ToolAccessDecision = {
    ...decision,
    decision: "require_approval",
    allowed: false,
    reasonCode: "requires_approval_policy",
    explanation:
      decision.decision === "require_approval" ? `${decision.explanation} ${floorExplanation}` : floorExplanation,
    matchedPolicyIds: decision.matchedPolicyIds,
    policyExplanation: {
      ...decision.policyExplanation,
      autoApprovalFloor: {
        classes,
        source: `floor:${classes[0]}`,
        details: matches.map((match) => match.detail),
      },
    },
  };
  return asReviewedDecision(floorDecision);
}

export async function toolRequiresFormalApproval(
  db: Db,
  input: {
    toolName: string;
    upstreamToolName?: string | null;
    providerType?: string | null;
    riskLevel?: string | null;
    parameters: unknown;
    sessionCompanyId: string;
  },
): Promise<boolean> {
  const matches = await toolFloorMatches(db, input);
  return matches.length > 0;
}