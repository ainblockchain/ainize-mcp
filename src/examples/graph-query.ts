import { Kind, parse, print, type FieldNode } from 'graphql';
import type { McpCallResult } from '../datasource.js';
import { getPath } from '../rows.js';

export function pinQuery(query: string, block: number): string {
  if (!Number.isSafeInteger(block) || block < 1) throw new Error('block must be a positive safe integer');
  const document = parse(query);
  if (document.definitions.length !== 1) throw new Error('Use one query without fragments');
  const operation = document.definitions[0];
  if (operation.kind !== Kind.OPERATION_DEFINITION || operation.operation !== 'query' || operation.variableDefinitions?.length) {
    throw new Error('Use one query with literal arguments and no variables');
  }
  const selections = operation.selectionSet.selections.map((selection): FieldNode => {
    if (selection.kind !== Kind.FIELD || selection.name.value.startsWith('__')) throw new Error('Root selections must be subgraph fields');
    return {
      ...selection,
      arguments: [
        ...(selection.arguments ?? []).filter((argument) => argument.name.value !== 'block'),
        { kind: Kind.ARGUMENT, name: { kind: Kind.NAME, value: 'block' }, value: {
          kind: Kind.OBJECT, fields: [{ kind: Kind.OBJECT_FIELD, name: { kind: Kind.NAME, value: 'number' }, value: { kind: Kind.INT, value: String(block) } }],
        } },
      ],
    };
  });
  if (!selections.some((selection) => selection.name.value === '_meta' && !selection.alias)) {
    throw new Error('Query must include unaliased _meta { block { number } }');
  }
  return print({ ...document, definitions: [{ ...operation, selectionSet: { ...operation.selectionSet, selections } }] });
}

export function assertGraphResult(result: McpCallResult, expectedBlock?: number): number {
  if (result.isError || getPath(result.json, 'errors')) throw new Error(`Graph query failed: ${result.text.slice(0, 400)}`);
  const block = getPath(result.json, 'data._meta.block.number');
  if (!Number.isSafeInteger(block) || Number(block) < 1) throw new Error('Graph response has no valid _meta.block.number');
  if (expectedBlock !== undefined && block !== expectedBlock) throw new Error(`Graph returned block ${block}, expected ${expectedBlock}`);
  if (getPath(result.json, 'data._meta.hasIndexingErrors') === true) throw new Error('Subgraph reports indexing errors');
  return Number(block);
}
