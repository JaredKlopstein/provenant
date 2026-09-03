/**
 * Design law 2: ONE typed action registry; CLI, HTTP and MCP are generated from
 * it. Every capability is defined exactly once -- name, description, input
 * schema, output schema, handler, side-effect class -- and the surfaces are
 * adapters over this list. A test fails the build if the surfaces ever expose
 * different action sets.
 */
import type { ActionDef } from './types.js';

const registry = new Map<string, ActionDef<never, never>>();

export function defineAction<I, O>(def: ActionDef<I, O>): ActionDef<I, O> {
  if (registry.has(def.name)) {
    throw new Error(`duplicate action name: ${def.name}`);
  }
  if (def.sideEffect !== 'read' && !def.dryRun) {
    // Design law 7. A mutation without a dry-run is not shippable: an agent
    // must always be able to ask "what would this do" before doing it.
    throw new Error(`action '${def.name}' mutates state but defines no dryRun`);
  }
  registry.set(def.name, def as unknown as ActionDef<never, never>);
  return def;
}

export function getAction(name: string): ActionDef<never, never> | undefined {
  return registry.get(name);
}

export function allActions(): ActionDef<never, never>[] {
  return [...registry.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function actionNames(): string[] {
  return allActions().map((a) => a.name);
}
