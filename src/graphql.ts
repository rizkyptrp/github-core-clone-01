// GraphQL v4: a small parser (lexer + recursive descent) and an executor for
// the documents the suite sends — viewer, repository, issue and pull request
// reads, Relay cursors, the __type introspection used by the checks, node()
// lookups and the five mutations the suite exercises.
//
// Global ids are opaque base64 of a typed key (`Repository:12`,
// `Issue:12:3`, `PullRequest:12:5`, `IssueComment:7`) — stable across reads,
// never equal to a bare database id or number. Unknown fields are errors:
// the response is HTTP 200 with an `errors` entry naming the field. An unknown
// repository is `data.repository = null` with no errors. A JSON array body is
// a batch: the answers come back in the same order.

import type { Issue, PullRequest, Repo, Store } from './store.ts';

// ---------------------------------------------------------------- ids

export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(':');
  if (parts.length < 2) return null;
  return { kind: parts[0] as string, parts: parts.slice(1) };
}

function repoId(repo: Repo): string {
  return encodeGlobalId('Repository', repo.id);
}

function issueId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', repo.id, issue.number);
}

function pullId(repo: Repo, pull: PullRequest): string {
  return encodeGlobalId('PullRequest', repo.id, pull.number);
}

function commentId(id: number): string {
  return encodeGlobalId('IssueComment', id);
}

function cursorForNumber(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") and ordinary strings.
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        const c = input[i] as string;
        if (c === '\\' && i + 1 < input.length) {
          const next = input[i + 1] as string;
          if (next === 'n') value += '\n';
          else if (next === 't') value += '\t';
          else if (next === 'r') value += '\r';
          else if (next === '"') value += '"';
          else if (next === '\\') value += '\\';
          else if (next === '/') value += '/';
          else if (next === 'u' && i + 5 < input.length) {
            value += String.fromCharCode(Number.parseInt(input.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += next;
          i += 2;
          continue;
        }
        value += c;
        i += 1;
      }
      if (i >= input.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly alias: string;
  readonly name: string;
  readonly args: Record<string, ValueNode>;
  readonly selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  readonly operationType: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefinitions: Record<string, { defaultValue?: ValueNode }>;
  readonly selections: SelectionNode[];
}

interface Fragment {
  readonly typeCondition: string;
  readonly selections: SelectionNode[];
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.index] as Token;
    this.index += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}", got ${token.kind === 'eof' ? 'end of document' : JSON.stringify(token.value)}`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    return token.value;
  }

  parseDocument(): { operations: Operation[]; fragments: Record<string, Fragment> } {
    const operations: Operation[] = [];
    const fragments: Record<string, Fragment> = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operationType: 'query',
          name: null,
          variableDefinitions: {},
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operationType = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const next = this.peek();
        if (next.kind === 'name') name = this.next().value;
        const variableDefinitions: Record<string, { defaultValue?: ValueNode }> = {};
        if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
          this.next();
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.skipType();
            let defaultValue: ValueNode | undefined;
            if (this.matchPunct('=')) defaultValue = this.parseValue();
            variableDefinitions[varName] = defaultValue === undefined ? {} : { defaultValue };
          }
          this.expectPunct(')');
        }
        operations.push({ operationType, name, variableDefinitions, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment must be followed by "on"');
        const typeCondition = this.expectName();
        fragments[name] = { typeCondition, selections: this.parseSelectionSet() };
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.kind === 'eof' ? 'eof' : token.value)}`);
    }
    return { operations, fragments };
  }

  private skipType(): void {
    // Named type, possibly wrapped in [] and suffixed with !.
    for (;;) {
      const token = this.peek();
      if (token.kind === 'punct' && (token.value === '[' || token.value === ']' || token.value === '!')) {
        this.next();
        continue;
      }
      if (token.kind === 'name') {
        this.next();
        continue;
      }
      return;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('selection set is not closed');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.kind)}`);
  }
}

// ---------------------------------------------------------------- executor

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ResolverContext = {
  readonly store: Store;
  readonly variables: Record<string, JsonValue>;
  readonly fragments: Record<string, Fragment>;
  readonly errors: Array<{ message: string }>;
};

