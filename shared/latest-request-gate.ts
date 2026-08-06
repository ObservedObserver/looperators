export type LatestRequestToken<Key> = {
  key: Key
  generation: number
}

export function createLatestRequestGate<Key>() {
  const generations = new Map<Key, number>()
  return {
    begin(key: Key): LatestRequestToken<Key> {
      const generation = (generations.get(key) ?? 0) + 1
      generations.set(key, generation)
      return { key, generation }
    },
    isCurrent(token: LatestRequestToken<Key>) {
      return generations.get(token.key) === token.generation
    },
  }
}
