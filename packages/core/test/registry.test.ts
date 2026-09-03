import { describe, it, expect } from 'vitest';
import { allActions, actionNames } from '../src/registry/registry.js';
import { buildManifest } from '../src/registry/discover.js';
import '../src/index.js';

/**
 * These enforce the design laws mechanically. A description that fails to say
 * when NOT to use an action is a build failure here, not a review comment --
 * research across 856 MCP tools found 97.1% had a description defect and that
 * fixing descriptions alone measurably raised agent task success.
 */
describe('action registry invariants', () => {
  const actions = allActions();

  it('registers the expected action set', () => {
    expect(actionNames()).toEqual([
      'agent.list',
      'agent.register',
      'anchor.list',
      'anchor.now',
      'chain.head',
      'chain.verify',
      'init',
      'keygen',
      'receipts.query',
      'record',
    ]);
  });

  describe.each(actions.map((a) => [a.name, a] as const))('%s', (_name, action) => {
    it('has all five description facets', () => {
      for (const facet of ['what', 'when', 'whenNot', 'cost', 'returns'] as const) {
        expect(action.description[facet], `missing ${facet}`).toBeTruthy();
      }
    });

    it('has substantive, non-stub descriptions', () => {
      // A one-liner that restates the action name is the defect this catches.
      expect(action.description.what.length).toBeGreaterThan(40);
      expect(action.description.when.length).toBeGreaterThan(30);
      expect(action.description.whenNot.length).toBeGreaterThan(30);
      expect(action.description.cost.length).toBeGreaterThan(20);
      expect(action.description.returns.length).toBeGreaterThan(20);
    });

    it('states cost in concrete terms', () => {
      // "what it costs" must mention a real resource, not just say "cheap".
      expect(action.description.cost.toLowerCase()).toMatch(
        /network|disk|byte|context|second|millisecond|linear|constant|money|read|write|kb/,
      );
    });

    it('offers an alternative in whenNot rather than only prohibiting', () => {
      expect(action.description.whenNot.toLowerCase()).toMatch(
        /instead|use |call |prefer|need|pass |skip|not a substitute|for /,
      );
    });

    it('has a dry run if and only if it mutates state', () => {
      if (action.sideEffect === 'read') expect(action.dryRun).toBeUndefined();
      else expect(action.dryRun, `${action.name} mutates but has no dryRun`).toBeTypeOf('function');
    });

    it('has a stable dotted or bare name', () => {
      expect(action.name).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$/);
    });

    it('declares aliases that resolve to real input fields', () => {
      // An alias pointing at a nonexistent field would be silently dropped,
      // reintroducing the class of bug that made --dry-run fail open.
      const def = (action.input as unknown as { def?: { shape?: Record<string, unknown> } }).def;
      const fields = new Set(Object.keys(def?.shape ?? {}));
      for (const [alias, canonical] of Object.entries(action.aliases ?? {})) {
        expect(fields.has(canonical), `${action.name}: alias --${alias} -> '${canonical}' is not an input field`).toBe(true);
      }
    });
  });
});

describe('discovery manifest', () => {
  const manifest = buildManifest();

  it('exposes exactly the registry action set -- surfaces cannot drift', () => {
    const names = (manifest.actions as Array<{ name: string }>).map((a) => a.name);
    expect(names).toEqual(actionNames());
  });

  it('renders a real JSON Schema for every action input and output', () => {
    for (const a of manifest.actions as Array<Record<string, unknown>>) {
      expect(a.input_schema, `${String(a.name)} input`).toBeTruthy();
      expect(a.output_schema, `${String(a.name)} output`).toBeTruthy();
      expect(JSON.stringify(a.input_schema)).not.toContain('could not be rendered');
      expect(JSON.stringify(a.output_schema)).not.toContain('could not be rendered');
    }
  });

  it('documents every error code the code can emit', () => {
    const codes = (manifest.errors as { codes: string[] }).codes;
    expect(codes).toContain('NO_KEYPAIR');
    expect(codes).toContain('AGENT_KEY_MISMATCH');
    expect(codes).toContain('CHAIN_CONFLICT');
  });

  it('carries a literal quickstart from nothing to a verified receipt', () => {
    const qs = manifest.quickstart as Array<{ step: number; action: string; cli: string }>;
    expect(qs.length).toBeGreaterThanOrEqual(4);
    expect(qs[0]!.action).toBe('init');
    expect(qs[qs.length - 1]!.action).toBe('chain.verify');
    // Every quickstart step must name a real action.
    for (const step of qs) expect(actionNames()).toContain(step.action);
  });

  it('states the standards it implements and the caveat on the draft', () => {
    const s = manifest.standards as Record<string, string>;
    expect(s.canonicalization).toContain('8785');
    expect(s.record_format_caveat).toMatch(/no formal IETF standing/i);
  });

  it('states its limitations, including that it makes nobody compliant', () => {
    const limits = (manifest.limitations as string[]).join(' ').toLowerCase();
    expect(limits).toContain('self-attested');
    expect(limits).toContain('not legal advice');
  });
});