/** The fields each named type exposes (introspection and validation share this). */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Viewer: ['login', 'name', 'email', 'id'],
  User: ['login', 'name', 'email', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'isPrivate', 'description', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Owner: ['login'],
  Ref: ['name'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'author'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName',
    'mergeable', 'files', 'createdAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path'],
  IssueComment: ['id', 'databaseId', 'body', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

type NodeValue =
  | { kind: 'query' }
  | { kind: 'mutation' }
  | { kind: 'viewer' }
  | { kind: 'repository'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pull'; repo: Repo; pull: PullRequest }
  | { kind: 'issueConnection'; repo: Repo; issues: Issue[]; pageInfo: PageInfoValue }
  | { kind: 'pullConnection'; repo: Repo; pulls: PullRequest[]; pageInfo: PageInfoValue }
  | { kind: 'filesConnection'; files: Array<{ path: string }> }
  | { kind: 'comment'; commentId: number; body: string }
  | { kind: 'commentEdge'; commentId: number; body: string }
  | { kind: 'owner'; login: string }
  | { kind: 'ref'; name: string }
  | { kind: 'pageInfo'; value: PageInfoValue }
  | { kind: 'type'; name: string }
  | { kind: 'payload'; fields: Record<string, NodeValue | JsonValue> };

interface PageInfoValue {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor: string | null;
  readonly endCursor: string | null;
}

function resolveValue(node: ValueNode, variables: Record<string, JsonValue>): JsonValue {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
      return node.value;
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: { [key: string]: JsonValue } = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ResolverContext): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [name, value] of Object.entries(field.args)) out[name] = resolveValue(value, ctx.variables);
  return out;
}

function typeNameOf(node: NodeValue): string {
  switch (node.kind) {
    case 'query': return 'Query';
    case 'mutation': return 'Mutation';
    case 'viewer': return 'Viewer';
    case 'repository': return 'Repository';
    case 'issue': return 'Issue';
    case 'pull': return 'PullRequest';
    case 'issueConnection': return 'IssueConnection';
    case 'pullConnection': return 'PullRequestConnection';
    case 'filesConnection': return 'PullRequestChangedFileConnection';
    case 'comment': return 'IssueComment';
    case 'commentEdge': return 'IssueCommentEdge';
    case 'owner': return 'Owner';
    case 'ref': return 'Ref';
    case 'pageInfo': return 'PageInfo';
    case 'type': return '__Type';
    case 'payload': return 'Payload';
  }
}

function executeSelections(
  node: NodeValue,
  selections: readonly SelectionNode[],
  ctx: ResolverContext,
): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments[selection.name];
      if (!fragment) {
        ctx.errors.push({ message: `unknown fragment ${selection.name}` });
        continue;
      }
      if (fragment.typeCondition !== typeNameOf(node)) continue;
      Object.assign(out, executeSelections(node, fragment.selections, ctx));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeNameOf(node)) continue;
      Object.assign(out, executeSelections(node, selection.selections, ctx));
      continue;
    }
    const field = selection.field;
    out[field.alias] = executeField(node, field, ctx);
  }
  return out;
}

function executeField(node: NodeValue, field: FieldNode, ctx: ResolverContext): JsonValue {
  const typeName = typeNameOf(node);
  const allowed = TYPE_FIELDS[typeName];
  if (node.kind !== 'payload' && allowed !== undefined && !allowed.includes(field.name)) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  const args = resolveArgs(field, ctx);
  const value = resolveField(node, field.name, args, ctx);
  if (value === undefined) {
    ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
    return null;
  }
  if (value === null || typeof value !== 'object') return value as JsonValue;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item !== null && typeof item === 'object' && 'kind' in item) {
        return executeSelections(item as NodeValue, field.selections, ctx);
      }
      return item as JsonValue;
    });
  }
  return executeSelections(value as NodeValue, field.selections, ctx);
}

function asStringArg(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asIntArg(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** The issues of a repo, ordered and windowed per the connection arguments. */
function issueConnection(repo: Repo, args: Record<string, JsonValue>): NodeValue {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy;
  const orderField = orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)
    ? String((orderBy as { field?: JsonValue }).field ?? 'CREATED_AT')
    : 'CREATED_AT';
  const direction = orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)
    ? String((orderBy as { direction?: JsonValue }).direction ?? 'ASC')
    : 'ASC';
  if (orderField === 'CREATED_AT' && direction === 'DESC') {
    issues.sort((a, b) => b.number - a.number);
  } else {
    issues.sort((a, b) => a.number - b.number);
  }
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    issues = index >= 0 ? issues.slice(index + 1) : issues;
  }
  const first = asIntArg(args.first);
  let hasNextPage = false;
  if (first !== undefined && issues.length > first) {
    hasNextPage = true;
    issues = issues.slice(0, first);
  }
  const pageInfo: PageInfoValue = {
    hasNextPage,
    hasPreviousPage: false,
    startCursor: issues.length > 0 ? cursorForNumber((issues[0] as Issue).number) : null,
    endCursor: issues.length > 0 ? cursorForNumber((issues[issues.length - 1] as Issue).number) : null,
  };
  return { kind: 'issueConnection', repo, issues, pageInfo };
}

