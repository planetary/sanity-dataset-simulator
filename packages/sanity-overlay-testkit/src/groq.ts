import {evaluate, parse} from 'groq-js'
import type {FixtureDocument} from './fixtures'

/**
 * Evaluate a GROQ query over an in-memory dataset via pinned groq-js.
 * This is the oracle side of the §35.10 parity method: no candidate
 * planning, whole dataset visible.
 */
export async function runGroq<T = unknown>(
  query: string,
  dataset: FixtureDocument[],
  params: Record<string, unknown> = {},
): Promise<T> {
  const tree = parse(query)
  const value = await evaluate(tree, {dataset, params})
  return (await value.get()) as T
}
