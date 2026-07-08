/**
 * FEAT-429: filter-descriptor registry.
 *
 * Proves (a) the shared RECALL_FILTER_REGISTRY drives parsing + SQL for all
 * five migrated filters (project, agent, entity-schema-only, repo, since)
 * identically to the pre-registry hand-rolled behavior, and (b) a
 * descriptor-only addition — one new entry in a descriptors array, touching
 * none of the functions below — drives query parsing, structured-body
 * parsing, and SQL WHERE building end-to-end. (b) is exercised with a
 * synthetic descriptor local to this test file rather than a change to the
 * production registry, since the production surface set is fixed by
 * FEAT-424/FEAT-429; the point is that the *mechanism* requires no code
 * change, not that a new production filter exists yet.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  RECALL_FILTER_REGISTRY,
  getFilterSchema,
  buildFilterFieldsSchema,
  assignStructuredFilterValues,
  assignQueryFilterValues,
  applySqlColumnFilters,
  applySqlRangeFilters,
  type FilterDescriptor,
} from '../../src/contracts/filter-registry.js';
import {
  ProjectFilterSchema,
  AgentFilterSchema,
  EntityFilterSchema,
  RepoFilterSchema,
  SinceFilterSchema,
  RecallFilterFieldsSchema,
} from '../../src/contracts/recall-filters.js';

describe('RECALL_FILTER_REGISTRY — shape', () => {
  it('enumerates exactly project, agent, entity, repo, since', () => {
    expect(RECALL_FILTER_REGISTRY.map(d => d.name).sort()).toEqual(['agent', 'entity', 'project', 'repo', 'since']);
  });

  it('project/agent/repo are sqlColumn descriptors on their own column name', () => {
    const project = RECALL_FILTER_REGISTRY.find(d => d.name === 'project')!;
    const agent = RECALL_FILTER_REGISTRY.find(d => d.name === 'agent')!;
    const repo = RECALL_FILTER_REGISTRY.find(d => d.name === 'repo')!;
    expect(project.apply).toEqual({ kind: 'sqlColumn', column: 'project' });
    expect(agent.apply).toEqual({ kind: 'sqlColumn', column: 'agent' });
    expect(repo.apply).toEqual({ kind: 'sqlColumn', column: 'repo' });
  });

  it('entity is a custom (non-SQL-column) descriptor', () => {
    const entity = RECALL_FILTER_REGISTRY.find(d => d.name === 'entity')!;
    expect(entity.apply).toEqual({ kind: 'custom' });
  });

  it('since is a sqlRangeColumn descriptor on created_at with op gte', () => {
    const since = RECALL_FILTER_REGISTRY.find(d => d.name === 'since')!;
    expect(since.apply).toEqual({ kind: 'sqlRangeColumn', column: 'created_at', op: 'gte' });
  });

  it('every descriptor AND-composes', () => {
    for (const d of RECALL_FILTER_REGISTRY) expect(d.compose).toBe('AND');
  });
});

describe('registry -> recall-filters.ts re-exports stay identical', () => {
  it('ProjectFilterSchema/AgentFilterSchema/EntityFilterSchema/RepoFilterSchema/SinceFilterSchema are literally the registry schemas', () => {
    expect(ProjectFilterSchema).toBe(getFilterSchema('project'));
    expect(AgentFilterSchema).toBe(getFilterSchema('agent'));
    expect(EntityFilterSchema).toBe(getFilterSchema('entity'));
    expect(RepoFilterSchema).toBe(getFilterSchema('repo'));
    expect(SinceFilterSchema).toBe(getFilterSchema('since'));
  });

  it('RecallFilterFieldsSchema built from the registry accepts the same shape as before', () => {
    const value = { project: ['a', 'b'], agent: 'bot', entity: 'postgres', repo: 'myrepo', since: 1700000000000 };
    expect(RecallFilterFieldsSchema.safeParse(value).success).toBe(true);
    expect(RecallFilterFieldsSchema.safeParse({}).success).toBe(true);
    expect(RecallFilterFieldsSchema.safeParse({ project: 123 }).success).toBe(false);
    expect(RecallFilterFieldsSchema.safeParse({ repo: 123 }).success).toBe(false);
    expect(RecallFilterFieldsSchema.safeParse({ since: 'not-a-number' }).success).toBe(false);
  });
});

describe('assignQueryFilterValues — GET query-string surface, registry-driven', () => {
  it('single project value stays a string', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ project: 'runner-plugin' }, target);
    expect(target.project).toBe('runner-plugin');
  });

  it('comma-separated project becomes a list (OR-semantics)', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ project: 'a, b ,c' }, target);
    expect(target.project).toEqual(['a', 'b', 'c']);
  });

  it('agent follows the same CSV rule as project', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ agent: 'claude,gpt' }, target);
    expect(target.agent).toEqual(['claude', 'gpt']);
  });

  it('entity is forwarded verbatim (scalar, no CSV split)', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ entity: 'postgres,vec' }, target);
    expect(target.entity).toBe('postgres,vec');
  });

  it('absent/empty raw values assign nothing', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ project: '', agent: undefined }, target);
    expect(target).toEqual({});
  });

  it('repo is forwarded verbatim (scalar, no CSV split)', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ repo: 'my-repo,other' }, target);
    expect(target.repo).toBe('my-repo,other');
  });

  it('since parses a numeric epoch-ms string', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ since: '1700000000000' }, target);
    expect(target.since).toBe(1700000000000);
  });

  it('since drops an unparseable (NaN) value instead of throwing', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ since: '7d' }, target);
    expect(target).toEqual({});
  });
});

describe('assignStructuredFilterValues — JSON body / MCP args surface, registry-driven', () => {
  it('project/agent use a truthy presence check (empty string is "absent")', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues({ project: '', agent: 'bot' }, target);
    expect(target).toEqual({ agent: 'bot' });
  });

  it('entity uses a !== undefined presence check (empty string IS a filter)', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues({ entity: '' }, target);
    expect(target).toEqual({ entity: '' });
  });

  it('an undefined raw object assigns nothing and does not throw', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues(undefined, target);
    expect(target).toEqual({});
  });

  it('array values for project/agent pass through untouched', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues({ project: ['x', 'y'] }, target);
    expect(target.project).toEqual(['x', 'y']);
  });

  it('repo uses a truthy presence check (empty string is "absent"), like project/agent', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues({ repo: '' }, target);
    expect(target).toEqual({});
  });

  it('since uses a !== undefined presence check (0 is a legitimate lower bound, not "absent")', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues({ since: 0 }, target);
    expect(target).toEqual({ since: 0 });
  });
});

describe('applySqlColumnFilters — WHERE-clause builder, registry-driven', () => {
  it('a single project value produces `project = ?`', () => {
    const { clauses, params } = applySqlColumnFilters({ project: 'runner-plugin' });
    expect(clauses).toEqual(['project = ?']);
    expect(params).toEqual(['runner-plugin']);
  });

  it('a project list produces `project IN (...)` with OR-semantics params', () => {
    const { clauses, params } = applySqlColumnFilters({ project: ['a', 'b', 'c'] });
    expect(clauses).toEqual(['project IN (?,?,?)']);
    expect(params).toEqual(['a', 'b', 'c']);
  });

  it('an empty project list is "no constraint" — no clause emitted', () => {
    const { clauses, params } = applySqlColumnFilters({ project: [] });
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });

  it('project and agent both present AND-compose (two clauses, both params)', () => {
    const { clauses, params } = applySqlColumnFilters({ project: 'p1', agent: ['a1', 'a2'] });
    expect(clauses).toEqual(['project = ?', 'agent IN (?,?)']);
    expect(params).toEqual(['p1', 'a1', 'a2']);
  });

  it('entity (a "custom"-kind descriptor) is never turned into a SQL clause', () => {
    const { clauses, params } = applySqlColumnFilters({ entity: 'postgres' });
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });

  it('an absent filter key emits nothing', () => {
    const { clauses, params } = applySqlColumnFilters({});
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });

  it('a repo value produces `repo = ?` (scalar, never IN)', () => {
    const { clauses, params } = applySqlColumnFilters({ repo: 'myrepo' });
    expect(clauses).toEqual(['repo = ?']);
    expect(params).toEqual(['myrepo']);
  });

  it('since (a sqlRangeColumn-kind descriptor) is never turned into an sqlColumn clause', () => {
    const { clauses, params } = applySqlColumnFilters({ since: 1700000000000 });
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });
});

describe('applySqlRangeFilters — numeric lower-bound WHERE-clause builder, registry-driven', () => {
  it('since produces `created_at >= ?`', () => {
    const { clauses, params } = applySqlRangeFilters({ since: 1700000000000 });
    expect(clauses).toEqual(['created_at >= ?']);
    expect(params).toEqual([1700000000000]);
  });

  it('an absent since key emits nothing', () => {
    const { clauses, params } = applySqlRangeFilters({});
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });

  it('since = 0 still emits a clause (0 is a legitimate lower bound)', () => {
    const { clauses, params } = applySqlRangeFilters({ since: 0 });
    expect(clauses).toEqual(['created_at >= ?']);
    expect(params).toEqual([0]);
  });

  it('a project value (a sqlColumn-kind descriptor) is never turned into a range clause', () => {
    const { clauses, params } = applySqlRangeFilters({ project: 'p1' });
    expect(clauses).toEqual([]);
    expect(params).toEqual([]);
  });
});

describe('descriptor-only addition works end-to-end (FEAT-429 AC)', () => {
  // A synthetic filter defined ONLY in this test — one descriptor object,
  // zero edits to filter-registry.ts, src/search/search.ts, the routes, or
  // the MCP server. Every registry function below is generic over an
  // explicit `descriptors` array, so this descriptor drives GET-query
  // parsing, JSON-body parsing, schema construction, and SQL building
  // exactly like a "real" production entry would.
  const branchDescriptor: FilterDescriptor = {
    name: 'branch',
    valueShape: 'stringOrList',
    schema: z.union([z.string(), z.array(z.string())]).optional(),
    apply: { kind: 'sqlColumn', column: 'branch' },
    compose: 'AND',
    description: 'Test-only descriptor: filter by branch name(s).',
    presentInStructured: (value) => Boolean(value),
    parseQueryValue: (raw) => {
      const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length === 0) return undefined;
      return parts.length === 1 ? parts[0] : parts;
    },
  };
  const testDescriptors = [branchDescriptor] as const;

  it('drives GET query-string parsing', () => {
    const target: Record<string, unknown> = {};
    assignQueryFilterValues({ branch: 'main,dev' }, target, testDescriptors);
    expect(target.branch).toEqual(['main', 'dev']);
  });

  it('drives structured (JSON body / MCP args) parsing', () => {
    const target: Record<string, unknown> = {};
    assignStructuredFilterValues({ branch: 'main' }, target, testDescriptors);
    expect(target.branch).toBe('main');
  });

  it('drives SQL WHERE-clause building', () => {
    const { clauses, params } = applySqlColumnFilters({ branch: 'main' }, testDescriptors);
    expect(clauses).toEqual(['branch = ?']);
    expect(params).toEqual(['main']);
  });

  it('drives z.object() schema construction', () => {
    const schema = buildFilterFieldsSchema(testDescriptors);
    expect(schema.safeParse({ branch: 'main' }).success).toBe(true);
    expect(schema.safeParse({ branch: 123 }).success).toBe(false);
  });

  it('leaves the production registry untouched — branch is not a real filter', () => {
    expect(RECALL_FILTER_REGISTRY.some(d => d.name === 'branch')).toBe(false);
  });
});