function pullConnection(repo: Repo, args: Record<string, JsonValue>): NodeValue {
  let pulls = [...repo.pulls.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    pulls = pulls.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      return wanted.has(state);
    });
  }
  pulls.sort((a, b) => a.number - b.number);
  const first = asIntArg(args.first);
  let hasNextPage = false;
  if (first !== undefined && pulls.length > first) {
    hasNextPage = true;
    pulls = pulls.slice(0, first);
  }
  const pageInfo: PageInfoValue = {
    hasNextPage,
    hasPreviousPage: false,
    startCursor: pulls.length > 0 ? cursorForNumber((pulls[0] as PullRequest).number) : null,
    endCursor: pulls.length > 0 ? cursorForNumber((pulls[pulls.length - 1] as PullRequest).number) : null,
  };
  return { kind: 'pullConnection', repo, pulls, pageInfo };
}

function resolveField(
  node: NodeValue,
  name: string,
  args: Record<string, JsonValue>,
  ctx: ResolverContext,
): NodeValue | JsonValue | null | undefined {
  const store = ctx.store;
  switch (node.kind) {
    case 'query': {
      if (name === 'viewer') return { kind: 'viewer' };
      if (name === 'repository') {
        const owner = asStringArg(args.owner);
        const repoName = asStringArg(args.name);
        if (owner !== store.viewer.login) return null;
        const repo = store.getRepo(owner, repoName);
        return repo === undefined ? null : { kind: 'repository', repo };
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(asStringArg(args.id));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
          return repo === undefined ? null : { kind: 'repository', repo };
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const repo = store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
          const number = Number.parseInt(decoded.parts[1] ?? '', 10);
          if (repo === undefined || !Number.isInteger(number)) return null;
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.get(number);
            return issue === undefined ? null : { kind: 'issue', repo, issue };
          }
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { kind: 'pull', repo, pull };
        }
        return null;
      }
      if (name === '__type') {
        const typeName = asStringArg(args.name);
        if (TYPE_FIELDS[typeName] === undefined && ENUM_VALUES[typeName] === undefined) return null;
        return { kind: 'type', name: typeName };
      }
      return undefined;
    }
    case 'mutation': {
      if (name === 'createIssue') return createIssueMutation(store, args);
      if (name === 'closeIssue') return closeIssueMutation(store, args);
      if (name === 'createPullRequest') return createPullRequestMutation(store, args);
      if (name === 'mergePullRequest') return mergePullRequestMutation(store, args);
      if (name === 'addComment') return addCommentMutation(store, args);
      return undefined;
    }
    case 'viewer': {
      if (name === 'login') return store.viewer.login;
      if (name === 'name') return store.viewer.name;
      if (name === 'email') return store.viewer.email;
      if (name === 'id') return encodeGlobalId('User', store.viewer.id);
      return undefined;
    }
    case 'repository': {
      const repo = node.repo;
      switch (name) {
        case 'id': return repoId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { kind: 'owner', login: repo.owner };
        case 'defaultBranchRef': return { kind: 'ref', name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'isPrivate': return repo.private;
        case 'description': return repo.description;
        case 'issue': {
          const issue = repo.issues.get(asIntArg(args.number) ?? -1);
          return issue === undefined ? null : { kind: 'issue', repo, issue };
        }
        case 'issues': return issueConnection(repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(asIntArg(args.number) ?? -1);
          return pull === undefined ? null : { kind: 'pull', repo, pull };
        }
        case 'pullRequests': return pullConnection(repo, args);
        default: return undefined;
      }
    }
    case 'issue': {
      const issue = node.issue;
      switch (name) {
        case 'id': return issueId(node.repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'createdAt': return issue.createdAt;
        case 'author': return { kind: 'owner', login: store.viewer.login };
        default: return undefined;
      }
    }
    case 'pull': {
      const pull = node.pull;
      switch (name) {
        case 'id': return pullId(node.repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          store.refreshPull(node.repo, pull);
          const { conflicts } = store.mergePlan(node.repo, pull);
          return conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const files = store.pullFiles(node.repo, pull).map((file) => ({ path: file.filename }));
          return { kind: 'filesConnection', files };
        }
        case 'createdAt': return pull.createdAt;
        case 'author': return { kind: 'owner', login: store.viewer.login };
        default: return undefined;
      }
    }
    case 'issueConnection': {
      if (name === 'nodes') return node.issues.map((issue) => ({ kind: 'issue' as const, repo: node.repo, issue }));
      if (name === 'edges') {
        return node.issues.map((issue) => ({
          kind: 'payload' as const,
          fields: {
            node: { kind: 'issue' as const, repo: node.repo, issue },
            cursor: cursorForNumber(issue.number),
          },
        }));
      }
      if (name === 'totalCount') return node.issues.length;
      if (name === 'pageInfo') return { kind: 'pageInfo', value: node.pageInfo };
      return undefined;
    }
    case 'pullConnection': {
      if (name === 'nodes') return node.pulls.map((pull) => ({ kind: 'pull' as const, repo: node.repo, pull }));
      if (name === 'edges') {
        return node.pulls.map((pull) => ({
          kind: 'payload' as const,
          fields: {
            node: { kind: 'pull' as const, repo: node.repo, pull },
            cursor: cursorForNumber(pull.number),
          },
        }));
      }
      if (name === 'totalCount') return node.pulls.length;
      if (name === 'pageInfo') return { kind: 'pageInfo', value: node.pageInfo };
      return undefined;
    }
    case 'filesConnection': {
      if (name === 'nodes') {
        return node.files.map((file) => ({ kind: 'payload' as const, fields: { path: file.path } }));
      }
      if (name === 'totalCount') return node.files.length;
      if (name === 'pageInfo') {
        return {
          kind: 'pageInfo',
          value: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      return undefined;
    }
    case 'comment': {
      if (name === 'id') return commentId(node.commentId);
      if (name === 'databaseId') return node.commentId;
      if (name === 'body') return node.body;
      if (name === 'author') return { kind: 'owner', login: store.viewer.login };
      return undefined;
    }
    case 'commentEdge': {
      if (name === 'node') return { kind: 'comment', commentId: node.commentId, body: node.body };
      if (name === 'cursor') return cursorForNumber(node.commentId);
      return undefined;
    }
    case 'owner': {
      if (name === 'login') return node.login;
      if (name === 'id') return encodeGlobalId('User', 1000);
      if (name === 'name') return node.login;
      if (name === 'email') return `${node.login}@example.invalid`;
      return undefined;
    }
    case 'ref': {
      if (name === 'name') return node.name;
      return undefined;
    }
    case 'pageInfo': {
      const value = node.value;
      if (name === 'hasNextPage') return value.hasNextPage;
      if (name === 'hasPreviousPage') return value.hasPreviousPage;
      if (name === 'startCursor') return value.startCursor;
      if (name === 'endCursor') return value.endCursor;
      return undefined;
    }
    case 'type': {
      if (name === 'name') return node.name;
      if (name === 'kind') return ENUM_VALUES[node.name] !== undefined ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = TYPE_FIELDS[node.name] ?? [];
        return fields.map((fieldName) => ({
          kind: 'payload' as const,
          fields: { name: fieldName, description: null, type: null },
        }));
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[node.name] ?? [];
        return values.map((value) => ({
          kind: 'payload' as const,
          fields: { name: value, description: null },
        }));
      }
      return undefined;
    }
    case 'payload': {
      const value = node.fields[name];
      return value === undefined ? undefined : value;
    }
  }
}

// ---------------------------------------------------------------- mutations

function repoFromGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10)) ?? null;
}

