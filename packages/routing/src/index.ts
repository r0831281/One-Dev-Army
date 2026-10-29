export type MatchKind = "webhook" | "exact" | "prefix" | "regex" | "fallback";
export interface RoutingRule {
  id: string;
  revision: number;
  enabled: boolean;
  priority: number;
  matchKind: MatchKind;
  pattern: string;
  pluginInstanceId: string;
  repositoryId: string;
}
export interface RouteInput {
  kind: "identifier" | "webhook";
  value: string;
}
export interface RouteCandidate {
  rule: RoutingRule;
  specificity: number;
  subSpecificity: number;
  matched: boolean;
}
export interface RoutePreview {
  selected: RouteCandidate | null;
  candidates: RouteCandidate[];
  ambiguous: boolean;
}

const specificity: Record<MatchKind, number> = { webhook: 4, exact: 3, prefix: 3, regex: 2, fallback: 1 };

export class RoutingError extends Error {
  constructor(
    readonly code: "MALFORMED_INPUT" | "AMBIGUOUS_ROUTE" | "NO_ROUTE" | "UNSAFE_REGEX",
    message: string,
  ) {
    super(message);
  }
}

export function compileSafeRegex(pattern: string): RegExp {
  if (pattern.length > 512) throw new RoutingError("UNSAFE_REGEX", "Regex exceeds 512 characters");
  // Reject constructs unsupported by RE2 and common catastrophic nested repetition before using the JS engine.
  if (
    /\\[1-9]|\(\?<?[=!]|\(\?>|\(\?\(|\(\?[a-zA-Z-]+:/.test(pattern) ||
    /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)
  ) {
    throw new RoutingError("UNSAFE_REGEX", "Pattern is not RE2-compatible");
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    throw new RoutingError("MALFORMED_INPUT", "Invalid regex pattern");
  }
}

function matches(rule: RoutingRule, input: RouteInput): boolean {
  if (!rule.enabled) return false;
  if (rule.matchKind === "fallback") return true;
  if (rule.matchKind === "webhook") return input.kind === "webhook" && input.value === rule.pattern;
  if (input.kind !== "identifier") return false;
  if (rule.matchKind === "exact") return input.value === rule.pattern;
  if (rule.matchKind === "prefix") return input.value.startsWith(rule.pattern);
  return compileSafeRegex(rule.pattern).test(input.value);
}

function subSpecificity(rule: RoutingRule): number {
  if (rule.matchKind === "exact") return 1_000_000;
  if (rule.matchKind === "prefix") return rule.pattern.length;
  return 0;
}

export function previewRoute(rules: readonly RoutingRule[], input: RouteInput): RoutePreview {
  if (!input.value || input.value.length > 2048 || /[\u0000-\u001f]/.test(input.value))
    throw new RoutingError("MALFORMED_INPUT", "Invalid route input");
  const candidates = rules
    .map((rule) => ({
      rule,
      specificity: specificity[rule.matchKind],
      subSpecificity: subSpecificity(rule),
      matched: matches(rule, input),
    }))
    .filter((candidate) => candidate.matched)
    .sort(
      (a, b) =>
        b.rule.priority - a.rule.priority ||
        b.specificity - a.specificity ||
        b.subSpecificity - a.subSpecificity ||
        a.rule.id.localeCompare(b.rule.id),
    );
  const first = candidates[0] ?? null;
  const second = candidates[1];
  const ambiguous = Boolean(
    first &&
      second &&
      first.rule.priority === second.rule.priority &&
      first.specificity === second.specificity &&
      first.subSpecificity === second.subSpecificity &&
      (first.rule.pluginInstanceId !== second.rule.pluginInstanceId ||
        first.rule.repositoryId !== second.rule.repositoryId),
  );
  return { selected: ambiguous ? null : first, candidates, ambiguous };
}

export function resolveRoute(rules: readonly RoutingRule[], input: RouteInput): RoutingRule {
  const preview = previewRoute(rules, input);
  if (preview.ambiguous)
    throw new RoutingError("AMBIGUOUS_ROUTE", "Top-ranked rules select different targets");
  if (!preview.selected) throw new RoutingError("NO_ROUTE", "No routing rule matched");
  return preview.selected.rule;
}