function createIssueMutation(store: Store, args: Record<string, JsonValue>): NodeValue {
  const input = (args.input ?? {}) as { repositoryId?: JsonValue; title?: JsonValue; body?: JsonValue };
  const repo = repoFromGlobalId(store, asStringArg(input.repositoryId));
  if (repo === null) throw new Error('repository not found');
  const created = store.createIssue(repo, asStringArg(input.title), asStringArg(input.body), []);
  if ('error' in created) throw new Error(created.error);
  return { kind: 'payload', fields: { issue: { kind: 'issue', repo, issue: created }, clientMutationId: null } };
}

function closeIssueMutation(store: Store, args: Record<string, JsonValue>): NodeValue {
  const input = (args.input ?? {}) as { issueId?: JsonValue };
  const decoded = decodeGlobalId(asStringArg(input.issueId));
  if (decoded === null || decoded.kind !== 'Issue') throw new Error('issue not found');
  const repo = store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
  const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] ?? '', 10));
  if (repo === undefined || issue === undefined) throw new Error('issue not found');
  issue.state = 'closed';
  issue.closedAt = store.nowIso();
  issue.updatedAt = store.nowIso();
  return { kind: 'payload', fields: { issue: { kind: 'issue', repo, issue }, clientMutationId: null } };
}

function createPullRequestMutation(store: Store, args: Record<string, JsonValue>): NodeValue {
  const input = (args.input ?? {}) as {
    repositoryId?: JsonValue;
    baseRefName?: JsonValue;
    headRefName?: JsonValue;
    title?: JsonValue;
    body?: JsonValue;
  };
  const repo = repoFromGlobalId(store, asStringArg(input.repositoryId));
  if (repo === null) throw new Error('repository not found');
  const created = store.createPull(
    repo,
    asStringArg(input.title),
    asStringArg(input.body),
    asStringArg(input.headRefName),
    asStringArg(input.baseRefName, 'main'),
  );
  if ('error' in created) throw new Error(created.error);
  return { kind: 'payload', fields: { pullRequest: { kind: 'pull', repo, pull: created }, clientMutationId: null } };
}

function mergePullRequestMutation(store: Store, args: Record<string, JsonValue>): NodeValue {
  const input = (args.input ?? {}) as { pullRequestId?: JsonValue };
  const decoded = decodeGlobalId(asStringArg(input.pullRequestId));
  if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('pull request not found');
  const repo = store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
  const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] ?? '', 10));
  if (repo === undefined || pull === undefined) throw new Error('pull request not found');
  const merged = store.mergePull(repo, pull);
  if ('error' in merged) throw new Error(merged.error);
  return { kind: 'payload', fields: { pullRequest: { kind: 'pull', repo, pull }, clientMutationId: null } };
}

function addCommentMutation(store: Store, args: Record<string, JsonValue>): NodeValue {
  const input = (args.input ?? {}) as { subjectId?: JsonValue; body?: JsonValue };
  const decoded = decodeGlobalId(asStringArg(input.subjectId));
  if (decoded === null) throw new Error('subject not found');
  const repo = store.getRepoById(Number.parseInt(decoded.parts[0] ?? '', 10));
  const number = Number.parseInt(decoded.parts[1] ?? '', 10);
  if (repo === undefined || !Number.isInteger(number)) throw new Error('subject not found');
  const subject = decoded.kind === 'Issue' ? repo.issues.get(number) : repo.pulls.get(number);
  if (subject === undefined) throw new Error('subject not found');
  const comment = store.createComment(repo, number, asStringArg(input.body));
  return {
    kind: 'payload',
    fields: {
      commentEdge: { kind: 'commentEdge', commentId: comment.id, body: comment.body },
      clientMutationId: null,
    },
  };
}

// ---------------------------------------------------------------- entry point

export interface GraphQLResult {
  readonly status: number;
  readonly body: unknown;
}

function executeOne(
  store: Store,
  document: { query?: unknown; variables?: unknown; operationName?: unknown },
): { data: { [key: string]: JsonValue } | null; errors?: Array<{ message: string }> } {
  const query = typeof document.query === 'string' ? document.query : '';
  const variables = (document.variables !== null && typeof document.variables === 'object' && !Array.isArray(document.variables))
    ? (document.variables as Record<string, JsonValue>)
    : {};
  let parsed: { operations: Operation[]; fragments: Record<string, Fragment> };
  try {
    parsed = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const operationName = typeof document.operationName === 'string' ? document.operationName : null;
  let operation = parsed.operations[0] as Operation | undefined;
  if (operationName !== null) {
    operation = parsed.operations.find((candidate) => candidate.name === operationName);
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: `operation ${operationName ?? '(unnamed)'} not found` }] };
  }
  const allVariables: Record<string, JsonValue> = { ...variables };
  for (const [name, definition] of Object.entries(operation.variableDefinitions)) {
    if (allVariables[name] === undefined && definition.defaultValue !== undefined) {
      allVariables[name] = resolveValue(definition.defaultValue, variables);
    }
  }
  const ctx: ResolverContext = {
    store,
    variables: allVariables,
    fragments: parsed.fragments,
    errors: [],
  };
  const root: NodeValue = operation.operationType === 'mutation' ? { kind: 'mutation' } : { kind: 'query' };
  let data: { [key: string]: JsonValue };
  try {
    data = executeSelections(root, operation.selections, ctx);
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

/** Handle one GraphQL request body (a single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((item) => executeOne(store, (item ?? {}) as { query?: unknown })) };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { errors: [{ message: 'request body must be a JSON object or array' }] } };
  }
  return { status: 200, body: executeOne(store, body as { query?: unknown }) };
}
